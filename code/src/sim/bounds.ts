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
  /*
   * Zone two, «Водовод» (D-03). Measured at 1000 chain passes, `cover-torso`, seed 12345, with the between-encounter
   * ammunition restock the game offers (`--restock`): 65.8 / 51.9 / 71.2.
   *
   * The corridors are wider than zone one's on the low side, because these encounters are fought on whatever the
   * previous five left: the hero reaches the last one with a median of 11 rounds out of 21. They are not centred on
   * the measurement — a corridor that hugged the number would fail on any deliberate retune — but they do exclude
   * both a free encounter and an unwinnable one.
   */
  /* First `retrieve` in the game: won by carrying the canister out, so the floor is about surviving the walk. */
  'water-cache': { min: 0.5, max: 0.85 },
  /* `escape` under pursuit, and the hardest step of the zone as measured; deliberately allowed to be a coin flip. */
  'filter-works': { min: 0.4, max: 0.75 },
  /* Zone finale: a contested hold against a single defender, after five encounters of attrition. */
  'pumping-station': { min: 0.55, max: 0.85 },
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
 * W6-05 criterion 4 — the corridor the *measured* jam rate has to fall in.
 *
 * `malfunctionOccurs` jams at **15%** per shot for a `makeshift` weapon and **8%** for one below 30% durability.
 * Nothing checked that: `grep malfunction src/sim/bounds.ts` returned nothing before this ticket, so the two
 * documented numbers rested entirely on reading the code.
 *
 * Centred on 15% rather than a blend of the two, because the shipped hero carries the makeshift `hornet` for the
 * whole zone and `malfunctionEligible` short-circuits on `makeshift` — so essentially every recorded shot is
 * drawn from the 15% branch. The width is sampling tolerance, not a design range: at ~2600 shots per chain run
 * the standard error is well under a point, and ±4 points leaves room for the durability branch contributing a
 * few 8% shots late in a pass without turning the bound into a rubber stamp.
 *
 * A rate outside this corridor means one of three things, all worth failing for: the constants changed, the
 * eligibility rule changed, or the shipped loadout stopped being makeshift.
 */
export const MALFUNCTION_RATE_CORRIDOR: Corridor = { min: 0.11, max: 0.19 }

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
  /* W6-05 criterion 4: the jam rate the simulator actually observes, against the documented 15%/8%. */
  violations.push(
    corridorViolation(
      'malfunction-rate:total',
      'частота осечек на выстрел',
      report.total.malfunctionRate,
      MALFUNCTION_RATE_CORRIDOR,
    ),
  )
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
 * The lethality bound: no single enemy hit may reach the hero's maximum HP.
 *
 * `>=` rather than `>`: damage equal to max HP kills, because `hp - damage` clamps at 0 and `isAlive` is `hp > 0`.
 *
 * **Scope, decided 28 August 2026 (see `KNOWN_ONE_SHOT_WAIVERS`).** The bound is evaluated over *every* case, critical
 * and plain, and the plain half is a hard requirement: an ordinary hit that removes a full-HP hero would be a defect.
 * The critical half is waived as approved design, so `PLAIN_ONE_SHOT_IS_FORBIDDEN` states the part that may never be
 * waived — it exists so a future waiver cannot quietly absorb a plain one-shot by adding a line.
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
 * Critical one-shot kills, **approved as design on 28 August 2026** rather than pending.
 *
 * ## What was decided, and against what
 *
 * This list used to be described as "violations the owner has not yet resolved". The decision went the other way: the
 * requirement "no hit may remove a full-HP hero" is **withdrawn** for critical hits, and these six cases are the shipped
 * design. That is a decision against what the documents called a defect, so the reasoning is recorded here and not only
 * in `docs/12`.
 *
 * ## Why not fixed
 *
 * Measured, not assumed — no single lever works:
 *
 *   - hero `maxHp` 24 → 26/28/30: a 30-damage crit still kills; only **32** survives it (+33% survivability);
 *   - starter vest 3 → 8: does **nothing**, because the crit multiplier applies before armour is subtracted (30 → 25);
 *   - crit multiplier 1.5 → 1.25: 25 damage against 24 HP, still lethal.
 *
 * The cheapest working combination needs **three** simultaneous changes (maxHp 28 + vest 4 + crit ×1.3 = 25 damage, 3 to
 * spare). All three sit on both sides of every exchange, so the hero would also stop killing a 16-HP enemy with one crit
 * — which means re-measuring and almost certainly rewriting all six win-rate corridors. Rewriting corridors to fit a
 * result is exactly what this module forbids.
 *
 * ## Why it is acceptable
 *
 * The event needs the hero at **full** HP: 30 damage against a 24 maximum is only reachable in the first exchange, before
 * any damage taken and before any healing. Its per-shot probability is 1.8% (`yard-rusher`, from cover) to 10.8%
 * (`relay-shooter`) — not rare, and deliberately so. Three shipped mitigations make it the price of a mistake rather than
 * an arbitrary loss: the **first defeat is free** (`firstDeathReturnUsed`), a defeat keeps campaign progress and allows
 * retry, and the medbay heals between encounters. The tactical lesson is legible: do not open an exchange in the open,
 * because cover drops enemy hit chance to 12–35%.
 *
 * ## What is still enforced
 *
 * Exact equality against the measured violations, unchanged: a **new** one-shot fails the suite, and fixing the data also
 * fails it until the line is deleted. Every entry is the same case — a `pm`/`hornet` critical through the starter vest,
 * `round(20 × 1.1 × 1.5) − 3 = 30`. Listed individually rather than as a pattern, because a wildcard would silently
 * absorb a genuinely new one on a future map. And `PLAIN_ONE_SHOT_IS_FORBIDDEN` keeps the non-critical half absolute.
 */
export const KNOWN_ONE_SHOT_WAIVERS: readonly string[] = [
  'one-shot:collapsed-yard:yard-rusher:critical',
  'one-shot:perimeter-checkpoint:checkpoint-shooter:critical',
  'one-shot:relay-station:relay-shooter:critical',
  /* Zone two (D-03) contributes three of the same case; no arena in it lets an enemy kill without a crit. */
  'one-shot:filter-works:works-runner:critical',
  'one-shot:filter-works:works-watch:critical',
  'one-shot:pumping-station:station-sentinel:critical',
]

/**
 * The half of the lethality bound that may **never** be waived: a non-critical hit must not remove a full-HP hero.
 *
 * Named and exported so the suite can assert it independently of `KNOWN_ONE_SHOT_WAIVERS`. Without it, the waiver list is
 * the only thing standing between the game and a plain one-shot, and a waiver list is one line away from absorbing one.
 * This is also why `sawn-shotgun` (37 damage through the starter vest) is deliberately carried by no archetype.
 */
export const PLAIN_ONE_SHOT_IS_FORBIDDEN = true

/** Waived bounds that are *not* critical one-shots. Must always be empty — see `PLAIN_ONE_SHOT_IS_FORBIDDEN`. */
export const nonCriticalWaivers = (waivers: readonly string[] = KNOWN_ONE_SHOT_WAIVERS): string[] =>
  waivers.filter((entry) => !entry.endsWith(':critical'))
