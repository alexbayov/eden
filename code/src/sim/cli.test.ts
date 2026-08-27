/**
 * Tests for the balance simulator CLI (W3-01 acceptance criteria 1 and 2, W3-02 criteria 1–3).
 *
 * Two properties are worth testing here and they are the two the ticket names:
 *
 *   1. **Determinism.** Identical inputs produce a byte-identical report — both artefacts, not just
 *      the aggregate numbers. Asserted on the rendered strings rather than on the objects, because
 *      "byte-identical" is the acceptance criterion and an object comparison would pass while
 *      `JSON.stringify` emitted keys in a different order.
 *   2. **Live content only.** The run is driven by `arena-manifest.json` + `missions.json` from
 *      `code/public/config/`, not by a fixture. An orphan map file that exists on disk but is
 *      absent from the manifest must not appear in a report, and a map in the manifest must.
 *
 * The expectations are deliberately *structural and relational* rather than pinned numbers. A
 * snapshot of `winRate: 0.842` would have to be edited by whoever next tunes a balance number,
 * which converts an intentional balance change into a test failure that looks like a regression and
 * trains people to update expectations without reading them. What is asserted instead: the report
 * reproduces, different seeds diverge, the encounter set equals the live catalog, rates are
 * coherent with their counts, and the metric list docs/23 §8 requires is present. Pinned values are
 * used only for the seed derivation and the aggregation arithmetic, which are pure functions with
 * no balance content.
 *
 * `--runs` is small here on purpose (the baseline report is what runs 200). These tests exist to
 * check the machinery, and the machinery does not care how many samples it averages.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BALANCE_OUTPUT_DIR,
  DEFAULT_MODE,
  DEFAULT_POLICY,
  DEFAULT_RUNS,
  DEFAULT_SEED,
  parseArgs,
  resolveCommit,
  runSimulation,
  summarize,
  type CliOptions,
} from './cli'
import { loadSimulationContent } from './content-source'
import { orderedMissions, campaignStart, missionStart, progressTo, resolveDefeat, resolveVictory } from './mission-save'
import { renderJson, renderMarkdown, type SimulationReport } from './report'
import { aggregateCombat, summarize as summarizeValues } from './metrics'
import { deriveSeed, hashLabel } from './seed'
import { SAVE_SCHEMA_VERSION, validateSave } from '../game/save'
import { simulateBattle } from './battle'
import { POLICIES, POLICY_IDS } from './policies'

/** Small run count; determinism and content wiring do not depend on sample size. */
const RUNS = 12

const options = (overrides: Partial<CliOptions> = {}): CliOptions =>
  parseArgs([], { runs: RUNS, write: false, quiet: true, commit: 'test-commit', ...overrides })

describe('simulator CLI argument parsing', () => {
  it('defaults to 200 runs, the cover-torso policy and isolated mode', () => {
    const parsed = parseArgs([])
    expect(parsed.runs).toBe(DEFAULT_RUNS)
    expect(DEFAULT_RUNS).toBe(200)
    expect(parsed.seed).toBe(DEFAULT_SEED)
    expect(parsed.policyId).toBe(DEFAULT_POLICY)
    expect(parsed.mode).toBe(DEFAULT_MODE)
    expect(parsed.outDir).toBe(BALANCE_OUTPUT_DIR)
    /* The documented output location, relative to the repository root. */
    expect(BALANCE_OUTPUT_DIR.replace(/\\/g, '/')).toMatch(/\/design-data\/balance\/$/)
  })

  it('accepts both --flag value and --flag=value', () => {
    const spaced = parseArgs(['--runs', '7', '--seed', '99', '--policy', 'cover-head', '--mode', 'chain'])
    const inline = parseArgs(['--runs=7', '--seed=99', '--policy=cover-head', '--mode=chain'])
    expect(spaced.runs).toBe(7)
    expect(spaced).toEqual(inline)
  })

  it('rejects unknown flags, missing values and out-of-range numbers instead of ignoring them', () => {
    /* A silently dropped --runs would produce a plausible report with the wrong sample size. */
    expect(() => parseArgs(['--rums', '10'])).toThrow(/Неизвестный флаг/)
    expect(() => parseArgs(['--runs'])).toThrow(/требует значение/)
    expect(() => parseArgs(['--runs', '--seed', '5'])).toThrow(/требует значение/)
    expect(() => parseArgs(['--runs', '0'])).toThrow(/≥ 1/)
    expect(() => parseArgs(['--runs', '2.5'])).toThrow(/целое число/)
    expect(() => parseArgs(['--seed', '-1'])).toThrow(/≥ 0/)
    expect(() => parseArgs(['--mode', 'sideways'])).toThrow(/isolated \| chain/)
    expect(() => parseArgs(['--policy', 'perfect-play'])).toThrow(/Неизвестная политика/)
    expect(() => parseArgs(['positional'])).toThrow(/Неожиданный аргумент/)
  })

  it('exposes every registered policy to --policy', () => {
    for (const id of POLICY_IDS) expect(parseArgs(['--policy', id]).policyId).toBe(id)
  })
})

describe('commit resolution', () => {
  it('prefers SIMULATE_COMMIT, then GITHUB_SHA, and truncates to a short sha', () => {
    expect(resolveCommit({ SIMULATE_COMMIT: 'abcdef0123456789' })).toBe('abcdef012345')
    expect(resolveCommit({ GITHUB_SHA: 'fedcba9876543210' })).toBe('fedcba987654')
    expect(resolveCommit({ SIMULATE_COMMIT: 'abc', GITHUB_SHA: 'def' })).toBe('abc')
  })

  it('falls back to git and yields either a short sha or null, never a fabricated value', () => {
    const commit = resolveCommit({})
    /* Must not invent provenance when git is unavailable: docs/23 §8 forbids an unattributed report. */
    expect(commit === null || /^[0-9a-f]{7,12}$/.test(commit)).toBe(true)
  })
})

describe('seed derivation', () => {
  it('is a pure function of base seed, label and run index', () => {
    expect(deriveSeed(12345, 'cover-torso:relay-station', 0)).toBe(deriveSeed(12345, 'cover-torso:relay-station', 0))
    expect(deriveSeed(12345, 'cover-torso:relay-station', 0)).not.toBe(deriveSeed(12345, 'cover-torso:relay-station', 1))
    expect(deriveSeed(12345, 'cover-torso:relay-station', 0)).not.toBe(deriveSeed(12345, 'cover-torso:collapsed-yard', 0))
    expect(deriveSeed(12345, 'cover-torso:relay-station', 0)).not.toBe(deriveSeed(54321, 'cover-torso:relay-station', 0))
    expect(hashLabel('relay-station')).toBe(hashLabel('relay-station'))
  })

  it('produces a uint32 for every run index', () => {
    for (let index = 0; index < 50; index += 1) {
      const seed = deriveSeed(DEFAULT_SEED, 'cover-torso:relay-station', index)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('mission-start saves are the game\'s own states', () => {
  it('validates every live encounter start against the runtime save validator', async () => {
    const content = await loadSimulationContent()
    const missions = orderedMissions(content)
    expect(missions.length).toBeGreaterThan(0)
    for (const mission of missions) {
      const started = missionStart(content, progressTo(content, mission.id), mission.id)
      /* The assertion that matters: a save the game would reject is never measured. */
      expect(validateSave(started.save, content.campaignCatalog).ok).toBe(true)
      expect(started.save.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
      expect(started.save.arenaId).toBe(mission.arenaId)
      expect(started.save.activeEncounterId).toBe(mission.id)
      expect(started.save.phase).toBe('player')
      expect(started.save.turn).toBe(1)
      expect(started.save.campaign.screen).toBe('mission')
      expect(started.save.campaign.mission.status).toBe('active')
      expect(started.save.units.filter((unit) => unit.id === 'hero' && unit.team === 'player')).toHaveLength(1)
      expect(started.save.units.some((unit) => unit.team === 'enemy')).toBe(true)
    }
  })

  it('refuses to start an encounter the campaign has not unlocked', async () => {
    const content = await loadSimulationContent()
    const missions = orderedMissions(content)
    if (missions.length < 2) return
    /* Encounter 2 from a fresh campaign is exactly the state `validateSave` exists to reject. */
    expect(() => missionStart(content, campaignStart(content), missions[1].id)).toThrow(/startMission отклонил/)
  })

  it('rejects an unknown encounter or arena by name', async () => {
    const content = await loadSimulationContent()
    expect(() => missionStart(content, campaignStart(content), 'no-such-encounter')).toThrow(/отсутствует в каталоге/)
    expect(() => progressTo(content, 'no-such-encounter')).toThrow(/отсутствует в каталоге/)
  })

  it('claims the reward on victory and claims nothing on defeat', async () => {
    const content = await loadSimulationContent()
    const first = orderedMissions(content)[0]
    const started = missionStart(content, campaignStart(content), first.id)
    const won = resolveVictory(content, started.progress, started.save.units)
    expect(won.campaign.claimedRewards).toContain(first.rewardId)
    expect(won.campaign.xp).toBeGreaterThan(0)
    expect(won.campaign.encounters.find((entry) => entry.id === first.id)?.status).toBe('completed')

    const lost = resolveDefeat(started.progress, started.save.units)
    expect(lost.campaign.claimedRewards).toEqual([])
    expect(lost.campaign.xp).toBe(0)
    expect(lost.campaign.encounters.find((entry) => entry.id === first.id)?.status).toBe('failed')
    /* A failed encounter must remain a valid, retryable campaign, not a dangling active mission. */
    expect(lost.campaign.screen).toBe('home')
  })

  it('carries hero condition forward, so a chain pass is attrition rather than three fresh fights', async () => {
    const content = await loadSimulationContent()
    const missions = orderedMissions(content)
    if (missions.length < 2) return
    const first = missionStart(content, campaignStart(content), missions[0].id)
    const battle = simulateBattle({
      arena: first.arena,
      save: first.save,
      policy: POLICIES[DEFAULT_POLICY],
      seed: deriveSeed(DEFAULT_SEED, `${DEFAULT_POLICY}:${first.arena.id}`, 0),
      turnLimit: 40,
      /* W6-01: read off the mission, so this stays a measurement of the shipped objective rather than
         an assumption that every encounter is an `eliminate`. */
      objective: { params: missions[0].objectiveParams, turnLimit: missions[0].turnLimit },
    })
    if (battle.outcome !== 'win') throw new Error('фиксированный seed перестал давать победу на первой encounter')
    const next = missionStart(content, resolveVictory(content, first.progress, battle.finalUnits), missions[1].id)
    const heroBefore = battle.finalUnits.find((unit) => unit.id === 'hero')!
    const heroAfter = next.save.units.find((unit) => unit.id === 'hero')!
    expect(heroAfter.hp).toBe(heroBefore.hp)
    expect(heroAfter.weaponState!.durability).toBe(heroBefore.weaponState!.durability)
    expect(heroAfter.weaponState!.reserveAmmo).toBe(heroBefore.weaponState!.reserveAmmo)
    expect(heroAfter.armor!.durability).toBe(heroBefore.armor!.durability)
    /* Positions and AP come from the new encounter template, not from the previous battle. */
    expect(heroAfter.ap).toBe(10)
  })
})

describe('simulator determinism', () => {
  it('produces byte-identical JSON and Markdown for identical inputs', async () => {
    const config = options()
    const first = await runSimulation(config)
    const second = await runSimulation(config)
    expect(renderJson(first.report)).toBe(renderJson(second.report))
    expect(renderMarkdown(first.report)).toBe(renderMarkdown(second.report))
  })

  it('produces different reports for different seeds, policies and modes', async () => {
    const base = renderJson((await runSimulation(options())).report)
    expect(renderJson((await runSimulation(options({ seed: 987654 }))).report)).not.toBe(base)
    expect(renderJson((await runSimulation(options({ policyId: 'greedy-torso' }))).report)).not.toBe(base)
    expect(renderJson((await runSimulation(options({ mode: 'chain' }))).report)).not.toBe(base)
  })

  it('replays the first encounter identically in both modes, isolating carry-over as the only difference', async () => {
    /* Both modes start encounter 1 from campaign start, and the seed label excludes the mode, so
       the first encounter must match battle for battle. Any later divergence is therefore
       attributable to carried HP/ammo/durability and to nothing else. */
    const isolated = await runSimulation(options({ mode: 'isolated' }))
    const chain = await runSimulation(options({ mode: 'chain' }))
    expect(chain.report.arenas[0].metrics).toEqual(isolated.report.arenas[0].metrics)
    /* And a chain pass can only shrink later samples, never grow them. */
    for (const [index, arena] of chain.report.arenas.entries())
      expect(arena.metrics.runs).toBeLessThanOrEqual(isolated.report.arenas[index].metrics.runs)
  })

  it('contains nothing environmental in the report body', async () => {
    const { report } = await runSimulation(options())
    const serialized = renderJson(report)
    /* No clock, no host, no absolute path: those are what make a report irreproducible. */
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
    expect(serialized).not.toContain(process.cwd())
    expect(Object.keys(report)).toEqual([
      'commit',
      'contentCatalogId',
      'seed',
      'runs',
      'policy',
      'mode',
      'restock',
      'turnLimit',
      'arenas',
      'total',
      'economy',
    ])
  })
})

describe('simulator runs live content only', () => {
  it('covers exactly the encounters of the shipped catalog, in campaign order', async () => {
    const content = await loadSimulationContent()
    const expected = orderedMissions(content)
    const { report } = await runSimulation(options())
    expect(report.arenas.map((arena) => arena.encounterId)).toEqual(expected.map((mission) => mission.id))
    expect(report.arenas.map((arena) => arena.arena)).toEqual(expected.map((mission) => mission.arenaId))
    expect(report.contentCatalogId).toBe(content.catalogId)
  })

  it('never simulates a map that is absent from arena-manifest.json', async () => {
    const content = await loadSimulationContent()
    const manifestIds = new Set(content.arenas.manifest.entries.map((entry) => entry.id))
    const { report } = await runSimulation(options())
    for (const arena of report.arenas) expect(manifestIds.has(arena.arena)).toBe(true)

    /* The orphan maps in public/config/ are the live check that "live" means the manifest and not
       the directory listing. If a future ticket adds one to the manifest this assertion still
       holds, because it is derived from the manifest rather than hard-coded. */
    const configDir = new URL('../../public/config/', import.meta.url)
    const onDisk = (await readdir(configDir)).filter((name) => name.endsWith('.json'))
    const orphans = onDisk.filter((name) => {
      const id = name.replace(/\.json$/, '')
      return !manifestIds.has(id) && /^(arena|mission)/.test(id)
    })
    expect(orphans.length).toBeGreaterThan(0)
    for (const orphan of orphans)
      expect(report.arenas.some((arena) => arena.arena === orphan.replace(/\.json$/, ''))).toBe(false)
  })

  it('measures enemy archetypes that come from the equipment catalog', async () => {
    const content = await loadSimulationContent()
    const known = new Set(content.equipment.enemies.map((enemy) => enemy.id))
    const { report } = await runSimulation(options())
    const measured = report.arenas.flatMap((arena) => Object.keys(arena.metrics.ttkByArchetype))
    expect(measured.length).toBeGreaterThan(0)
    for (const archetype of measured) expect(known.has(archetype)).toBe(true)
  })
})

describe('report contents', () => {
  const metricFields = [
    'runs',
    'winRate',
    'turnsMean',
    'turnsMedian',
    'ttkByArchetype',
    'damageTakenMean',
    'ammoSpentMean',
    'weaponDurabilityLostMean',
    'armorDurabilityLostMean',
    'malfunctionRate',
    'critRate',
    'missRate',
    'executionRate',
  ] as const

  it('reports every metric docs/23 §8 and W3-02 require, per encounter and pooled', async () => {
    const { report } = await runSimulation(options())
    for (const metrics of [...report.arenas.map((arena) => arena.metrics), report.total])
      for (const field of metricFields) expect(metrics, `отсутствует метрика ${field}`).toHaveProperty(field)
    expect(report.seed).toBe(DEFAULT_SEED)
    expect(report.runs).toBe(RUNS)
    expect(report.commit).toBe('test-commit')
  })

  it('keeps rates coherent with the counts they were derived from', async () => {
    const { report } = await runSimulation(options())
    for (const arena of report.arenas) {
      const metrics = arena.metrics
      /* Outcomes partition the runs: a battle ends exactly once. */
      /* Counted, not summed as rates: `metrics.ts` rounds each rate to four digits, so five of them can legitimately
         total 1.0001. `objectiveFailedRate` is the fifth outcome, reachable since zone two shipped a `turnLimit`. */
      expect(
        [metrics.winRate, metrics.lossRate, metrics.ammoEmptyRate, metrics.turnLimitRate, metrics.objectiveFailedRate]
          .reduce((sum, value) => sum + Math.round(value * metrics.runs), 0),
      ).toBe(metrics.runs)
      /*
       * A jam resolves no projectile, so hit and miss partition the resolved shots only — and only when a shot was
       * fired at all. Zone two ships encounters won by *walking* (`retrieve`, `escape`), where the hero can finish
       * without firing; asserting a partition of an empty set demanded that every mission be a firefight, which the
       * objective runtime stopped requiring in W6-01.
       */
      if (metrics.resolvedShotsTotal > 0) expect(metrics.hitRate + metrics.missRate).toBeCloseTo(1, 4)
      else expect(metrics.hitRate + metrics.missRate).toBe(0)
      expect(metrics.resolvedShotsTotal + metrics.malfunctionsTotal).toBe(metrics.shotsTotal)
      if (metrics.shotsTotal > 0) expect(metrics.malfunctionRate).toBeCloseTo(metrics.malfunctionsTotal / metrics.shotsTotal, 4)
      else expect(metrics.malfunctionRate).toBe(0)
      for (const rate of [metrics.winRate, metrics.hitRate, metrics.critRate, metrics.killRate]) {
        expect(rate).toBeGreaterThanOrEqual(0)
        expect(rate).toBeLessThanOrEqual(1)
      }
      expect(metrics.turns.min).toBeGreaterThanOrEqual(1)
      expect(metrics.turnsMean).toBeGreaterThanOrEqual(metrics.turns.min)
      expect(metrics.turnsMean).toBeLessThanOrEqual(metrics.turns.max)
      expect(metrics.damageTakenMean).toBeGreaterThanOrEqual(0)
    }
    /* Pooling is over the same battles: the totals cannot exceed the parts' sum. */
    const shots = report.arenas.reduce((sum, arena) => sum + arena.metrics.shotsTotal, 0)
    expect(report.total.shotsTotal).toBe(shots)
    expect(report.total.runs).toBe(report.arenas.reduce((sum, arena) => sum + arena.metrics.runs, 0))
  })

  it('prices the economy with the shipped constants and the reward catalog', async () => {
    const content = await loadSimulationContent()
    const { report } = await runSimulation(options())
    const catalogXp = orderedMissions(content).reduce(
      (sum, mission) => sum + (content.rewards.find((reward) => reward.id === mission.rewardId)?.xp ?? 0),
      0,
    )
    expect(report.economy.xpPerPassMax).toBe(catalogXp)
    /* Non-zero, so an all-lookups-missed bug cannot pass as `0 === 0`. Encounter id and arena id
       happen to coincide on the shipped content, so a mismatched lookup key would otherwise be
       invisible here; the ceiling being right is the only evidence the key is right. */
    expect(catalogXp).toBeGreaterThan(0)
    expect(report.economy.xpPerPassMean).toBeGreaterThan(0)
    /* Earned XP can never exceed the catalog ceiling, and only a win earns any. */
    expect(report.economy.xpPerPassMean).toBeLessThanOrEqual(catalogXp)
    expect(report.economy.xpPerPassMean).toBeGreaterThanOrEqual(0)
    expect(report.economy.constants).toEqual({ repairMaterial: 'metal', repairMaterialRate: 2, medbayHealPerLevel: 6 })
    for (const flow of report.economy.resources) {
      expect(flow.net).toBeCloseTo(flow.income - flow.repairCost, 4)
      const granted = content.rewards.reduce((sum, reward) => sum + (reward.resources[flow.resource] ?? 0), 0)
      expect(flow.income).toBeLessThanOrEqual(granted)
    }
  })

  it('renders a Markdown summary carrying the provenance and the same numbers', async () => {
    const { report } = await runSimulation(options())
    const markdown = renderMarkdown(report)
    expect(markdown).toContain('# Balance simulation report')
    expect(markdown).toContain('seed: `12345`')
    expect(markdown).toContain('commit: `test-commit`')
    expect(markdown).toContain(`policy: \`${DEFAULT_POLICY}\``)
    for (const arena of report.arenas) expect(markdown).toContain(`\`${arena.encounterId}\``)
    /* The document must state its own limits; a report read as "the game is balanced" is misuse. */
    expect(markdown).toContain('Что этот отчёт не измеряет')
    expect(markdown).toContain(report.total.turnsMean.toFixed(2))
  })

  it('says so, rather than implying provenance, when the commit is unknown', () => {
    const report: SimulationReport = {
      ...({} as SimulationReport),
      commit: null,
      contentCatalogId: 'x',
      seed: 1,
      runs: 1,
      policy: DEFAULT_POLICY,
      mode: 'isolated',
      turnLimit: 40,
      arenas: [],
      total: aggregateCombat([]),
      economy: {
        xpPerPassMean: 0,
        xpPerPassMax: 0,
        bandagesPerPassMean: 0,
        bandagesNeededPerPassMean: 0,
        bandagesCraftablePerPassMean: 0,
        bandageBalancePerPassMean: 0,
        resources: [],
        passesForAllUpgrades: null,
        constants: { repairMaterial: 'metal', repairMaterialRate: 2, medbayHealPerLevel: 6 },
      },
    }
    expect(renderMarkdown(report)).toContain('невоспроизводим')
    expect(renderMarkdown(report)).toContain('unknown')
  })
})

describe('aggregation arithmetic', () => {
  it('summarizes a known sample exactly', () => {
    expect(summarizeValues([1, 2, 3, 4])).toEqual({ count: 4, mean: 2.5, median: 2.5, min: 1, max: 4, stdDev: 1.118 })
    expect(summarizeValues([5])).toEqual({ count: 1, mean: 5, median: 5, min: 5, max: 5, stdDev: 0 })
    expect(summarizeValues([])).toEqual({ count: 0, mean: 0, median: 0, min: 0, max: 0, stdDev: 0 })
  })

  it('reports zeroed rates for an empty result set instead of NaN', () => {
    const empty = aggregateCombat([])
    expect(empty.runs).toBe(0)
    expect(empty.winRate).toBe(0)
    expect(empty.hitRate).toBe(0)
    expect(empty.malfunctionRate).toBe(0)
    /* A NaN would serialise as `null` and silently corrupt a report. */
    expect(JSON.stringify(empty)).not.toContain('null')
  })
})

describe('artefact writing', () => {
  it('creates the output directory and writes reproducible JSON and Markdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eden-balance-'))
    const outDir = join(directory, 'nested', 'balance')
    try {
      const config = options({ write: true, outDir, date: '2026-08-23', scope: 'balance' })
      const run = await runSimulation(config)
      expect(run.files).toHaveLength(2)
      const names = (await readdir(outDir)).sort()
      /* The naming rule from design-data/README.md: date, scope and seed all present. */
      expect(names).toEqual(['2026-08-23-balance-isolated-cover-torso-12345.json', '2026-08-23-balance-isolated-cover-torso-12345.md'])
      const json = await readFile(run.files[0], 'utf8')
      expect(json).toBe(renderJson(run.report))
      expect(json.endsWith('\n')).toBe(true)
      expect(JSON.parse(json).seed).toBe(DEFAULT_SEED)
      expect(await readFile(run.files[1], 'utf8')).toBe(renderMarkdown(run.report))

      /* Re-running over the same directory must overwrite with identical bytes. */
      const again = await runSimulation(config)
      expect(await readFile(again.files[0], 'utf8')).toBe(json)
      expect((await readdir(outDir)).sort()).toEqual(names)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes nothing when --no-write is passed', async () => {
    const run = await runSimulation(options({ write: false }))
    expect(run.files).toEqual([])
  })

  it('summarizes to stdout with the run identity and every encounter', async () => {
    const run = await runSimulation(options())
    const text = summarize(run)
    expect(text).toContain(`seed=${DEFAULT_SEED}`)
    expect(text).toContain(`runs=${RUNS}`)
    expect(text).toContain(`policy=${DEFAULT_POLICY}`)
    for (const arena of run.report.arenas) expect(text).toContain(arena.encounterId)
    expect(text).toContain('total')
  })
})
