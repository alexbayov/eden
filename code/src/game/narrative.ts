/**
 * W7-03 — the narrative node engine. **Deliberately shipped with no narrative.**
 *
 * ## What this is and what it is not
 *
 * The ticket's own goal is "движок подачи текста, не сами тексты", and none of its four acceptance criteria requires a
 * single line of dialogue. What it requires is that *absence* works: text arrives only as data, a missing narrative file
 * breaks nothing, what was read persists. So this module is the mechanism, and `public/config/narrative.json` does **not
 * exist** — writing the story is `W7-04` and belongs to the owner, not to me. Same shape as `W8-02` (an asset registry
 * with zero assets) and `W10-02` (a platform boundary with no SDK).
 *
 * ## Why a missing file is a success and not an error
 *
 * `fetchContent` throws `ContentLoadError` on a 404, which is right for `missions.json` — a campaign without missions is
 * a broken build. Narrative is the opposite: today its absence is the shipped state, and after `W7-04` a build that
 * simply has no narrative for a given zone must still run. `loadNarrative` therefore treats 404 as an empty catalog and
 * **only** 404 — a malformed file, a 500 or a parse failure still fail loudly, because those are broken content rather
 * than absent content. Collapsing the two would mean a typo in the narrative silently removes the story.
 *
 * ## Why "read" is real state
 *
 * `W7-05` derives tutorial progress from the board instead of storing it, on purpose. That is impossible here: "the
 * player has read this line" cannot be recovered from the game state. So it is genuine new state, kept as small as it can
 * be — a set of ids, never a copy of the text — and stored **outside** `SaveData` under its own key, exactly like
 * `eden.tutorial.v1` and `eden.settings.v1`. The reason is the same one those two have: narrative already read must
 * survive a progress reset, or a player who restarts is shown the opening again.
 */
import { checkEnvelope, ContentValidationError, type ContentIssue, type ContentResult } from './content-format'

/** When a node fires. Matches the contract proposed in the ticket. */
export type NarrativeTriggerType = 'zone-enter' | 'encounter-complete' | 'base-return'

export const NARRATIVE_TRIGGER_TYPES: readonly NarrativeTriggerType[] = [
  'zone-enter',
  'encounter-complete',
  'base-return',
]

export interface NarrativeTrigger {
  type: NarrativeTriggerType
  /**
   * Zone id for `zone-enter`, encounter id for `encounter-complete`, and absent for `base-return`.
   *
   * `base-return` has no reference because returning to base is not parameterised by anything the player chose; giving it
   * a `ref` would invent a dimension the game does not have.
   */
  ref?: string
}

export interface NarrativeLine {
  speaker: string
  text: string
}

export interface NarrativeNode {
  id: string
  trigger: NarrativeTrigger
  lines: NarrativeLine[]
}

export interface NarrativeCatalog {
  nodes: readonly NarrativeNode[]
}

/** The empty catalog, which is both the shipped state today and the fallback when no file exists. */
export const EMPTY_NARRATIVE: NarrativeCatalog = { nodes: [] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/**
 * References a narrative catalog is allowed to point at.
 *
 * Passed in rather than imported so this module never grows a dependency on the campaign catalog: the validator's job is
 * to check the *references*, and the set of valid ids is the caller's knowledge. That also makes the cross-reference
 * check testable without loading the whole game.
 */
export interface NarrativeReferences {
  zoneIds: ReadonlySet<string>
  encounterIds: ReadonlySet<string>
}

const checkNode = (
  value: unknown,
  path: string,
  issues: ContentIssue[],
  references: NarrativeReferences | undefined,
): NarrativeNode | null => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'объект нарративного узла' })
    return null
  }
  const before = issues.length
  if (!isNonEmptyString(value.id)) issues.push({ path: `${path}.id`, message: 'непустой id' })

  if (!isRecord(value.trigger)) issues.push({ path: `${path}.trigger`, message: 'объект триггера' })
  else {
    const type = value.trigger.type
    if (typeof type !== 'string' || !NARRATIVE_TRIGGER_TYPES.includes(type as NarrativeTriggerType))
      issues.push({ path: `${path}.trigger.type`, message: NARRATIVE_TRIGGER_TYPES.join(' | ') })
    else if (type === 'base-return') {
      /* No `ref` to give: see `NarrativeTrigger`. Accepting one would let content believe it filters by something. */
      if (value.trigger.ref !== undefined)
        issues.push({ path: `${path}.trigger.ref`, message: 'base-return не принимает ref' })
    } else if (!isNonEmptyString(value.trigger.ref))
      issues.push({ path: `${path}.trigger.ref`, message: 'непустая ссылка на зону или encounter' })
    else if (references) {
      /* The cross-reference check, and the reason this validator is worth having: a node pointing at a zone that does not
         exist is a line the player can never see, and it looks perfectly valid in the file. */
      const known = type === 'zone-enter' ? references.zoneIds : references.encounterIds
      if (!known.has(value.trigger.ref))
        issues.push({
          path: `${path}.trigger.ref`,
          message: `неизвестный ${type === 'zone-enter' ? 'id зоны' : 'id encounter'}: ${value.trigger.ref}`,
        })
    }
  }

  const lines = Array.isArray(value.lines) ? value.lines : null
  if (!lines) issues.push({ path: `${path}.lines`, message: 'массив реплик' })
  else if (lines.length === 0) issues.push({ path: `${path}.lines`, message: 'хотя бы одна реплика' })
  else
    lines.forEach((line, index) => {
      if (!isRecord(line)) {
        issues.push({ path: `${path}.lines[${index}]`, message: 'объект реплики' })
        return
      }
      /* Empty speaker or text is content that renders as a blank box; rejected here rather than discovered on screen. */
      if (!isNonEmptyString(line.speaker)) issues.push({ path: `${path}.lines[${index}].speaker`, message: 'непустая строка' })
      if (!isNonEmptyString(line.text)) issues.push({ path: `${path}.lines[${index}].text`, message: 'непустая строка' })
    })

  if (issues.length !== before) return null
  return {
    id: value.id as string,
    trigger: {
      type: (value.trigger as Record<string, unknown>).type as NarrativeTriggerType,
      ...((value.trigger as Record<string, unknown>).ref === undefined
        ? {}
        : { ref: (value.trigger as Record<string, unknown>).ref as string }),
    },
    lines: (lines as Record<string, unknown>[]).map((line) => ({
      speaker: line.speaker as string,
      text: line.text as string,
    })),
  }
}

/**
 * Validates a narrative payload, reporting every problem rather than the first.
 *
 * `references` is optional so the format can be checked without a campaign catalog, but every shipped caller passes it:
 * without it the most valuable rule — that a node points at a zone or encounter that exists — is not applied.
 */
export function validateNarrative(input: unknown, references?: NarrativeReferences): ContentResult<NarrativeCatalog> {
  const envelope = checkEnvelope(input)
  if (!envelope.ok) return envelope
  const issues: ContentIssue[] = []
  const record = envelope.value as Record<string, unknown>
  if (record.kind !== 'narrative') issues.push({ path: '$.kind', message: 'narrative' })
  const entries = Array.isArray(record.entries) ? record.entries : null
  if (!entries) issues.push({ path: '$.entries', message: 'массив узлов' })
  const nodes: NarrativeNode[] = []
  entries?.forEach((entry, index) => {
    const node = checkNode(entry, `$.entries[${index}]`, issues, references)
    if (node) nodes.push(node)
  })
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) issues.push({ path: `$.entries.${node.id}`, message: 'дублирующийся id' })
    seen.add(node.id)
  }
  return issues.length
    ? { ok: false, error: new ContentValidationError('shape', issues) }
    : { ok: true, value: { nodes } }
}

/**
 * Nodes that fire for a trigger, in catalog order.
 *
 * Catalog order rather than sorted: the author's sequence is the intended reading order, and imposing an ordering here
 * would silently override it. Returns an empty array when nothing matches, which is the normal case on the shipped
 * build — there is no narrative at all.
 */
export function nodesForTrigger(
  catalog: NarrativeCatalog,
  trigger: NarrativeTrigger,
): NarrativeNode[] {
  return catalog.nodes.filter(
    (node) => node.trigger.type === trigger.type && (node.trigger.ref ?? null) === (trigger.ref ?? null),
  )
}

/** Storage key for what the player has already read. Versioned like every other preference key. */
export const NARRATIVE_STORAGE_KEY = 'eden.narrative.v1'

export interface NarrativeProgress {
  /** Ids already shown. Ids only — never a copy of the text, which lives in the catalog. */
  readNodeIds: readonly string[]
}

export const EMPTY_NARRATIVE_PROGRESS: NarrativeProgress = { readNodeIds: [] }

/** Parses stored progress, falling back to empty on anything unreadable: unread narrative is never a fatal state. */
export function parseNarrativeProgress(raw: string | null): NarrativeProgress {
  if (!raw) return EMPTY_NARRATIVE_PROGRESS
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.readNodeIds)) return EMPTY_NARRATIVE_PROGRESS
    /* Deduplicated and filtered, so a hand-edited file cannot make the set grow without bound or hold non-strings. */
    return { readNodeIds: [...new Set(parsed.readNodeIds.filter(isNonEmptyString))] }
  } catch {
    return EMPTY_NARRATIVE_PROGRESS
  }
}

export const serializeNarrativeProgress = (progress: NarrativeProgress) => JSON.stringify(progress)

export const hasRead = (progress: NarrativeProgress, nodeId: string) => progress.readNodeIds.includes(nodeId)

/** Marks a node read. Idempotent, and returns the same object when nothing changes so callers can compare by reference. */
export function markRead(progress: NarrativeProgress, nodeId: string): NarrativeProgress {
  if (!isNonEmptyString(nodeId) || hasRead(progress, nodeId)) return progress
  return { readNodeIds: [...progress.readNodeIds, nodeId] }
}

/**
 * Nodes that should be shown now: fired by the trigger and not yet read.
 *
 * The whole point of the persistence half — without it a `zone-enter` node would replay on every visit to the zone.
 */
export const pendingNodes = (
  catalog: NarrativeCatalog,
  progress: NarrativeProgress,
  trigger: NarrativeTrigger,
): NarrativeNode[] => nodesForTrigger(catalog, trigger).filter((node) => !hasRead(progress, node.id))
