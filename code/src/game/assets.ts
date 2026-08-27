/**
 * W8-02 — the asset registry and its fallbacks.
 *
 * ## Why this exists before any art does
 *
 * The repository ships **zero** production assets (`art/` holds only a README), and decision D-06 chose to release on
 * placeholders. So the requirement this module implements is not "load art" but the one doc 19 and doc 23 §7 actually
 * state: *a missing asset file must never break the game*. Every id the game asks for resolves to something drawable —
 * either a delivered file or a procedural fallback derived from design tokens — and that is a property of
 * `resolveAsset`, not of a caller remembering to check.
 *
 * ## The two id sets, and why the test compares them
 *
 * Doc 23 §7 rule 5 requires the ids used *in code* and the ids in the registry to be equal as sets. That is only
 * checkable if the code's side is written down, so `ASSET_IDS` below is the declaration: it is the game's request for
 * art, and `art/registry.json` is the answer. An id in the code with no registry entry is an asset nobody is tracking a
 * licence for; an entry with no code reference is dead weight that will rot. Both are defects and both fail the test.
 *
 * ## What a `license` means on an undelivered entry
 *
 * Rule 1 rejects an entry without `author` and `license`, because doc 19 forbids using an external asset without a
 * locally verified licence. Today no entry has a file: `path` is the reserved location and the licence describes the
 * **fallback**, which is drawn by this code from tokens and therefore belongs to the project. `validateAssetRegistry`
 * enforces the part that matters as art arrives: an entry whose file is actually present may not keep the placeholder
 * licence. Without that rule the placeholder text would quietly become the licence of record for real, external art.
 */
import { COLORS, COLORS_EXTENDED } from '../tokens'

/** Asset categories, matching the subdirectories `art/README.md` reserves. */
export type AssetKind = 'unit' | 'tile' | 'icon' | 'effect'

/**
 * A fallback that is guaranteed drawable without any file.
 *
 * `shape` fills a silhouette; `letter` draws a single glyph, which is what makes a UI icon legible without art. Both
 * carry `color` as a **token reference** (`token:accent`), never a literal hex — doc 23 §7 rule 6. A literal here would
 * reintroduce exactly the parallel palette W8-01 removed.
 */
export interface AssetFallback {
  type: 'shape' | 'letter'
  /** `token:<name>` resolved against the shipped tokens by `resolveFallbackColor`. */
  color: string
  /** Required for `letter`, ignored otherwise. A single character: an icon is not a place for a word. */
  glyph?: string
  /** Whether the fallback is monochrome. Doc 23 §7 rule 3 requires it for every icon. */
  monochrome?: boolean
}

export interface AssetEntry {
  id: string
  kind: AssetKind
  /** Reserved path. May not exist: that is the normal state today and must stay non-fatal. */
  path: string
  size?: { width: number; height: number }
  states?: readonly string[]
  author: string
  license: string
  fallback: AssetFallback
}

export interface AssetRegistry {
  contentVersion: number
  kind: 'asset-registry'
  entries: readonly AssetEntry[]
}

/**
 * The licence/author text reserved for entries that have no file yet.
 *
 * Named so `validateAssetRegistry` can refuse to let it survive the arrival of a real file, and so a reader can tell a
 * placeholder from a verified licence at a glance.
 */
export const PLACEHOLDER_LICENSE = 'project-placeholder'
export const PLACEHOLDER_AUTHOR = 'EDEN (procedural fallback)'

/**
 * States that must never be invisible, from doc 19 via doc 23 §7 rule 4.
 *
 * These are combat readouts: if a hit, a miss, an armour save, a status, an overwatch trigger or a malfunction fails to
 * render, the player cannot tell what happened to them. Every one needs an `effect` entry with a fallback.
 */
export const CRITICAL_EFFECT_STATES = ['hit', 'miss', 'armor', 'status', 'overwatch', 'malfunction'] as const

/**
 * Every asset id the game asks for. **The code's half of doc 23 §7 rule 5.**
 *
 * Derived from what the shipped game actually renders: a silhouette per team, a tile per shipped zone, the six critical
 * combat effects, and the UI icons the combat screen needs. Adding a rendered asset without listing it here fails the
 * registry test rather than shipping an untracked, unlicensed image.
 */
export const ASSET_IDS = [
  'unit-hero',
  'unit-enemy',
  'tile-near-perimeter',
  'tile-water-line',
  ...CRITICAL_EFFECT_STATES.map((state) => `effect-${state}`),
  'icon-ammo',
  'icon-durability',
  'icon-objective',
] as const

export type AssetId = (typeof ASSET_IDS)[number]

const TOKEN_PREFIX = 'token:'
const tokenTable: Record<string, string> = { ...COLORS, ...COLORS_EXTENDED }

/**
 * Resolves `token:name` to the shipped hex value.
 *
 * Returns `null` for anything else, including a literal hex, so a registry that hardcodes a colour is a validation
 * failure rather than a silently accepted second palette.
 */
export const resolveFallbackColor = (color: string): string | null =>
  color.startsWith(TOKEN_PREFIX) ? tokenTable[color.slice(TOKEN_PREFIX.length)] ?? null : null

export interface AssetIssue {
  /** Registry path of the problem, e.g. `entries[3].license`. */
  path: string
  message: string
}

/**
 * Validates a registry against doc 23 §7, returning every problem rather than the first.
 *
 * `deliveredPaths` is the set of asset paths that actually exist on disk. It is a parameter rather than a filesystem
 * call so this stays pure and usable in the browser; the test supplies the real listing. Its only job is rule 1's
 * teeth: a present file may not ship under the placeholder licence.
 */
export function validateAssetRegistry(
  registry: AssetRegistry,
  deliveredPaths: ReadonlySet<string> = new Set(),
): AssetIssue[] {
  const issues: AssetIssue[] = []
  if (registry.kind !== 'asset-registry') issues.push({ path: 'kind', message: 'ожидается asset-registry' })
  if (!Number.isInteger(registry.contentVersion) || registry.contentVersion < 1)
    issues.push({ path: 'contentVersion', message: 'целое >= 1' })

  const seen = new Set<string>()
  registry.entries.forEach((entry, index) => {
    const at = `entries[${index}]`
    if (!entry.id) issues.push({ path: `${at}.id`, message: 'непустой id' })
    else if (seen.has(entry.id)) issues.push({ path: `${at}.id`, message: `дублирующийся id ${entry.id}` })
    else seen.add(entry.id)

    /* Rule 1: no entry without an author and a licence. */
    if (!entry.author) issues.push({ path: `${at}.author`, message: 'обязателен (doc 19: без автора ассет не используется)' })
    if (!entry.license) issues.push({ path: `${at}.license`, message: 'обязательна (doc 19: без проверенной лицензии ассет не используется)' })
    /* Rule 1's teeth: once the file exists, the placeholder licence is no longer the truth about it. */
    if (deliveredPaths.has(entry.path) && (entry.license === PLACEHOLDER_LICENSE || entry.author === PLACEHOLDER_AUTHOR))
      issues.push({
        path: `${at}.license`,
        message: `файл ${entry.path} поставлен, но лицензия/автор всё ещё placeholder — укажите проверенную лицензию`,
      })

    /* Rule 2: a fallback is mandatory, because a missing file must not break the game. */
    if (!entry.fallback) {
      issues.push({ path: `${at}.fallback`, message: 'обязателен: отсутствие файла не имеет права ломать игру' })
      return
    }
    if (entry.fallback.type !== 'shape' && entry.fallback.type !== 'letter')
      issues.push({ path: `${at}.fallback.type`, message: 'shape | letter' })
    /* Rule 6: fallback colours are token references, never literals. */
    if (resolveFallbackColor(entry.fallback.color) === null)
      issues.push({ path: `${at}.fallback.color`, message: `ссылка token:* на существующий токен, получено ${entry.fallback.color}` })
    if (entry.fallback.type === 'letter' && [...(entry.fallback.glyph ?? '')].length !== 1)
      issues.push({ path: `${at}.fallback.glyph`, message: 'ровно один символ' })
    /* Rule 3: every UI icon needs a monochrome fallback. */
    if (entry.kind === 'icon' && entry.fallback.monochrome !== true)
      issues.push({ path: `${at}.fallback.monochrome`, message: 'иконка обязана иметь монохромный fallback (doc 19)' })
  })

  /* Rule 4: none of the critical combat states may be missing. */
  for (const state of CRITICAL_EFFECT_STATES)
    if (!registry.entries.some((entry) => entry.id === `effect-${state}` && entry.kind === 'effect'))
      issues.push({ path: `entries.effect-${state}`, message: 'критическое состояние обязано иметь запись с fallback' })

  return issues
}

/** What a renderer should draw for an asset: the file when it exists, otherwise the fallback. */
export type ResolvedAsset =
  | { source: 'file'; path: string }
  | { source: 'fallback'; type: 'shape' | 'letter'; color: string; glyph?: string }

/**
 * Resolves one asset id to something drawable. **Total: never throws and never returns null.**
 *
 * That totality is the ticket's criterion 1. Three separate things can be missing — the entry, the file, or a sane
 * fallback colour — and each has a defined answer, so no caller needs a null check that a future refactor could drop:
 *
 *   - no file → the entry's fallback;
 *   - no entry at all → a neutral shape in the muted text colour, so an unregistered id renders as an obvious grey
 *     placeholder instead of vanishing. The registry *test* is what makes this case a build failure; at runtime it must
 *     still draw something.
 */
export function resolveAsset(
  registry: AssetRegistry,
  id: string,
  deliveredPaths: ReadonlySet<string> = new Set(),
): ResolvedAsset {
  const entry = registry.entries.find((candidate) => candidate.id === id)
  if (!entry) return { source: 'fallback', type: 'shape', color: COLORS.textMuted }
  if (deliveredPaths.has(entry.path)) return { source: 'file', path: entry.path }
  const color = resolveFallbackColor(entry.fallback.color) ?? COLORS.textMuted
  return entry.fallback.type === 'letter'
    ? { source: 'fallback', type: 'letter', color, glyph: entry.fallback.glyph }
    : { source: 'fallback', type: 'shape', color }
}

/** Parses and validates an unknown payload as a registry. Throws with every issue listed, like the content loaders. */
export function parseAssetRegistry(payload: unknown, deliveredPaths?: ReadonlySet<string>): AssetRegistry {
  const registry = payload as AssetRegistry
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.entries))
    throw new Error('Реестр ассетов: ожидается объект с массивом entries.')
  const issues = validateAssetRegistry(registry, deliveredPaths)
  if (issues.length)
    throw new Error(`Реестр ассетов невалиден:\n${issues.map((issue) => `  ${issue.path} — ${issue.message}`).join('\n')}`)
  return registry
}
