/**
 * Shared test fixtures — deterministic save payloads built from the *shipped* content files and
 * validated by the *same* `validateSave` the runtime uses (doc 23 §5). Used by the Playwright
 * specs (W1-03…W1-05) and by the jsdom DOM tests (W1-02).
 *
 * Why fixtures instead of scripted combat clicks: every attack consumes three RNG draws from
 * the persisted `rngState`, and the hit roll is clamped to at most 95%, so no click sequence
 * can guarantee an outcome. W1-03's contract therefore asks for a battle that is *determined by
 * the save seed*. `lethalShotSeed()` searches for the `rngState` whose next draw triple makes
 * one torso shot a confirmed kill, using the real `performCombatAttack`; the specs then drive
 * that shot through the real UI.
 *
 * Nothing here duplicates game rules: campaign progress shapes, unit hydration, equipment
 * linkage and validation all come from `src/game/*`. A malformed fixture throws at build time
 * with the validator's own issue list instead of failing later as a confusing UI assertion.
 */
import {
  AP_PER_TURN,
  cellKey,
  defensiveCover,
  hasLineOfSight,
  isAlive,
  performCombatAttack,
  runEnemyTurn,
  type BodyPart,
  type Unit,
} from "../game/combat";
import type { ArenaConfig } from "../game/content";
import { hydrateArenaUnits, syncEquipmentInstances } from "../game/equipment-content";
import { createInventory } from "../game/inventory";
import { nextRandom } from "../game/rng";
import type { CampaignState, MissionProgress, MissionStatus } from "../game/campaign";
import { defaultSave, validateSave, type SaveData } from "../game/save";
import type { ShippedContent } from "./campaign-content-fixtures";

export {
  loadShippedContent,
  readShippedConfig,
  shippedCampaignCatalog,
  type ShippedContent,
} from "./campaign-content-fixtures";

/** Screens a fixture may target. */
export type FixtureScreen = CampaignState["screen"];

export interface EncounterPlan {
  status: MissionStatus;
  victories?: number;
  firstRewardClaimed?: boolean;
}

export interface SaveFixtureOptions {
  /** Encounter the fixture is positioned on. Defaults to the first catalog encounter. */
  encounterId?: string;
  screen: FixtureScreen;
  /** Per-encounter progress overrides, keyed by encounter id. Unlisted ids keep plan defaults. */
  encounters?: Record<string, EncounterPlan>;
  /** Reward ids already claimed. Defaults to the claims implied by the encounter plan. */
  claimedRewards?: string[];
  xp?: number;
  turn?: number;
  rngState?: number;
  /** Absolute hero cell. Defaults to the arena template position. */
  heroAt?: { x: number; y: number };
  heroHp?: number;
  heroAp?: number;
  /** Enemy HP overrides keyed by unit id. */
  enemyHp?: Record<string, number>;
  /** Weapon magazine/reserve override, for the ammo-starved retreat case. */
  heroAmmo?: { magazine: number; reserveAmmo: number };
  zoneStatus?: "available" | "completed";
  firstDeathReturnUsed?: boolean;
  /** Stash resources, so reward assertions can start from a known baseline. */
  stashMetal?: number;
}

export interface SaveFixture {
  save: SaveData;
  arena: ArenaConfig;
  encounterId: string;
  rewardId: string;
  /** Serialized payload ready for `seedRawSave`. */
  raw: string;
}

const PHASE_FOR_SCREEN = {
  home: "player",
  "mission-select": "player",
  mission: "player",
  reward: "victory",
  return: "defeat",
} as const satisfies Record<FixtureScreen, SaveData["phase"]>;

/** Mirrors `App`'s `initialUnits` for a first-entry snapshot of an arena. */
const templateUnits = (arena: ArenaConfig, content: ShippedContent, inventory: SaveData["inventory"]): Unit[] =>
  hydrateArenaUnits({ units: arena.units.map((unit) => ({ ...unit, ap: 0 })) }, content.equipment, inventory, []).map(
    (unit) => ({
      ...unit,
      ap: unit.team === "player" ? AP_PER_TURN : 0,
      posture: unit.posture ?? "stand",
      statuses: unit.statuses ?? {},
    }),
  );

const progressFor = (content: ShippedContent, encounterId: string, plan: EncounterPlan): MissionProgress => {
  const mission = content.missions.find((entry) => entry.id === encounterId);
  if (!mission) throw new Error(`unknown encounter id in fixture plan: ${encounterId}`);
  return {
    id: mission.id,
    status: plan.status,
    victories: plan.victories ?? (plan.status === "completed" ? 1 : 0),
    firstRewardClaimed: plan.firstRewardClaimed ?? false,
    mapId: mission.arenaId,
    arenaId: mission.arenaId,
    rewardId: mission.rewardId,
  };
};

/** Encounters ordered by catalog `order`, which is the sequence the validator enforces. */
export const orderedEncounters = (content: ShippedContent) =>
  [...content.missions].sort((left, right) => left.order - right.order);

/**
 * Default per-encounter statuses for a linear zone: everything before `index` completed and
 * claimed, `index` itself available, everything after locked. This is the shape the runtime
 * produces naturally, so a fixture stays inside the validator's ordering rules.
 */
function defaultPlan(content: ShippedContent, encounterId: string): Record<string, EncounterPlan> {
  const ordered = orderedEncounters(content);
  const index = ordered.findIndex((mission) => mission.id === encounterId);
  if (index < 0) throw new Error(`unknown encounter id: ${encounterId}`);
  return Object.fromEntries(
    ordered.map((mission, position) => [
      mission.id,
      position < index
        ? { status: "completed" as const, victories: 1, firstRewardClaimed: true }
        : position === index
          ? { status: "available" as const }
          : { status: "locked" as const },
    ]),
  );
}

/** Rewards implied by the plan: every completed+claimed encounter contributed its reward. */
const impliedClaims = (content: ShippedContent, plan: Record<string, EncounterPlan>) =>
  content.missions.filter((mission) => plan[mission.id]?.firstRewardClaimed).map((mission) => mission.rewardId);

/** XP implied by the claimed rewards, taken from the shipped reward catalog. */
export const xpForRewards = (content: ShippedContent, claimed: readonly string[]) =>
  content.rewards.filter((reward) => claimed.includes(reward.id)).reduce((sum, reward) => sum + reward.xp, 0);

/**
 * Builds and validates a save. Throws the validator's message when a fixture is impossible,
 * which is the point: the fixture layer cannot drift away from the runtime save contract.
 */
export function buildSave(content: ShippedContent, options: SaveFixtureOptions): SaveFixture {
  const ordered = orderedEncounters(content);
  const encounterId = options.encounterId ?? ordered[0].id;
  const mission = content.missions.find((entry) => entry.id === encounterId);
  if (!mission) throw new Error(`unknown encounter id: ${encounterId}`);
  const arena = content.arenas.byId.get(mission.arenaId);
  if (!arena) throw new Error(`arena missing for encounter ${encounterId}: ${mission.arenaId}`);

  const plan = { ...defaultPlan(content, encounterId), ...(options.encounters ?? {}) };
  const activeScreen = options.screen === "mission" || options.screen === "reward" || options.screen === "return";
  /* An active screen owns the encounter status: the validator ties screen and status together. */
  if (activeScreen)
    plan[encounterId] = {
      ...plan[encounterId],
      status: options.screen === "mission" ? "active" : options.screen === "reward" ? "completed" : "failed",
      victories: plan[encounterId].victories ?? (options.screen === "reward" ? 1 : 0),
      firstRewardClaimed: plan[encounterId].firstRewardClaimed ?? false,
    };
  /* `missionVictory` unlocks the following encounter at the moment of victory, i.e. before the
     reward is claimed. A reward-screen fixture that left the next encounter locked would describe
     a state the runtime never produces, and a spec built on it would assert the wrong unlock
     moment. Mirrored here rather than reimplemented: the caller can still override explicitly. */
  if (options.screen === "reward") {
    const next = ordered[ordered.findIndex((entry) => entry.id === encounterId) + 1];
    if (next && plan[next.id].status === "locked" && !options.encounters?.[next.id])
      plan[next.id] = { status: "available" };
  }

  const claimedRewards = options.claimedRewards ?? impliedClaims(content, plan);
  const seed = defaultSave(
    arena.id,
    templateUnits(arena, content, createInventory(20, [])),
    content.campaignCatalog,
    undefined,
    content.equipment,
  );

  const units = templateUnits(arena, content, seed.inventory).map((unit) => {
    if (unit.id === "hero") {
      const weaponState =
        options.heroAmmo && unit.weaponState
          ? { ...unit.weaponState, magazine: options.heroAmmo.magazine, reserveAmmo: options.heroAmmo.reserveAmmo }
          : unit.weaponState;
      return {
        ...unit,
        ...(options.heroAt ?? {}),
        hp: options.heroHp ?? unit.hp,
        ap: options.heroAp ?? unit.ap,
        ...(weaponState ? { weaponState } : {}),
      };
    }
    const hp = options.enemyHp?.[unit.id];
    return hp === undefined ? unit : { ...unit, hp };
  });

  const encounters = ordered.map((entry) => progressFor(content, entry.id, plan[entry.id]));
  const current = encounters.find((entry) => entry.id === encounterId)!;
  const zoneStatus =
    options.zoneStatus ?? (encounters.every((entry) => entry.status === "completed") ? "completed" : "available");
  const campaign: CampaignState = {
    catalogId: content.arenas.catalogId,
    screen: options.screen,
    activeMissionId: activeScreen ? encounterId : null,
    activeMapId: activeScreen ? mission.arenaId : null,
    mission: current,
    encounters,
    zone: { id: mission.zoneId, status: zoneStatus },
    firstDeathReturnUsed: options.firstDeathReturnUsed ?? false,
    xp: options.xp ?? xpForRewards(content, claimedRewards),
    claimedRewards: [...claimedRewards],
  };

  const stashMetal = options.stashMetal ?? 0;
  const inventory = syncEquipmentInstances(
    {
      ...seed.inventory,
      stash: {
        ...seed.inventory.stash,
        resources: stashMetal > 0 ? [{ id: "metal" as const, quantity: stashMetal, weight: 1 }] : [],
      },
    },
    units,
  );

  const save: SaveData = {
    schemaVersion: 4,
    arenaId: arena.id,
    activeEncounterId: activeScreen ? encounterId : null,
    phase: PHASE_FOR_SCREEN[options.screen],
    turn: options.turn ?? 1,
    rngState: options.rngState ?? seed.rngState,
    units,
    campaign,
    inventory,
    base: seed.base,
  };

  const checked = validateSave(save, content.campaignCatalog);
  if (!checked.ok)
    throw new Error(
      `fixture rejected by the runtime validator (${options.screen}/${encounterId}): ${checked.error.message}`,
    );
  return { save: checked.value, arena, encounterId, rewardId: mission.rewardId, raw: JSON.stringify(checked.value) };
}

/**
 * Smallest `rngState` for which one shot from `heroId` at `targetId` is a confirmed kill: no
 * malfunction, a hit, and the target reduced to 0 HP. Uses the runtime attack resolver and the
 * runtime RNG, so the seed cannot silently stop being lethal after a balance change — the
 * search simply fails and the spec reports it instead of asserting a stale number.
 */
export function lethalShotSeed(
  arena: ArenaConfig,
  units: readonly Unit[],
  heroId: string,
  targetId: string,
  part: BodyPart = "torso",
  limit = 20_000,
): number {
  const hero = units.find((unit) => unit.id === heroId);
  const target = units.find((unit) => unit.id === targetId);
  if (!hero || !target) throw new Error(`lethalShotSeed: missing ${heroId} or ${targetId}`);
  const cover = arena.cover.map((entry) => ({ ...entry, kind: entry.type }));
  const blockers = new Set([
    ...cover.filter((entry) => entry.kind === "full").map((entry) => cellKey(entry.x, entry.y)),
    ...units
      .filter((unit) => isAlive(unit) && unit.id !== hero.id && unit.id !== target.id)
      .map((unit) => cellKey(unit.x, unit.y)),
  ]);
  if (!hasLineOfSight(hero, target, blockers))
    throw new Error(`lethalShotSeed: no line of sight from ${heroId}@${hero.x},${hero.y} to ${targetId}`);

  for (let seed = 1; seed <= limit; seed += 1) {
    let state = seed;
    const roll = () => {
      const next = nextRandom(state);
      state = next.state;
      return next.value;
    };
    const action = performCombatAttack(hero, target, part, defensiveCover(hero, target, cover), {
      malfunction: roll(),
      hit: roll(),
      crit: roll(),
    });
    if (action.ok && !action.malfunctioned && action.resolution?.hit && action.target.hp === 0) return seed;
  }
  throw new Error(`lethalShotSeed: no seed below ${limit} kills ${targetId} in one ${part} shot`);
}

/**
 * A mission fixture whose very next player shot kills `targetId`. Built in two passes because
 * the seed search needs the hydrated units, which only exist after a first build.
 */
export function buildLethalShotFixture(
  content: ShippedContent,
  options: SaveFixtureOptions & { targetId: string; part?: BodyPart },
): SaveFixture & { seed: number; targetId: string } {
  const staged = buildSave(content, options);
  const seed = lethalShotSeed(staged.arena, staged.save.units, "hero", options.targetId, options.part ?? "torso");
  const fixture = buildSave(content, { ...options, rngState: seed });
  return { ...fixture, seed, targetId: options.targetId };
}

/**
 * Smallest `rngState` for which the *enemy* turn kills the hero outright, evaluated with the
 * runtime `runEnemyTurn`. The mirror image of `lethalShotSeed`: it makes the defeat path in
 * W1-03's failure spec deterministic instead of hoping a weakened hero happens to die.
 */
export function heroDefeatSeed(arena: ArenaConfig, units: readonly Unit[], limit = 20_000): number {
  const cover = arena.cover.map((entry) => ({ ...entry, kind: entry.type }));
  for (let seed = 1; seed <= limit; seed += 1) {
    let state = seed;
    const roll = () => {
      const next = nextRandom(state);
      state = next.state;
      return next.value;
    };
    const result = runEnemyTurn(
      units.map((unit) => ({ ...unit })),
      arena.width,
      arena.height,
      cover,
      roll,
    );
    if (result.heroDefeated) return seed;
  }
  throw new Error(`heroDefeatSeed: no seed below ${limit} defeats the hero on the enemy turn`);
}

/** A mission fixture whose next enemy turn defeats the hero. Two passes, like the lethal shot. */
export function buildDefeatFixture(
  content: ShippedContent,
  options: SaveFixtureOptions,
): SaveFixture & { seed: number } {
  const staged = buildSave(content, options);
  const seed = heroDefeatSeed(staged.arena, staged.save.units);
  return { ...buildSave(content, { ...options, rngState: seed }), seed };
}
