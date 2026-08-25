/**
 * Mission-start save construction for the balance simulator (W3-01/W3-03).
 *
 * `simulateBattle` demands "a validated save whose units/inventory are already at mission start".
 * Producing one is not a matter of filling a struct: a v4 save is only valid if the campaign,
 * the encounter list, the claimed rewards, the active arena and every equipment link agree with
 * the runtime catalog (`validateSave` in `game/save.ts` enforces roughly forty of those rules).
 * So this module does not build a save — it *drives the game's own transitions* and then submits
 * the result to the runtime validator:
 *
 *   `defaultSave` -> `startMission` -> `missionVictory` -> `awardRewardTransition` -> ... ->
 *   `startMission` -> `createEncounterUnits` -> `syncEquipmentInstances` -> `validateSave`
 *
 * Nothing here decides progression rules, reward contents or unit hydration; every step is the
 * shipped function the app shell calls. A save this module produces and a save the running game
 * produces at the same point of the campaign are therefore the same object, which is the only
 * reason a measurement taken here says anything about the game.
 *
 * Two consequences worth naming:
 *
 *   - **Encounter *k* cannot be simulated without winning 1..k-1.** `validateSave` rejects an
 *     unlocked-out-of-order encounter, so "isolated" runs still walk the campaign forward with
 *     scripted victories and reward claims (`progressTo`). The gear stays pristine; only campaign
 *     bookkeeping and the stash advance.
 *   - **Nothing is refilled between encounters.** Ammo, weapon durability, armour durability and
 *     hero HP carry through `createEncounterUnits`/`syncEquipmentInstances` exactly as they do in
 *     the game, which is what makes `mode=chain` a measurement of attrition rather than of three
 *     unrelated fights.
 */
import type { Unit } from '../game/combat'
import type { ArenaConfig } from '../game/content'
import {
  missionDefeat,
  missionVictory,
  startMission,
  type CampaignMission,
  type CampaignState,
} from '../game/campaign'
import {
  characterForXp,
  resolveDefeatReturn,
  type CharacterState,
} from '../game/progression'
import { campaignMissionsOf } from '../game/campaign-catalog'
import type { MissionDefinition, RewardDefinition } from '../game/campaign-content'
import { createEncounterUnits } from '../game/encounter'
import { syncEquipmentInstances } from '../game/equipment-content'
import type { Inventory } from '../game/inventory'
import { initialObjectiveState } from '../game/objective'
import { DEFAULT_RNG_STATE } from '../game/rng'
import { awardRewardTransition } from '../game/rewards'
import { defaultSave, validateSave, SAVE_SCHEMA_VERSION, type SaveData } from '../game/save'
import type { BaseState } from '../game/base'
import type { SimulationContent } from './content-source'

/** Playable encounters in campaign order; ties broken by id so the sequence is total. */
export const orderedMissions = (content: SimulationContent): MissionDefinition[] =>
  [...content.missions].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

export const campaignMissionsFor = (content: SimulationContent): CampaignMission[] =>
  campaignMissionsOf(orderedMissions(content))

/**
 * Everything that survives an encounter. `units` carries the hero's HP, statuses and live weapon
 * state into the next `createEncounterUnits` call, which is how the game carries them.
 */
export interface CampaignProgress {
  campaign: CampaignState
  inventory: Inventory
  units: Unit[]
  base: BaseState
  /** Level/XP/unspent points, advanced by the same `awardRewardTransition` the game calls. */
  character: CharacterState
}

export interface MissionStart {
  mission: MissionDefinition
  arena: ArenaConfig
  /** Validated by `validateSave`; safe to hand to `simulateBattle`. */
  save: SaveData
  /** `progress` advanced to "mission started", i.e. what a defeat/victory must be applied to. */
  progress: CampaignProgress
}

const missionOf = (content: SimulationContent, missionId: string): MissionDefinition => {
  const mission = orderedMissions(content).find((entry) => entry.id === missionId)
  if (!mission) throw new Error(`Encounter ${missionId} отсутствует в каталоге кампании.`)
  return mission
}

const arenaOf = (content: SimulationContent, mission: MissionDefinition): ArenaConfig => {
  const arena = content.arenas.byId.get(mission.arenaId)
  if (!arena) throw new Error(`Карта ${mission.arenaId} отсутствует в arena-manifest.`)
  return arena
}

const rewardOf = (content: SimulationContent, mission: MissionDefinition): RewardDefinition => {
  const reward = content.rewards.find((entry) => entry.id === mission.rewardId)
  if (!reward) throw new Error(`Награда ${mission.rewardId} отсутствует в каталоге.`)
  return reward
}

/**
 * The campaign start state: `defaultSave` over the first encounter's arena, i.e. the same object
 * the app shell creates for a player with no local save.
 */
export function campaignStart(content: SimulationContent): CampaignProgress {
  const first = orderedMissions(content)[0]
  const save = defaultSave(
    first.arenaId,
    createEncounterUnits(arenaOf(content, first), content.equipment),
    content.campaignCatalog,
    undefined,
    content.equipment,
  )
  const validated = validateSave(save, content.campaignCatalog)
  if (!validated.ok) throw validated.error
  return { campaign: validated.value.campaign, inventory: validated.value.inventory, units: validated.value.units, base: validated.value.base, character: validated.value.character }
}

/** Applies a victory: campaign -> reward screen -> reward claimed -> home, gear state carried. */
export function resolveVictory(content: SimulationContent, progress: CampaignProgress, finalUnits: Unit[]): CampaignProgress {
  const missions = campaignMissionsFor(content)
  const rewarded = missionVictory(progress.campaign, missions)
  if (rewarded === progress.campaign) throw new Error('missionVictory отклонил победу: кампания не в активной миссии.')
  const mission = missionOf(content, rewarded.mission.id)
  const transition = awardRewardTransition(
    rewarded,
    syncEquipmentInstances(progress.inventory, finalUnits),
    rewardOf(content, mission),
    missions,
    progress.character,
    content.campaignCatalog.progression,
  )
  return { campaign: transition.campaign, inventory: transition.inventory, units: finalUnits, base: progress.base, character: transition.character }
}

/**
 * Applies a defeat or a retreat. Both are `missionDefeat` in the shipped rules (see
 * `retreatFromMission`), so the simulator does not invent a third outcome; the encounter is
 * `failed`, no reward is claimable and the hero returns to base.
 *
 * Exported because a chain pass that ends in defeat still has to leave the campaign in a state a
 * later `startMission` would accept: `failed` is retryable, `active` is not. The CLI stops the pass
 * at the first non-win, so this is the transition it applies when doing so.
 */
export function resolveDefeat(progress: CampaignProgress, finalUnits: Unit[], curve?: CharacterCurve): CampaignProgress {
  /* Since W4-02 a defeat also charges the XP penalty, through the game's own transition. */
  const resolved = resolveDefeatReturn(missionDefeat(progress.campaign), progress.character, curve)
  return {
    campaign: resolved.campaign,
    inventory: syncEquipmentInstances(progress.inventory, finalUnits),
    units: finalUnits,
    base: progress.base,
    character: resolved.character,
  }
}
type CharacterCurve = Parameters<typeof resolveDefeatReturn>[2]

/**
 * Builds the mission-start save for `missionId` and returns it together with the progress it was
 * built from. Throws the runtime `SaveValidationError` if the result is not a valid v4 save, so a
 * simulator that drifts out of the save contract fails loudly instead of measuring an
 * unreachable state.
 */
export function missionStart(content: SimulationContent, progress: CampaignProgress, missionId: string): MissionStart {
  const mission = missionOf(content, missionId)
  const arena = arenaOf(content, mission)
  const campaign = startMission(progress.campaign, mission.id, campaignMissionsFor(content))
  if (campaign === progress.campaign)
    throw new Error(`startMission отклонил ${mission.id}: encounter не available и не failed.`)
  const units = createEncounterUnits(arena, content.equipment, progress.inventory, progress.units)
  const inventory = syncEquipmentInstances(progress.inventory, units)
  const candidate: SaveData = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    arenaId: mission.arenaId,
    activeEncounterId: mission.id,
    phase: 'player',
    turn: 1,
    /* Replaced per battle by the derived seed; a valid save just needs an integer here. */
    rngState: DEFAULT_RNG_STATE,
    units,
    campaign,
    /* Progression mirrors the campaign XP the scripted victories accumulated (W4-05 §5.3). */
    character: characterForXp(campaign.xp, content.campaignCatalog.progression),
    inventory,
    base: progress.base,
    /* W6-01: a mission starts with no objective progress, exactly as `beginMission` does in the game. */
    objective: initialObjectiveState(),
  }
  const validated = validateSave(candidate, content.campaignCatalog)
  if (!validated.ok) throw validated.error
  return {
    mission,
    arena,
    save: validated.value,
    progress: { campaign, inventory, units, base: progress.base, character: validated.value.character },
  }
}

/**
 * Walks the campaign forward with scripted victories until `missionId` is available, without
 * touching gear: the units stay the campaign-start units. This is the "isolated" start state —
 * encounter *k* fought with encounter-1 equipment, which is the upper bound on hero condition and
 * the only start state that is comparable across arenas.
 */
export function progressTo(content: SimulationContent, missionId: string): CampaignProgress {
  const sequence = orderedMissions(content)
  const index = sequence.findIndex((entry) => entry.id === missionId)
  if (index < 0) throw new Error(`Encounter ${missionId} отсутствует в каталоге кампании.`)
  const start = campaignStart(content)
  let progress = start
  for (const mission of sequence.slice(0, index)) {
    const started = missionStart(content, progress, mission.id)
    /* Scripted, not simulated: the pristine campaign-start units are handed straight back. */
    progress = { ...resolveVictory(content, started.progress, start.units), units: start.units }
  }
  return progress
}
