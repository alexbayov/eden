#!/usr/bin/env -S npx tsx
/**
 * CLI entry point for the balance simulator (W3-01 … W3-03).
 *
 * ```
 * npm run simulate:balance -- --runs 200 --seed 12345 --policy cover-torso --mode isolated
 * npm run simulate:economy -- --runs 200 --seed 12345 --mode chain
 * ```
 *
 * The file is TypeScript run through `tsx`, not a compiled `.mjs`, for one reason: it imports the
 * shipped `game/*` modules directly. That is what W3-01 acceptance criterion 3 ("no formula
 * duplicated in the script") reduces to in practice — there is no build step in which a copy of the
 * combat rules could be substituted, and a type error in the wiring is a `tsc -b` failure rather
 * than a wrong number in a report.
 *
 * ## What it actually does
 *
 * 1. Load and cross-validate every shipped catalog through the *runtime* loaders
 *    (`loadSimulationContent`). Invalid data fails here, with the runtime's error.
 * 2. For each live encounter from `arena-manifest.json` + `missions.json`, build a mission-start
 *    v4 save by driving the game's own campaign transitions (`mission-save.ts`) and validating the
 *    result with `validateSave`.
 * 3. Run `--runs` battles per encounter through `simulateBattle`, seeded by
 *    `deriveSeed(baseSeed, label, runIndex)`.
 * 4. Aggregate, then write `<date>-<scope>-<seed>.json` and `.md` into `design-data/balance/`.
 *
 * ## Modes
 *
 * - `isolated` (default) — every encounter is fought with campaign-start gear. Comparable across
 *   arenas; measures encounter difficulty.
 * - `chain` — run index *i* fights encounter 1, then 2, then 3 carrying HP, ammo, jams and
 *   durability forward, and stops the pass at the first defeat. Measures attrition, i.e. whether a
 *   zone is survivable as a sequence. A defeat means later encounters get fewer samples in this
 *   mode; that is the finding, not a bug.
 *
 * ## Determinism
 *
 * Nothing in the report body comes from the environment. The date in the *filename* does (it is the
 * naming rule in `design-data/README.md`), and `--date` overrides it, which is what the tests use.
 * `--commit`/`SIMULATE_COMMIT` override the git lookup for the same reason.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { simulateBattle, type BattleResult } from './battle'
import type { MissionDefinition } from '../game/campaign-content'
import type { ObjectiveResolution } from '../game/session'
import { loadSimulationContent, type SimulationContent } from './content-source'
import { missionStart, orderedMissions, progressTo, resolveVictory, campaignStart, type CampaignProgress } from './mission-save'
import { POLICY_IDS, policyById, type Policy } from './policies'
import { buildReport, renderJson, renderMarkdown, type ArenaResults, type RunConfig, type SimulationMode, type SimulationReport } from './report'
import { deriveSeed } from './seed'

export const DEFAULT_RUNS = 200
export const DEFAULT_SEED = 12345

/**
 * W6-01 — an encounter's objective, as the battle loop needs it.
 *
 * Read straight off the validated mission rather than defaulted, because a default would make a new
 * `secure`/`retrieve`/`escape` encounter silently measurable as an `eliminate` — reporting a win rate
 * for a mission that cannot be finished that way.
 */
const objectiveFor = (mission: MissionDefinition): ObjectiveResolution => ({
  params: mission.objectiveParams,
  turnLimit: mission.turnLimit,
})
export const DEFAULT_POLICY = 'cover-torso'
export const DEFAULT_MODE: SimulationMode = 'isolated'
/**
 * A battle that reaches this many player turns is reported as `turn-limit`. 40 is far above the
 * measured maximum (8 turns at 200 runs on the shipped content), so it terminates genuine
 * stalemates without truncating real battles; a non-zero `turnLimitRate` in a report means the
 * limit was reached and is itself a finding.
 */
export const DEFAULT_TURN_LIMIT = 40

/** `design-data/balance/`, resolved from this file so the CLI is cwd-independent. */
export const BALANCE_OUTPUT_DIR = fileURLToPath(new URL('../../../design-data/balance/', import.meta.url))

export interface CliOptions extends RunConfig {
  outDir: string
  /** ISO `YYYY-MM-DD` used only in the file name. */
  date: string
  commit: string | null
  /** Report file stem discriminator, e.g. `balance` or `economy`. */
  scope: string
  /** When false, only stdout is produced. */
  write: boolean
  quiet: boolean
  /**
   * Directory the content loaders read `/config/*.json` from. `undefined` means `code/public/`, i.e.
   * the shipped catalogs, and that is the only value any command line can produce — there is
   * deliberately no flag for it, because a report measured against non-shipped data would be
   * indistinguishable from a real one in `design-data/balance/`.
   *
   * It exists for one caller: the W3-05 falsifiability test (`balance-bounds.test.ts`), which copies
   * `public/` to a temporary directory, buffs an enemy there, and asserts the balance bounds fail on
   * the result. Pointing the *whole* pipeline — runtime loaders, validation, mission-save, battles,
   * report — at mutated catalogs is what makes that test evidence about the bounds rather than about
   * a hand-edited report object.
   */
  publicRoot?: string
}

const MODES: readonly SimulationMode[] = ['isolated', 'chain']

const numeric = (raw: string, flag: string, min: number): number => {
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min)
    throw new Error(`${flag} требует целое число ≥ ${min}, получено: ${raw}`)
  return value
}

/**
 * `--flag value` and `--flag=value` both accepted; an unknown flag is an error rather than being
 * ignored, because a silently dropped `--runs` produces a plausible-looking wrong report.
 */
export function parseArgs(argv: readonly string[], defaults: Partial<CliOptions> = {}): CliOptions {
  const options: CliOptions = {
    runs: DEFAULT_RUNS,
    seed: DEFAULT_SEED,
    policyId: DEFAULT_POLICY,
    mode: DEFAULT_MODE,
    turnLimit: DEFAULT_TURN_LIMIT,
    outDir: BALANCE_OUTPUT_DIR,
    date: new Date().toISOString().slice(0, 10),
    commit: null,
    scope: 'balance',
    write: true,
    quiet: false,
    ...defaults,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Неожиданный аргумент: ${token}`)
    const [flag, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined]
    const next = () => {
      const value = inline ?? argv[index + 1]
      if (value === undefined || (inline === undefined && value.startsWith('--')))
        throw new Error(`${flag} требует значение.`)
      if (inline === undefined) index += 1
      return value
    }
    switch (flag) {
      case '--runs':
        options.runs = numeric(next(), '--runs', 1)
        break
      case '--seed':
        options.seed = numeric(next(), '--seed', 0) >>> 0
        break
      case '--policy': {
        const value = next()
        /* Validated through the registry so an unknown policy fails before any battle runs. */
        policyById(value)
        options.policyId = value
        break
      }
      case '--mode': {
        const value = next() as SimulationMode
        if (!MODES.includes(value)) throw new Error(`--mode принимает ${MODES.join(' | ')}, получено: ${value}`)
        options.mode = value
        break
      }
      case '--turn-limit':
        options.turnLimit = numeric(next(), '--turn-limit', 1)
        break
      case '--out':
        options.outDir = next()
        break
      case '--date':
        options.date = next()
        break
      case '--commit':
        options.commit = next()
        break
      case '--scope':
        options.scope = next()
        break
      case '--no-write':
        options.write = false
        break
      case '--quiet':
        options.quiet = true
        break
      default:
        throw new Error(`Неизвестный флаг: ${flag}. Доступны: --runs --seed --policy (${POLICY_IDS.join('|')}) --mode (${MODES.join('|')}) --turn-limit --out --date --commit --scope --no-write --quiet`)
    }
  }
  return options
}

/**
 * Short SHA of the tree, from `SIMULATE_COMMIT`, then `GITHUB_SHA`, then `git rev-parse`. `null`
 * when none resolves — the report then says so instead of claiming an unverifiable provenance.
 * `execFileSync` with an argument array, never a shell string.
 */
export function resolveCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.SIMULATE_COMMIT ?? env.GITHUB_SHA
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().slice(0, 12)
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch {
    return null
  }
}

/**
 * The seed label: policy and arena, so no two run sets share a dice stream.
 *
 * `mode` is deliberately **not** part of the label. Encounter 1 has the same mission-start save in
 * both modes (a chain pass begins at campaign start, which is what `isolated` also uses), so
 * excluding the mode makes the two modes replay it battle for battle. That turns any difference in
 * the later encounters' numbers into a statement about carried HP/ammo/durability alone, and gives
 * a cross-mode equality that `cli.test.ts` asserts. Including the mode would have destroyed both
 * for no benefit.
 */
const seedLabel = (options: CliOptions, arenaId: string) => `${options.policyId}:${arenaId}`

/**
 * `isolated`: each encounter independently, from campaign-start gear.
 *
 * The save is built once per encounter and reused for every run — `simulateBattle` treats it as
 * immutable input and overrides `rngState`/`turn`/`phase`, so this is exactly N replays of the same
 * start state under N different dice streams.
 */
function runIsolated(content: SimulationContent, options: CliOptions, policy: Policy): ArenaResults[] {
  return orderedMissions(content).map((mission) => {
    const started = missionStart(content, progressTo(content, mission.id), mission.id)
    const results = Array.from({ length: options.runs }, (_unused, runIndex) =>
      simulateBattle({
        arena: started.arena,
        save: started.save,
        policy,
        seed: deriveSeed(options.seed, seedLabel(options, started.arena.id), runIndex),
        turnLimit: options.turnLimit,
        /* W6-01: measured against the encounter's real objective. Passed explicitly rather than
           defaulted, so a new encounter cannot be silently measured as an `eliminate`. */
        objective: objectiveFor(mission),
      }),
    )
    return { encounterId: mission.id, arenaId: started.arena.id, results }
  })
}

/**
 * `chain`: run index *i* is one campaign pass through every encounter in order, carrying HP, ammo,
 * jams and durability. A defeat ends that pass, so later encounters have fewer samples — and a
 * pass is not "restarted" to pad them, because that would report a survivability the game does not
 * offer.
 *
 * The reward claim between encounters is the shipped `awardRewardTransition`, so the stash grows
 * the way it does in the game. No repair and no healing happens between encounters: that is the
 * pessimistic bound, and the economy section reports what restoring would have cost.
 */
function runChain(content: SimulationContent, options: CliOptions, policy: Policy): ArenaResults[] {
  const sequence = orderedMissions(content)
  const collected = new Map<string, BattleResult[]>(sequence.map((mission) => [mission.id, []]))
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    let progress: CampaignProgress = campaignStart(content)
    for (const mission of sequence) {
      const started = missionStart(content, progress, mission.id)
      const result = simulateBattle({
        arena: started.arena,
        save: started.save,
        policy,
        seed: deriveSeed(options.seed, seedLabel(options, started.arena.id), runIndex),
        turnLimit: options.turnLimit,
        objective: objectiveFor(mission),
      })
      collected.get(mission.id)!.push(result)
      /*
       * A pass ends at the first non-win. The post-defeat campaign state is deliberately not
       * computed here: nothing reads it, because the pass is over. `resolveDefeat` exists in
       * `mission-save.ts` for the retry path and is asserted by the tests, not called from here.
       */
      if (result.outcome !== 'win') break
      progress = resolveVictory(content, started.progress, result.finalUnits)
    }
  }
  return sequence.map((mission) => ({
    encounterId: mission.id,
    arenaId: content.arenas.byId.get(mission.arenaId)!.id,
    results: collected.get(mission.id)!,
  }))
}

export interface SimulationRun {
  report: SimulationReport
  files: string[]
}

export async function runSimulation(options: CliOptions): Promise<SimulationRun> {
  const content = await loadSimulationContent(options.publicRoot)
  const policy = policyById(options.policyId)
  const arenaResults = options.mode === 'chain' ? runChain(content, options, policy) : runIsolated(content, options, policy)
  const report = buildReport(arenaResults, options, {
    commit: options.commit,
    contentCatalogId: content.catalogId,
    rewards: content.rewards,
    upgrades: content.upgrades,
    recipes: content.recipes,
    rewardIdByArena: new Map(orderedMissions(content).map((mission) => [mission.arenaId, mission.rewardId])),
  })
  const files: string[] = []
  if (options.write) {
    /* The subdirectory is created by whichever ticket first writes into it (design-data/README). */
    await mkdir(options.outDir, { recursive: true })
    const stem = `${options.date}-${options.scope}-${options.mode}-${options.policyId}-${options.seed}`
    const json = join(options.outDir, `${stem}.json`)
    const markdown = join(options.outDir, `${stem}.md`)
    await writeFile(json, renderJson(report), 'utf8')
    await writeFile(markdown, renderMarkdown(report), 'utf8')
    files.push(json, markdown)
  }
  return { report, files }
}

/** Short stdout summary; the artefacts hold the full numbers. */
export function summarize(run: SimulationRun): string {
  const { report } = run
  const lines = [
    `content=${report.contentCatalogId} commit=${report.commit ?? 'unknown'} seed=${report.seed} runs=${report.runs} policy=${report.policy} mode=${report.mode}`,
  ]
  for (const arena of report.arenas)
    lines.push(
      `  ${arena.encounterId.padEnd(22)} n=${String(arena.metrics.runs).padStart(4)} win=${(arena.metrics.winRate * 100).toFixed(1)}% turns=${arena.metrics.turnsMean.toFixed(2)} dmgTaken=${arena.metrics.damageTakenMean.toFixed(2)} hit=${(arena.metrics.hitRate * 100).toFixed(1)}% malf=${(arena.metrics.malfunctionRate * 100).toFixed(1)}%`,
    )
  lines.push(
    `  total                  n=${String(report.total.runs).padStart(4)} win=${(report.total.winRate * 100).toFixed(1)}% xp/pass=${report.economy.xpPerPassMean.toFixed(2)}/${report.economy.xpPerPassMax} bandageBalance=${report.economy.bandageBalancePerPassMean.toFixed(2)}`,
  )
  for (const file of run.files) lines.push(`  wrote ${file}`)
  return lines.join('\n')
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv)
    const options: CliOptions = { ...parsed, commit: parsed.commit ?? resolveCommit() }
    const run = await runSimulation(options)
    if (!options.quiet) process.stdout.write(`${summarize(run)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Executed only when this file *is* the entry point, so the test suite can import `runSimulation`
 * and `parseArgs` without running a simulation as an import side effect. `pathToFileURL` rather
 * than string concatenation: a repository path containing a space or `#` would not round-trip.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
