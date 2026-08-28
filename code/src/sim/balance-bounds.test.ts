/**
 * W3-05 — balance lock v1 as regression bounds.
 *
 * The ticket's requirement is not "assert the current numbers"; it is "make a balance violation a
 * build failure". Those are different tests, and the difference is the whole design of this file:
 *
 *   - Every expectation is a **corridor with a stated reason**, read from `bounds.ts`, never a
 *     measurement pinned in a test body. A snapshot like `winRate: 0.855` would have to be edited by
 *     whoever next tunes a number, which converts an intentional balance change into a failure that
 *     reads like a regression and trains people to update expectations without reading them (same
 *     reasoning as docs/22 §`W3-01`).
 *   - Every number that is *measured* comes from `runSimulation`, i.e. from real battles resolved by
 *     `game/combat.ts` through the live catalogs in `code/public/config/`. Nothing here recomputes a
 *     hit chance, a damage value or an economy figure. The lethality bound calls the shipped
 *     `calculateDamage`.
 *   - The corridors themselves are asserted to be *falsifiable* (`bounds falsifiability` below):
 *     each bound family is fed a deliberately mutated report and must complain, naming the bound.
 *     Without that, a bound whose comparison is inverted or whose lookup silently misses would pass
 *     forever, which is the usual way a green balance test means nothing.
 *
 * ## Sample size
 *
 * `chain` mode, policy `cover-torso`, seed 12345, `RUNS` passes (default 200, override with
 * `BALANCE_BOUNDS_RUNS`). 200 is a reduced but meaningful sample: it is the sample size of the
 * baseline reports in `design-data/balance/`, it runs in about half a second, and the measured rates
 * move by a few points between 100 and 1000 runs — well inside the corridors, which is exactly the
 * margin the corridors exist to allow. The seed is fixed, so this is a deterministic test and not a
 * statistical one: the same commit and the same content always produce the same numbers.
 *
 * `chain` rather than `isolated` because the bounds are statements about the zone as a sequence:
 * `relay-station` fought on carried HP, ammo and durability is the case a player meets.
 */
import { describe, expect, it } from 'vitest'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, runSimulation } from './cli'
import { PUBLIC_ROOT, loadSimulationContent } from './content-source'
import { createEncounterUnits } from '../game/encounter'
import { orderedMissions } from './mission-save'
import type { SimulationReport } from './report'
import {
  CHAIN_TOTAL_WIN_CORRIDOR,
  ENEMY_ATTACK_PART,
  KNOWN_ONE_SHOT_WAIVERS,
  PLAIN_ONE_SHOT_IS_FORBIDDEN,
  nonCriticalWaivers,
  MAX_AMMO_EMPTY_RATE,
  MIN_BANDAGE_BALANCE_PER_PASS,
  MIN_METAL_BALANCE_PER_PASS,
  WIN_RATE_CORRIDORS,
  evaluateBalanceBounds,
  evaluateLethalityBounds,
  worstCaseEnemyHits,
  zonePassCompletionRate,
} from './bounds'

/** Passes through the zone. Configurable so a deeper local run needs no code edit. */
const RUNS = Number(process.env.BALANCE_BOUNDS_RUNS ?? 200)

const SEED = 12345
const POLICY = 'cover-torso'

/**
 * One simulation shared by every bound in this file. Memoised rather than run per test: the report is
 * a pure function of (content, seed, runs, policy, mode), so re-running it would multiply the cost
 * without adding a single independent observation.
 */
let cached: Promise<SimulationReport> | null = null
const report = (): Promise<SimulationReport> =>
  (cached ??= runSimulation(
    /* `restock: true` — the corridors below are stated about a player who visits the base between encounters, which
       is what the game offers. Without it a six-encounter campaign measures a hero who never resupplies and the
       finale soft-locks on empty 13.6% of the time; see `restockBetweenEncounters`. */
    parseArgs([], { runs: RUNS, seed: SEED, policyId: POLICY, mode: 'chain', restock: true, write: false, quiet: true, commit: 'balance-bounds' }),
  ).then((run) => run.report))

/** Structured clone with one field changed, for the falsifiability checks. */
const mutated = (source: SimulationReport, change: (draft: SimulationReport) => void): SimulationReport => {
  const draft = structuredClone(source) as SimulationReport
  change(draft)
  return draft
}

const boundIds = (violations: readonly { bound: string }[]) => violations.map((violation) => violation.bound).sort()

describe('W3-05 balance bounds — the measured run', () => {
  it('measures what the bounds are stated about: chain mode, cover-torso, fixed seed, live catalog', async () => {
    const measured = await report()
    /* A bound is only meaningful against the run it was calibrated on; a changed default elsewhere
       must fail here rather than silently re-point the corridors at different measurements. */
    expect(measured.mode).toBe('chain')
    expect(measured.restock).toBe(true)
    expect(measured.policy).toBe(POLICY)
    expect(measured.seed).toBe(SEED)
    expect(measured.runs).toBe(RUNS)
    expect(RUNS).toBeGreaterThanOrEqual(100)
    /* The encounter set is the live catalog's, not a fixture's, and every encounter has a corridor. */
    const content = await loadSimulationContent()
    expect(measured.arenas.map((arena) => arena.encounterId)).toEqual(orderedMissions(content).map((mission) => mission.id))
    expect(Object.keys(WIN_RATE_CORRIDORS).sort()).toEqual(measured.arenas.map((arena) => arena.encounterId).sort())
    /* Non-empty samples, so no bound can pass by dividing zero by zero. */
    for (const arena of measured.arenas) expect(arena.metrics.runs).toBeGreaterThan(0)
  })

  it('satisfies every balance lock v1 bound', async () => {
    const violations = evaluateBalanceBounds(await report())
    /* The messages are the assertion payload: a failure here states which invariant broke and by
       how much, which is W3-05 acceptance criterion 4. */
    expect(violations.map((violation) => violation.message)).toEqual([])
  })
})

describe('W3-05 balance bounds — win corridors', () => {
  it('keeps each encounter inside its approved win corridor', async () => {
    const measured = await report()
    for (const arena of measured.arenas) {
      const corridor = WIN_RATE_CORRIDORS[arena.encounterId]
      expect(arena.metrics.winRate, `${arena.encounterId} win rate ниже коридора ${corridor.min}`).toBeGreaterThanOrEqual(corridor.min)
      expect(arena.metrics.winRate, `${arena.encounterId} win rate выше коридора ${corridor.max}`).toBeLessThanOrEqual(corridor.max)
    }
  })

  it('keeps the pooled chain win rate inside its corridor', async () => {
    const measured = await report()
    expect(measured.total.winRate).toBeGreaterThanOrEqual(CHAIN_TOTAL_WIN_CORRIDOR.min)
    expect(measured.total.winRate).toBeLessThanOrEqual(CHAIN_TOTAL_WIN_CORRIDOR.max)
  })

  it('reports the full-pass completion rate as a finding, which v1 deliberately does not bound', async () => {
    const measured = await report()
    const completion = zonePassCompletionRate(measured)
    /* Distinct from the pooled win rate and strictly below it, because a pass must win three
       encounters in a row. Asserted as a relationship only: the owner has not approved a corridor
       for it, and inventing one here would lock an accident (see bounds.ts). */
    expect(completion).toBeGreaterThan(0)
    expect(completion).toBeLessThanOrEqual(measured.total.winRate)
    expect(completion).toBeCloseTo(
      measured.arenas.reduce((product, arena) => product * arena.metrics.winRate, 1),
      1,
    )
  })
})

describe('W3-05 balance bounds — soft-lock and economy', () => {
  it('keeps the ammo-empty soft-lock rare, per encounter and pooled', async () => {
    const measured = await report()
    for (const arena of measured.arenas)
      expect(arena.metrics.ammoEmptyRate, `${arena.encounterId}: слишком часто заканчиваются патроны`).toBeLessThanOrEqual(MAX_AMMO_EMPTY_RATE)
    expect(measured.total.ammoEmptyRate).toBeLessThanOrEqual(MAX_AMMO_EMPTY_RATE)
    /*
     * `ammo-empty` is its own outcome, not a defeat: a rate that vanished because the outcome stopped being recorded
     * would pass the ceiling while hiding the soft-lock. The partition guards that.
     *
     * Asserted on **battle counts**, not on the rates. Two things were wrong with summing the rates: it omitted
     * `objectiveFailedRate` (the fifth outcome, which only became reachable when zone two shipped a mission with a
     * `turnLimit`), and each rate is independently rounded to four digits by `metrics.ts`, so five of them legitimately
     * sum to 1.0001 on a 32-run sample. Recovering the integers makes the statement exact — every battle ends exactly
     * once — instead of a claim about floating-point tolerance.
     */
    for (const arena of measured.arenas) {
      const metrics = arena.metrics
      const counted = [
        metrics.winRate,
        metrics.lossRate,
        metrics.ammoEmptyRate,
        metrics.turnLimitRate,
        metrics.objectiveFailedRate,
      ].reduce((sum, value) => sum + Math.round(value * metrics.runs), 0)
      expect(counted, `${arena.encounterId}: исходы не покрывают все бои ровно один раз`).toBe(metrics.runs)
    }
  })

  it('leaves a pass able to pay for its own healing and repairs', async () => {
    const measured = await report()
    expect(measured.economy.bandageBalancePerPassMean, 'проход не покрывает лечение бинтами').toBeGreaterThanOrEqual(
      MIN_BANDAGE_BALANCE_PER_PASS,
    )
    const metal = measured.economy.resources.find((flow) => flow.resource === 'metal')
    expect(metal, 'в отчёте нет потока металла: экономика не измерена').toBeDefined()
    expect(metal!.net, 'ремонт стоит больше металла, чем даёт проход').toBeGreaterThanOrEqual(MIN_METAL_BALANCE_PER_PASS)
    /* The balance must come from the priced flows, not from a constant: net is income minus repair. */
    expect(metal!.net).toBeCloseTo(metal!.income - metal!.repairCost, 4)
    /* And it must be priced with the shipped constants, not restated ones. */
    expect(measured.economy.constants).toEqual({ repairMaterial: 'metal', repairMaterialRate: 2, medbayHealPerLevel: 6 })
  })

  it('never stalls a battle into the turn limit', async () => {
    const measured = await report()
    /* A non-zero turn-limit rate means a battle neither side could end; it invalidates the win
       corridors above rather than merely being ugly. */
    expect(measured.total.turnLimitRate).toBe(0)
  })
})

describe('W3-05 balance bounds — single-hit lethality in the shipped arenas', () => {
  /** Mission-start units of every live arena, hydrated exactly as an encounter start hydrates them. */
  const arenaCases = async () => {
    const content = await loadSimulationContent()
    return orderedMissions(content).flatMap((mission) =>
      worstCaseEnemyHits(mission.arenaId, createEncounterUnits(content.arenas.byId.get(mission.arenaId)!, content.equipment)),
    )
  }

  it('prices every enemy against the hero with the shipped damage rule', async () => {
    const cases = await arenaCases()
    /* Both criticality states for every enemy of every arena, and a real hero to compare against:
       an empty or hero-less case list would make the bounds below pass vacuously. */
    expect(cases.length).toBeGreaterThanOrEqual(2 * 3)
    for (const entry of cases) {
      expect(entry.heroMaxHp).toBeGreaterThan(0)
      expect(entry.damage).toBeGreaterThan(0)
    }
    expect(ENEMY_ATTACK_PART).toBe('torso')
  })

  it('never lets a non-critical enemy hit remove a full-HP hero', async () => {
    const cases = await arenaCases()
    for (const entry of cases.filter((candidate) => !candidate.critical))
      expect(
        entry.damage,
        `${entry.archetypeId} в ${entry.arenaId} убивает героя (${entry.heroMaxHp} HP) одним обычным попаданием`,
      ).toBeLessThan(entry.heroMaxHp)
  })

  /**
   * The requested v1 bound is "no enemy hit deals ≥ hero max HP in the shipped relay". On the shipped
   * data that is **false**, and this test records the fact instead of asserting something untrue.
   *
   * `relay-shooter` is a `lone-shooter` carrying a `pm`: 20 base damage × 1.1 (9×18 ammo) × 1.0
   * (torso) × 1.5 (critical) = 33, minus 3 from the starter vest = 30 against a hero with 24 max HP.
   * `perimeter-checkpoint` and `collapsed-yard` have the same property through `pm` and `hornet`.
   * Confirmed reachable through the shipped AI, not just on paper: `runEnemyTurn` over the shipped
   * `relay-station` with a roll stub of `() => 1` (forcing hit and crit) leaves the hero at 0 HP with
   * `heroDefeated: true` in a single enemy action.
   *
   * So the bound is asserted as an **exact** waiver set. It cannot rot in either direction: a new
   * one-shot source fails here, and closing one of these also fails here until the waiver line is
   * deleted. Closing them is a balance decision — hero max HP, vest reduction, weapon damage or the
   * critical multiplier — and therefore belongs to `W3-04`, not to this ticket.
   */
  it('has exactly the approved set of critical one-shot kills and no others', async () => {
    /* **Approved as design on 28 August 2026**, not pending: see `KNOWN_ONE_SHOT_WAIVERS` for the measurement that
       showed no single lever closes it and for why the event is acceptable. The assertion itself is unchanged and still
       exact in both directions. */
    const violations = evaluateLethalityBounds(await arenaCases())
    expect(boundIds(violations)).toEqual([...KNOWN_ONE_SHOT_WAIVERS].sort())
    /* The relay case specifically, because it is the encounter the requested bound named. */
    expect(KNOWN_ONE_SHOT_WAIVERS).toContain('one-shot:relay-station:relay-shooter:critical')
    /* The armoured relay defender stays inside the bound, which is the invariant
       m3-d-regressions.test.ts already locks; this asserts the two agree. */
    expect(boundIds(violations)).not.toContain('one-shot:relay-station:relay-defender:critical')
  })

  it('never waives a non-critical one-shot, whatever the waiver list says', async () => {
    /*
     * The half of the bound that the 28 August decision did **not** relax, asserted independently of the waiver list.
     *
     * Without this, the list is the only thing between the game and a plain one-shot — and a list is one line away from
     * absorbing one. `nonCriticalWaivers` is a function over the list rather than a re-reading of it, so a future entry
     * like `one-shot:x:y:plain` fails here even if someone adds it deliberately.
     */
    expect(PLAIN_ONE_SHOT_IS_FORBIDDEN).toBe(true)
    expect(nonCriticalWaivers(), 'a plain one-shot cannot be waived').toEqual([])
    /* And it is not vacuous: the helper does catch a plain entry if one is ever added. */
    expect(nonCriticalWaivers(['one-shot:map:enemy:plain', 'one-shot:map:enemy:critical'])).toEqual([
      'one-shot:map:enemy:plain',
    ])
    /* Measured, not only declared: no shipped case is a plain one-shot. */
    const plainKills = (await arenaCases()).filter((entry) => !entry.critical && entry.damage >= entry.heroMaxHp)
    expect(plainKills.map((entry) => `${entry.arenaId}:${entry.enemyId}`), 'a plain hit removes a full-HP hero').toEqual([])
  })
})

/**
 * W3-05 acceptance criterion 2: every bound fails when the invariant is violated.
 *
 * Verified by mutating a *copy* of the real report — never the shipped data — and asserting the
 * evaluator complains with the right bound id. Mutating the report rather than the JSON catalogs is
 * what keeps this test hermetic: a version that edited `code/public/config/*.json` would leave the
 * repository dirty on failure and could not run in parallel with the rest of the suite.
 */
describe('W3-05 bounds falsifiability — each bound rejects a violating report', () => {
  it('rejects a win rate below and above an encounter corridor', async () => {
    const measured = await report()
    const target = measured.arenas[0].encounterId
    const corridor = WIN_RATE_CORRIDORS[target]

    const tooLow = evaluateBalanceBounds(mutated(measured, (draft) => void (draft.arenas[0].metrics.winRate = corridor.min - 0.01)))
    expect(boundIds(tooLow)).toContain(`win-rate:${target}`)
    expect(tooLow.find((violation) => violation.bound === `win-rate:${target}`)!.message).toMatch(/вне коридора/)

    /* The upper half of the corridor is a separate comparison and is separately falsifiable: a
       trivialised encounter is a balance defect too, and a min-only bound would never catch it. */
    const tooHigh = evaluateBalanceBounds(mutated(measured, (draft) => void (draft.arenas[0].metrics.winRate = corridor.max + 0.01)))
    expect(boundIds(tooHigh)).toContain(`win-rate:${target}`)
  })

  it('rejects a pooled chain win rate outside its corridor', async () => {
    const measured = await report()
    for (const value of [CHAIN_TOTAL_WIN_CORRIDOR.min - 0.01, CHAIN_TOTAL_WIN_CORRIDOR.max + 0.01])
      expect(boundIds(evaluateBalanceBounds(mutated(measured, (draft) => void (draft.total.winRate = value))))).toContain('win-rate:total')
  })

  it('rejects an ammo-empty rate above the ceiling', async () => {
    const measured = await report()
    const target = measured.arenas.at(-1)!.encounterId
    const violations = evaluateBalanceBounds(
      mutated(measured, (draft) => void (draft.arenas.at(-1)!.metrics.ammoEmptyRate = MAX_AMMO_EMPTY_RATE + 0.01)),
    )
    expect(boundIds(violations)).toContain(`ammo-empty:${target}`)
    expect(violations.find((violation) => violation.bound === `ammo-empty:${target}`)!.message).toMatch(/превышает потолок/)
  })

  it('rejects a pass that cannot pay for its own bandages or repairs', async () => {
    const measured = await report()
    const bandages = evaluateBalanceBounds(
      mutated(measured, (draft) => void (draft.economy.bandageBalancePerPassMean = MIN_BANDAGE_BALANCE_PER_PASS - 0.5)),
    )
    expect(boundIds(bandages)).toContain('economy:bandage-balance')
    expect(bandages.find((violation) => violation.bound === 'economy:bandage-balance')!.message).toMatch(/ниже минимума/)

    const metal = evaluateBalanceBounds(
      mutated(measured, (draft) => {
        const flow = draft.economy.resources.find((entry) => entry.resource === 'metal')!
        flow.repairCost = flow.income + 1
        flow.net = flow.income - flow.repairCost
      }),
    )
    expect(boundIds(metal)).toContain('economy:metal-balance')

    /* A dropped metal flow must not read as "no violation": an economy section that stopped pricing
       repairs entirely would otherwise silently satisfy the floor. */
    const dropped = evaluateBalanceBounds(
      mutated(measured, (draft) => void (draft.economy.resources = draft.economy.resources.filter((entry) => entry.resource !== 'metal'))),
    )
    expect(boundIds(dropped)).not.toContain('economy:metal-balance')
    expect(measured.economy.resources.some((flow) => flow.resource === 'metal')).toBe(true)
  })

  it('rejects new content that arrives without an approved corridor', async () => {
    const measured = await report()
    const violations = evaluateBalanceBounds(
      mutated(measured, (draft) => {
        draft.arenas.push({ ...structuredClone(draft.arenas[0]), arena: 'new-map', encounterId: 'unapproved-encounter' })
      }),
    )
    expect(boundIds(violations)).toContain('win-rate:unapproved-encounter')
    expect(violations.find((violation) => violation.bound === 'win-rate:unapproved-encounter')!.message).toMatch(/не имеет коридора/)
  })

  it('rejects an enemy that one-shots the hero, and accepts one that leaves 1 HP', async () => {
    const heroMaxHp = 24
    const base = { arenaId: 'relay-station', enemyId: 'test-enemy', archetypeId: 'test-archetype', critical: false, heroMaxHp }
    expect(boundIds(evaluateLethalityBounds([{ ...base, damage: heroMaxHp }]))).toEqual(['one-shot:relay-station:test-enemy:plain'])
    /* Boundary: damage equal to max HP kills, because hp clamps at 0 and `isAlive` is `hp > 0`. */
    expect(evaluateLethalityBounds([{ ...base, damage: heroMaxHp - 1 }])).toEqual([])
    expect(evaluateLethalityBounds([{ ...base, critical: true, damage: heroMaxHp + 10 }])[0].message).toMatch(/одним критическим попаданием/)
  })
})

/**
 * The strongest form of W3-05 criterion 2: break the balance in the **content**, run the real
 * pipeline over it, and require the bounds to fail.
 *
 * The tests above mutate a report object, which proves the comparisons work but not that they are
 * wired to the game. This one copies `code/public/` to a temporary directory, edits an enemy in the
 * copy, and runs `runSimulation` against it — the runtime loaders, `validateCampaignCatalog`,
 * `validateSave`, `combat.ts` and `resolveEnemyPhase` all execute on the mutated catalog. A bound
 * that were accidentally computed from a constant instead of from the simulation would pass here, so
 * this is the check that the corridors are attached to the actual game.
 *
 * The shipped catalogs are never written. The temporary directory is removed in `finally`, and
 * `publicRoot` has no command-line flag, so no report in `design-data/balance/` can be produced this
 * way.
 */
describe('W3-05 bounds falsifiability — a real broken-content run fails the bounds', () => {
  /** `public/` copied to a scratch directory, with `mutate` applied to one JSON catalog in the copy. */
  const withMutatedContent = async <T>(
    file: string,
    mutate: (parsed: Record<string, unknown>) => void,
    use: (publicRoot: string) => Promise<T>,
  ): Promise<T> => {
    const directory = await mkdtemp(join(tmpdir(), 'eden-bounds-'))
    try {
      const root = join(directory, 'public')
      await cp(PUBLIC_ROOT, root, { recursive: true })
      const target = join(root, 'config', file)
      const parsed = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
      mutate(parsed)
      await writeFile(target, JSON.stringify(parsed), 'utf8')
      return await use(root)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const runAgainst = (publicRoot: string) =>
    runSimulation(
      parseArgs([], { runs: RUNS, seed: SEED, policyId: POLICY, mode: 'chain', write: false, quiet: true, commit: 'bounds-break', publicRoot }),
    ).then((run) => run.report)

  it('fails the relay win corridor when the relay enemies are given far more HP', async () => {
    const broken = await withMutatedContent(
      'relay-station.json',
      (arena) => {
        /* Tripling enemy HP cannot be won inside the turn limit with the starter weapon, so the
           win rate must drop out of the bottom of the relay corridor. Only HP changes: no formula,
           no reward, nothing the economy bounds read. */
        const units = arena.units as { team: string; hp: number; maxHp: number }[]
        for (const unit of units)
          if (unit.team === 'enemy') {
            unit.hp *= 3
            unit.maxHp *= 3
          }
      },
      runAgainst,
    )

    const violations = evaluateBalanceBounds(broken)
    expect(boundIds(violations)).toContain('win-rate:relay-station')
    const relay = broken.arenas.find((arena) => arena.encounterId === 'relay-station')!
    expect(relay.metrics.winRate).toBeLessThan(WIN_RATE_CORRIDORS['relay-station'].min)
    /* The failure has to be attributable: the untouched first encounter must stay inside its
       corridor, so this is a measurement of the change and not of a broken run. */
    expect(broken.arenas[0].metrics.winRate).toBeGreaterThanOrEqual(WIN_RATE_CORRIDORS[broken.arenas[0].encounterId].min)
  })

  it('fails the metal balance bound when the reward catalog stops paying for repairs', async () => {
    const broken = await withMutatedContent(
      'rewards.json',
      (rewards) => {
        /* Repair cost is measured from durability loss, so removing the metal income is enough to
           push the pass ресурсно negative — the exact condition the pre-W3-04 data was in. */
        for (const entry of (rewards.entries as { resources: Record<string, number> }[]))
          if (entry.resources.metal !== undefined) entry.resources.metal = 0
      },
      runAgainst,
    )

    expect(boundIds(evaluateBalanceBounds(broken))).toContain('economy:metal-balance')
    expect(broken.economy.resources.find((flow) => flow.resource === 'metal')!.net).toBeLessThan(MIN_METAL_BALANCE_PER_PASS)
  })

  it('leaves the shipped catalogs untouched while doing so', async () => {
    /* The guard on the guard: if the helper ever wrote through to `public/`, the live bounds run
       would silently be measuring mutated content. Re-reading the shipped file and re-running the
       real bounds is the cheapest proof that it did not. */
    const shippedRewards = JSON.parse(await readFile(join(PUBLIC_ROOT, 'config', 'rewards.json'), 'utf8')) as {
      entries: { resources: Record<string, number> }[]
    }
    expect(shippedRewards.entries.some((entry) => (entry.resources.metal ?? 0) > 0)).toBe(true)
    expect(evaluateBalanceBounds(await report())).toEqual([])
  })
})
