import { advanceStatuses, runEnemyTurn, startTurn, type Unit } from './combat'
import { missionDefeat, missionVictory, type CampaignMission, type CampaignState } from './campaign'
import type { ArenaConfig } from './content'
import { advanceObjectiveTurn, evaluateObjective, initialObjectiveState, type ObjectiveParams } from './objective'
import { nextRandom } from './rng'
import type { SaveAdapter, SaveData } from './save'
import { syncEquipmentInstances } from './equipment-content'

/**
 * The active mission's objective, as much of it as the enemy phase needs.
 *
 * Deliberately not the whole `MissionDefinition`: this module resolves turns, and giving it a catalog
 * type would invite it to start reading rewards and arenas too.
 */
export interface ObjectiveResolution {
  params: ObjectiveParams
  turnLimit?: number
}

/**
 * Campaign missions reconstructed from the save's own encounter list.
 *
 * `missionVictory` needs the ordered mission list to unlock the next encounter, and the enemy phase has
 * no catalog. Reconstructing it from `campaign.encounters` is safe because the save validator has
 * already checked that list against the real catalog — the order, the ids and the reward links are the
 * catalog's, verified at load.
 */
const missionsOf = (campaign: CampaignState): CampaignMission[] =>
  campaign.encounters.map((entry, index) => ({
    id: entry.id,
    zoneId: campaign.zone.id,
    order: index + 1,
    rewardId: entry.rewardId,
    arenaId: entry.arenaId,
  }))

/**
 * W6-01 — resolves the enemy turn and then asks the objective whether the mission is over.
 *
 * The objective is evaluated **after** the new turn number is known, because two of the four types are
 * measured in turns: `secure` counts consecutive held turns, and `retrieve`/`escape` fail when their
 * deadline passes. Evaluating before the increment would credit or expire a turn early.
 *
 * `objective` is passed in rather than read off the mission catalog, because this module has no catalog
 * and should not grow one: the caller already knows which mission is active.
 */
export function resolveEnemyPhase(save: SaveData, arena: ArenaConfig, objective: ObjectiveResolution = { params: { kind: 'eliminate' } }): SaveData {
  // Enemy resolution is meaningful only for a persisted active mission snapshot. This also
  // protects callers outside React from an impossible home/mission-select enemy transition.
  if (save.phase !== 'enemy' || save.campaign.screen !== 'mission' || save.campaign.mission.status !== 'active') return save
 let rngState = save.rngState
 const roll = () => { const next = nextRandom(rngState); rngState = next.state; return next.value }
 const result = runEnemyTurn(save.units, arena.width, arena.height, arena.cover.map((cover) => ({ ...cover, kind: cover.type })), roll)
  const reconciledInventory = syncEquipmentInstances(save.inventory, result.units)
 if (result.heroDefeated) return { ...save, rngState, units: result.units, inventory: reconciledInventory, phase: 'defeat', campaign: missionDefeat(save.campaign), objective: initialObjectiveState() }
 const units: Unit[] = result.units.map((unit) => unit.id === 'hero' ? advanceStatuses(startTurn(unit)) : { ...unit, ap: 0 })
 const turn = save.turn + 1
 const inventory = syncEquipmentInstances(reconciledInventory, units)
 /* The turn boundary, and the only place the objective clock advances (see `advanceObjectiveTurn`).
    Measured after the enemy moved, which is what "held for a turn" honestly means. */
 const objectiveContext = { params: objective.params, state: save.objective, units, turn, turnLimit: objective.turnLimit }
 const advanced = advanceObjectiveTurn(objectiveContext)
 const evaluation = evaluateObjective({ ...objectiveContext, state: advanced })
 /* A hold that completed on the enemy's clock ends the mission here, not on the player's next action:
    the point was held for the required turns and waiting for a click would be a lie about when. */
 if (evaluation.outcome === 'complete')
   return { ...save, rngState, units, inventory, phase: 'victory', turn, campaign: missionVictory(save.campaign, missionsOf(save.campaign)), objective: initialObjectiveState() }
 /* A deadline that expired is the third outcome (W6-01 criterion 4): the hero is alive, nothing was
    lost in combat, and the encounter is `failed` and retryable. */
 if (evaluation.outcome === 'failed')
   return { ...save, rngState, units, inventory, phase: 'defeat', turn, campaign: missionDefeat(save.campaign), objective: initialObjectiveState() }
 return { ...save, rngState, units, inventory, phase: 'player', turn, objective: evaluation.state }
}
export function beginEnemyPhase(save: SaveData): SaveData | null {
  return save.campaign.screen === 'mission' && save.campaign.mission.status === 'active' && save.phase === "player"
    ? { ...save, activeEncounterId: save.campaign.activeMissionId, phase: "enemy" }
    : null;
}
export const canBeginTransition = (locked: boolean, phase: SaveData['phase'], screen: CampaignState['screen'] = 'mission') => !locked && screen === 'mission' && phase === 'player'
export const campaignForDefeat = (campaign: CampaignState) => missionDefeat(campaign)
export type PersistTransition = { ok: true; value: SaveData } | { ok: false; error: string }
export function persistTransition(adapter: SaveAdapter, next: SaveData): PersistTransition {
 const result = adapter.saveDetailed(next)
 return result.ok ? { ok: true, value: next } : { ok: false, error: result.error ?? "unknown save failure" }
}
export function persistEnemyPhase(adapter: SaveAdapter, save: SaveData): SaveData | null { const enemy = beginEnemyPhase(save); return enemy && persistTransition(adapter, enemy).ok ? enemy : null }
export function resumePersistedEnemyPhase(adapter: SaveAdapter, save: SaveData, arena: ArenaConfig, objective?: ObjectiveResolution): SaveData | null { if (save.phase !== 'enemy') return save; const resolved = resolveEnemyPhase(save, arena, objective); return persistTransition(adapter, resolved).ok ? resolved : null }

export interface EnemyPhaseCoordinator { begin: () => boolean; resolve: () => SaveData | null }
/** Application-level pure orchestration: persist the exact enemy snapshot before any timer is scheduled. */
export function createEnemyPhaseCoordinator(current: SaveData, adapter: SaveAdapter, schedule: (callback: () => void) => void, arena: ArenaConfig, onResolved: (save: SaveData) => void, objective?: ObjectiveResolution): EnemyPhaseCoordinator {
 let locked = false
 let snapshot: SaveData | null = null
 const resolve = () => {
  if (!snapshot) return null
  const resolved = resolveEnemyPhase(snapshot, arena, objective)
  if (!persistTransition(adapter, resolved).ok) return null
  snapshot = null
  locked = false
  onResolved(resolved)
  return resolved
 }
 return {
  begin() {
   if (!canBeginTransition(locked, current.phase)) return false
   const enemy = beginEnemyPhase(current)
   if (!enemy || !persistTransition(adapter, enemy).ok) return false
   locked = true; snapshot = enemy; schedule(resolve); return true
  },
  resolve,
 }
}
