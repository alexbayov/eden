/**
 * Balance bounds for W3-05 — the proposed balance lock v1 expressed as machine-checkable
 * invariants.
 *
 * This module holds **numbers that are decisions** (corridors approved in `W3-04`) and the
 * evaluator that compares a simulation report against them. It deliberately holds no formula: the
 * measured side of every comparison comes from `SimulationReport`, which `metrics.ts`/`report.ts`
 * produced out of battles `game/combat.ts` resolved, and the lethality side comes from the shipped
 * `calculateDamage`. Restating a hit or damage rule here would make the bounds agree with a copy of
 * the game rather than with the game (`W3-01` acceptance criterion 3).
 *
 * ## Why an evaluator object instead of bare `expect` calls
 *
 * `W3-05` acceptance criterion 2 requires every bound to be *shown* to fail when the invariant is
 * violated, and criterion 4 requires the failure message to name the invariant. Both are properties
 * of a function, not of an assertion: `evaluateBalanceBounds` can be handed a deliberately mutated
 * report in a test and asked to prove it complains, which is impossible if the corridor lives inside
 * an `expect` in a test body. The corridors therefore exist exactly once, here, and both the live
 * check and the negative check read them from the same place.
 *
 * ## Corridors, not snapshots
 *
 * A bound is an interval with a stated reason, never a pinned measurement. `winRate: 0.855` as an
 * expectation would have to be edited by whoever next tunes a number, which turns an intentional
 * balance change into a failure that reads like a regression (the reasoning is spelled out in
 * docs/22 §`W3-01`). An interval fails only when the game leaves the range the owner approved.
 *
 * A corridor has an upper bound as well as a lower one on purpose: an encounter that is won 99% of
 * the time is as much a balance defect as one won 20% of the time, and only the lower half of the
 * range would catch the second.
 */
import { REPAIR_MATERIAL } from '../game/base'
import { calculateDamage, type BodyPart, type Unit } from '../game/combat'
import type { SimulationReport } from './report'

export interface Corridor {
  readonly min: number
  readonly max: number
}

/**
 * Per-encounter win-rate corridors for the `cover-torso` policy in `chain` mode, proposed as
 * balance lock v1 in docs/12.
 *
 * Keyed by encounter id rather than arena id because the corridor is a statement about a step of
 * the campaign, and a future encounter that reuses a map would need its own corridor. An encounter
 * absent from this table is itself a violation (see `evaluateBalanceBounds`), so adding content
 * cannot silently escape the bounds.
 */
export const WIN_RATE_CORRIDORS: Readonly<Record<string, Corridor>> = {
  /* Opening encounter: must be winnable by a first-time player, but not free. */
  'perimeter-checkpoint': { min: 0.8, max: 0.95 },
  /* One rusher, more cover: slightly wider floor because the enemy closes distance. */
  'collapsed-yard': { min: 0.75, max: 0.95 },
  /* Two enemies, one of them armoured, fought on carried HP/ammo: the zone's difficulty peak. */
  'relay-station': { min: 0.55, max: 0.85 },
}

/**
 * The corridor for `report.total.winRate` in `chain` mode — every battle of every encounter of every
 * pass, pooled.
 *
 * This is **not** the probability of completing all three encounters in one pass. That number is
 * lower (it is the product of the per-encounter rates, ≈0.48 on the measured data) and it is
 * deliberately not bounded by v1: the owner has not decided what fraction of passes should clear the
 * zone without a base visit, and bounding it now would lock an accident. `zonePassCompletionRate`
 * below computes it so the reports can carry it as a finding.
 */
export const CHAIN_TOTAL_WIN_CORRIDOR: Corridor = { min: 0.55, max: 0.85 }

/**
 * Ceiling on `ammoEmptyRate`. A battle ends `ammo-empty` when the hero has no round chambered, no
 * reserve and nothing to unjam: the game's only exit is a retreat with no reward, so it is a
 * soft-lock, not a defeat. v1 treats it as an accident that may happen but must not be a strategy —
 * hence a low ceiling rather than zero.
 */
export const MAX_AMMO_EMPTY_RATE = 0.05

/**
 * A pass must not consume more bandages than it can supply (reward bandages plus what its net cloth
 * crafts into), and must not cost more `metal` in repairs than it awards. Both are floors at zero:
 * v1 requires the zone to be self-sustaining, not profitable.
 */
export const MIN_BANDAGE_BALANCE_PER_PASS = 0
export const MIN_METAL_BALANCE_PER_PASS = 0

/**
 * The body part every enemy attack in the shipped game uses. `runEnemyTurn` hard-codes `'torso'` for
 * both the AI's attack and the overwatch reaction, so a lethality bound over other parts would
 * measure damage the game cannot currently inflict. Named rather than inlined so that a future AI
 * that aims elsewhere makes this constant obviously wrong instead of quietly narrowing the bound.
 */
export const ENEMY_ATTACK_PART: BodyPart = 'torso'

export interface BoundViolation {
  /** Stable identifier of the invariant, usable as a waiver key. */
  bound: string
  /** Human-readable statement of what was measured and what was required. */
  message: string
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`

const corridorViolation = (bound: string, label: string, value: number, corridor: Corridor): BoundViolation | null =>
  value >= corridor.min && value <= corridor.max
    ? null
    : {
        bound,
        message: `${label}: ${pct(value)} вне коридора ${pct(corridor.min)}..${pct(corridor.max)} (balance lock v1).`,
      }

const ceilingViolation = (bound: string, label: string, value: number, ceiling: number): BoundViolation | null =>
  value <= ceiling ? null : { bound, message: `${label}: ${pct(value)} превышает потолок ${pct(ceiling)} (balance lock v1).` }

const floorViolation = (bound: string, label: string, value: number, floor: number): BoundViolation | null =>
  value >= floor ? null : { bound, message: `${label}: ${value.toFixed(4)} ниже минимума ${floor.toFixed(4)} (balance lock v1).` }

/**
 * Fraction of chain passes that cleared every encounter, derived from the report alone.
 *
 * In `chain` mode a pass stops at the first non-win, so the number of results recorded for the first
 * encounter is the number of passes started, and the wins recorded for the last encounter are the
 * passes that finished. Reported as a finding; see `CHAIN_TOTAL_WIN_CORRIDOR` for why v1 does not
 * bound it.
 */
export function zonePassCompletionRate(report: SimulationReport): number {
  const first = report.arenas[0]
  const last = report.arenas.at(-1)
  if (!first || !last || first.metrics.runs === 0) return 0
  return (last.metrics.winRate * last.metrics.runs) / first.metrics.runs
}

/**
 * Every balance-lock-v1 bound a simulation report can answer, as a list of violations. An empty list
 * is the passing state; each entry names the invariant and the measurement that broke it.
 */
export function evaluateBalanceBounds(report: SimulationReport): BoundViolation[] {
  const violations: (BoundViolation | null)[] = []

  for (const arena of report.arenas) {
    const corridor = WIN_RATE_CORRIDORS[arena.encounterId]
    if (!corridor) {
      /* New content must be given a corridor rather than inheriting "unbounded". */
      violations.push({
        bound: `win-rate:${arena.encounterId}`,
        message: `Encounter ${arena.encounterId} не имеет коридора win rate в balance lock v1: добавьте его в WIN_RATE_CORRIDORS.`,
      })
      continue
    }
    violations.push(corridorViolation(`win-rate:${arena.encounterId}`, `win rate ${arena.encounterId}`, arena.metrics.winRate, corridor))
    violations.push(
      ceilingViolation(`ammo-empty:${arena.encounterId}`, `доля проходов без патронов ${arena.encounterId}`, arena.metrics.ammoEmptyRate, MAX_AMMO_EMPTY_RATE),
    )
  }

  violations.push(corridorViolation('win-rate:total', 'суммарный win rate прохода', report.total.winRate, CHAIN_TOTAL_WIN_CORRIDOR))
  violations.push(ceilingViolation('ammo-empty:total', 'суммарная доля боёв без патронов', report.total.ammoEmptyRate, MAX_AMMO_EMPTY_RATE))
  violations.push(
    floorViolation('economy:bandage-balance', 'баланс бинтов за проход', report.economy.bandageBalancePerPassMean, MIN_BANDAGE_BALANCE_PER_PASS),
  )
  const metal = report.economy.resources.find((flow) => flow.resource === REPAIR_MATERIAL)
  violations.push(
    floorViolation(
      `economy:${REPAIR_MATERIAL}-balance`,
      `нетто ${REPAIR_MATERIAL} за проход`,
      /* Absent flow means the reward catalog grants none and repairs cost none: a zero balance. */
      metal?.net ?? 0,
      MIN_METAL_BALANCE_PER_PASS,
    ),
  )

  return violations.filter((entry): entry is BoundViolation => entry !== null)
}

/** One "what is the worst a single enemy hit can do" data point, priced by the shipped rules. */
export interface LethalityCase {
  arenaId: string
  enemyId: string
  archetypeId: string
  critical: boolean
  damage: number
  heroMaxHp: number
}

/**
 * The damage each enemy of `units` deals to the hero of `units` with one torso hit, critical and
 * not, at the mission-start state the arena ships (full armour durability).
 *
 * `calculateDamage` is the shipped function, so ammo modifiers, part multipliers, the critical
 * multiplier and armour penetration are the game's. Mission-start armour rather than a worn or
 * destroyed vest: this is a bound on the arena **as shipped**, and a depleted vest is a separate,
 * strictly worse case recorded in docs/12 as a finding.
 */
export function worstCaseEnemyHits(arenaId: string, units: readonly Unit[]): LethalityCase[] {
  const hero = units.find((unit) => unit.id === 'hero')
  if (!hero) return []
  return units
    .filter((unit) => unit.team === 'enemy')
    .flatMap((enemy) =>
      [false, true].map((critical) => ({
        arenaId,
        enemyId: enemy.id,
        archetypeId: enemy.archetypeId ?? enemy.id,
        critical,
        damage: calculateDamage(enemy, hero, ENEMY_ATTACK_PART, critical),
        heroMaxHp: hero.maxHp,
      })),
    )
    .sort((left, right) => left.enemyId.localeCompare(right.enemyId) || Number(left.critical) - Number(right.critical))
}

/**
 * The v1 lethality bound: no single enemy hit may reach the hero's maximum HP, i.e. a hero at full
 * health is never removed from the encounter by one roll.
 *
 * `>=` rather than `>`: damage equal to max HP kills, because `hp - damage` clamps at 0 and
 * `isAlive` is `hp > 0`.
 */
export function evaluateLethalityBounds(cases: readonly LethalityCase[]): BoundViolation[] {
  return cases
    .filter((entry) => entry.damage >= entry.heroMaxHp)
    .map((entry) => ({
      bound: `one-shot:${entry.arenaId}:${entry.enemyId}:${entry.critical ? 'critical' : 'plain'}`,
      message: `${entry.archetypeId} в ${entry.arenaId} наносит ${entry.damage} урона одним ${entry.critical ? 'критическим ' : ''}попаданием в ${ENEMY_ATTACK_PART} при maxHp героя ${entry.heroMaxHp}: убийство с одного выстрела.`,
    }))
}

/**
 * Lethality violations the owner has **not** yet resolved, waived so the suite reports the state of
 * the game honestly instead of asserting something false.
 *
 * These are real, reachable one-shot kills, not test artefacts: any 20-damage weapon (`pm`,
 * `hornet`) crits through the starter vest for `round(20 × 1.1 × 1.5) − 3 = 30` against a hero with
 * 24 max HP. Verified end to end through the shipped AI — `runEnemyTurn` on the shipped
 * `relay-station` with a roll stub that forces hit and crit kills a full-HP hero in one action.
 *
 * The waiver is checked for **exact** equality against the measured violations, so it cannot rot in
 * either direction: a new one-shot fails the suite, and fixing the data also fails the suite until
 * the corresponding line is deleted here. Closing them is a balance decision (hero max HP, vest
 * reduction, weapon damage or the critical multiplier) and therefore `W3-04`'s, not this ticket's.
 */
export const KNOWN_ONE_SHOT_WAIVERS: readonly string[] = [
  'one-shot:collapsed-yard:yard-rusher:critical',
  'one-shot:perimeter-checkpoint:checkpoint-shooter:critical',
  'one-shot:relay-station:relay-shooter:critical',
]
