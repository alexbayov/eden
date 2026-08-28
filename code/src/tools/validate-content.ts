/**
 * W7-02 — `npm run validate:content`: one command that finds broken content before the game runs.
 *
 * **Why this exists at all.** Every validator it calls already shipped, but they were only reachable through
 * the app's boot path or a test. So a content author's feedback loop was "start the game and read a recovery
 * screen", and a broken reference in `missions.json` was indistinguishable from a bug in the shell.
 *
 * **The one rule this file must not break: it validates through the runtime's own functions.** Not a copy of
 * them — the actual `validateArenaContent`, `validateCampaignCatalog`, `validateEquipmentCatalog`,
 * `validateProgression`, and `findReachable` behind the playability checks. A second implementation would drift,
 * and a validator that disagrees with the game is worse than none: it would either block valid content or pass
 * content the player cannot finish. Every cross-file check is the same call `app.tsx` makes at boot, including
 * the arena-bounds pass W6-01 added.
 *
 * **Exit codes.** `0` clean, `1` errors found, `2` the validator itself could not run (missing file, bad JSON).
 * Distinguishing 1 from 2 matters in CI: "your content is wrong" and "the checker is broken" need different
 * responses, and collapsing them is how a red build gets ignored.
 *
 * Usage:
 *
 *   npm run validate:content
 *   npm run validate:content -- --strict-playability
 *   npm run validate:content -- --json
 */
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  validateBaseUpgrades,
  validateCampaignCatalog,
  validateItemEffects,
  validateItems,
  validateMissions,
  validateRecipes,
  validateRewards,
  validateReturnTables,
  validateZones,
  type MissionDefinition,
} from '../game/campaign-content'
import { validateNarrative, type NarrativeCatalog } from '../game/narrative'
import { parseArenaContent, validateArenaCatalog, validateArenaManifest, type ArenaContent } from '../game/content'
import { parseEquipmentCatalog } from '../game/equipment-content'
import { validateProgression } from '../game/progression'
import { checkPlayability, hasBlockingIssues, type PlayabilityIssue } from '../game/playability'

const CONFIG_DIR = fileURLToPath(new URL('../../public/config/', import.meta.url))

export interface ValidationFinding {
  /** File or logical group the finding belongs to. */
  source: string
  /** `$.entries[2].objectiveParams` and similar, from the runtime validators. */
  path: string
  message: string
  level: 'error' | 'warning'
}

export interface ValidationReport {
  findings: ValidationFinding[]
  /** Files actually read, so a silently skipped file is visible. */
  filesChecked: string[]
  strict: boolean
}

const errorFinding = (source: string, path: string, message: string): ValidationFinding => ({
  source,
  path,
  message,
  level: 'error',
})

/** Reads and parses one config file. A missing or malformed file is a hard stop, not a finding. */
async function readConfig(name: string): Promise<unknown> {
  const raw = await readFile(join(CONFIG_DIR, name), 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    /* `cause` preserved so a parse failure keeps its original stack: the message alone does not say *where* in
       the file the JSON broke, and that is the first thing an author needs. */
    throw new Error(`${name}: некорректный JSON — ${(error as Error).message}`, { cause: error })
  }
}

/** Turns a runtime `ContentResult` into findings, so every validator reports the same way. */
function collect<T>(
  source: string,
  result: { ok: true; value: T } | { ok: false; error: { issues?: { path: string; message: string }[]; message: string } },
  findings: ValidationFinding[],
): T | null {
  if (result.ok) return result.value
  const issues = result.error.issues ?? []
  if (issues.length) for (const issue of issues) findings.push(errorFinding(source, issue.path, issue.message))
  else findings.push(errorFinding(source, '$', result.error.message))
  return null
}

/**
 * Validates every file in `public/config`, exactly as the game would load it.
 *
 * Ordered by dependency: leaf catalogs first, then the cross-file pass that needs all of them, then playability
 * which needs the arenas *and* the objectives. A failure early on does not stop the run — an author is better
 * served by one complete list than by fixing one error at a time.
 */
export async function validateContent(options: { strict?: boolean } = {}): Promise<ValidationReport> {
  const strict = options.strict ?? false
  const findings: ValidationFinding[] = []
  const filesChecked: string[] = []

  const read = async (name: string) => {
    filesChecked.push(name)
    return readConfig(name)
  }

  /* Leaf catalogs, each through its own shipped validator. */
  const zones = collect('zones.json', validateZones(await read('zones.json')), findings)
  const missions = collect('missions.json', validateMissions(await read('missions.json')), findings)
  const rewards = collect('rewards.json', validateRewards(await read('rewards.json')), findings)
  const items = collect('items.json', validateItems(await read('items.json')), findings)
  const recipes = collect('recipes.json', validateRecipes(await read('recipes.json')), findings)
  const upgrades = collect('base-upgrades.json', validateBaseUpgrades(await read('base-upgrades.json')), findings)
  const itemEffects = collect('item-effects.json', validateItemEffects(await read('item-effects.json')), findings)
  const returnTables = collect('return-tables.json', validateReturnTables(await read('return-tables.json')), findings)
  const progression = collect('progression.json', validateProgression(await read('progression.json')), findings)

  /*
   * W7-03 — narrative, whose **absence is valid** and is the shipped state: `W7-04` has written no story yet.
   *
   * Read separately from `read()` because that helper treats a missing file as a hard stop, which is right for every
   * catalog above (a build without missions is broken) and wrong here. Only `ENOENT` is absence; a malformed file is still
   * a hard error, so a typo in the narrative cannot silently delete it.
   */
  let narrative: NarrativeCatalog | null = null
  try {
    const raw = await readFile(join(CONFIG_DIR, 'narrative.json'), 'utf8')
    filesChecked.push('narrative.json')
    const refs =
      zones && missions
        ? { zoneIds: new Set(zones.map((zone) => zone.id)), encounterIds: new Set(missions.map((mission) => mission.id)) }
        : undefined
    narrative = collect('narrative.json', validateNarrative(JSON.parse(raw) as unknown, refs), findings)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      findings.push(errorFinding('narrative.json', '$', (error as Error).message))
  }

  /* Equipment and arenas throw rather than returning a result, so they are wrapped. */
  let equipment: ReturnType<typeof parseEquipmentCatalog> | null = null
  try {
    filesChecked.push('equipment.json')
    equipment = parseEquipmentCatalog(await readConfig('equipment.json'))
  } catch (error) {
    findings.push(errorFinding('equipment.json', '$', (error as Error).message))
  }

  /* Stated rather than silent: a reader must be able to tell "narrative is clean" from "there is no narrative". */
  if (!narrative)
    findings.push({
      source: 'narrative.json',
      path: '$',
      level: 'warning',
      message: 'нарративного каталога нет — это ожидаемое состояние: тексты пишет W7-04, а движок (W7-03) работает без них',
    })

  const manifest = collect('arena-manifest.json', validateArenaManifest(await read('arena-manifest.json')), findings)
  const arenas: ArenaContent[] = []
  if (manifest)
    for (const entry of manifest.entries) {
      const file = entry.path.replace(/^\/config\//, '')
      try {
        filesChecked.push(file)
        const arena = parseArenaContent(await readConfig(file))
        if (arena.id !== entry.id)
          findings.push(
            errorFinding(file, '$.id', `id карты "${arena.id}" не совпадает с manifest "${entry.id}"`),
          )
        arenas.push(arena)
      } catch (error) {
        findings.push(errorFinding(file, '$', (error as Error).message))
      }
    }

  /*
   * Files present on disk but absent from the manifest.
   *
   * A warning rather than an error, and never promoted to one: this exact class of file caused real trouble —
   * three duplicates carried the *ids of live maps* with different data, so editing one had no effect on the
   * game — but not every unreferenced file is stale. `arena.json` is a live fixture three test suites read
   * straight off disk, and deleting it fails four tests. So the check reports the ambiguity and names the
   * distinction instead of pretending it can tell them apart.
   */
  try {
    const present = (await readdir(CONFIG_DIR)).filter((name) => name.endsWith('.json'))
    const referenced = new Set([...filesChecked])
    for (const name of present)
      if (!referenced.has(name))
        findings.push({
          source: name,
          path: '$',
          message:
            'файл не читается ни manifest, ни загрузчиком игры. Это либо тестовая фикстура (как arena.json), либо устаревший дубликат — проверьте, читает ли его хоть один тест, прежде чем удалять',
          level: 'warning',
        })
  } catch (error) {
    findings.push(errorFinding('public/config', '$', `не удалось прочитать каталог: ${(error as Error).message}`))
  }

  /* The cross-file pass — the same call `app.tsx` makes at boot, arena bounds included. */
  if (zones && missions && rewards && items && recipes && upgrades && itemEffects && returnTables) {
    const arenaIds = new Set(arenas.map((arena) => arena.id))
    /* `validateArenaCatalog` throws rather than returning a result, so it is wrapped like the equipment parse. */
    if (manifest)
      try {
        validateArenaCatalog(manifest, arenas, new Set(missions.map((mission) => mission.arenaId)))
      } catch (error) {
        findings.push(errorFinding('arena-manifest.json', '$', (error as Error).message))
      }
    collect(
      'cross-file',
      validateCampaignCatalog(
        { zones, missions, rewards, items, recipes, upgrades, itemEffects, returnTables },
        arenaIds,
        new Set(items.map((item) => item.id)),
        {
          ...(equipment
            ? {
                equipmentIds: new Set([
                  ...equipment.weapons.map((entry) => entry.id),
                  ...equipment.armor.map((entry) => entry.id),
                ]),
                ammoIds: new Set(equipment.ammo.map((entry) => entry.id)),
              }
            : {}),
          arenaBounds: new Map(arenas.map((arena) => [arena.id, { width: arena.width, height: arena.height }])),
        },
      ),
      findings,
    )
  }

  /* Playability, per map, with the objective the map is played under when one is known. */
  const objectiveFor = (arenaId: string): MissionDefinition | undefined =>
    missions?.find((mission) => mission.arenaId === arenaId)
  for (const arena of arenas) {
    const mission = objectiveFor(arena.id)
    const issues: PlayabilityIssue[] = checkPlayability({
      arena,
      objective: mission?.objectiveParams,
      strict,
    })
    for (const issue of issues)
      findings.push({ source: `${arena.id}`, path: issue.id, message: issue.message, level: issue.level })
  }

  void progression
  return { findings, filesChecked, strict }
}

export const errorsOf = (report: ValidationReport) => report.findings.filter((entry) => entry.level === 'error')
export const warningsOf = (report: ValidationReport) => report.findings.filter((entry) => entry.level === 'warning')

/** Human-readable output. Errors first, because that is what has to be fixed. */
export function renderReport(report: ValidationReport): string {
  const errors = errorsOf(report)
  const warnings = warningsOf(report)
  const lines: string[] = []
  lines.push(`Проверено файлов: ${report.filesChecked.length}${report.strict ? ' (strict-playability)' : ''}`)
  for (const finding of [...errors, ...warnings])
    lines.push(`${finding.level === 'error' ? 'ОШИБКА' : 'предупреждение'} ${finding.source} ${finding.path} — ${finding.message}`)
  lines.push(
    errors.length
      ? `\nИтог: ${errors.length} ошибок, ${warnings.length} предупреждений.`
      : `\nИтог: контент валиден. Предупреждений: ${warnings.length}.`,
  )
  return lines.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict-playability')
  const asJson = argv.includes('--json')
  const unknown = argv.filter((flag) => !['--strict-playability', '--json'].includes(flag))
  if (unknown.length) {
    process.stderr.write(`Неизвестные флаги: ${unknown.join(' ')}\n`)
    process.exit(2)
  }
  try {
    const report = await validateContent({ strict })
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`)
    /* Exit 1 only on errors: warnings are advisory and must not block a build. */
    process.exit(errorsOf(report).length ? 1 : 0)
  } catch (error) {
    /* Exit 2: the validator could not run at all, which is a different problem from invalid content. */
    process.stderr.write(`Валидатор не смог выполниться: ${(error as Error).message}\n`)
    process.exit(2)
  }
}

export { hasBlockingIssues }
