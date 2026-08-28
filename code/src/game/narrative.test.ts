/**
 * W7-03 — the narrative engine's contract, and the absence it has to tolerate.
 *
 * Every acceptance criterion of the ticket is a statement about *absence*: text arrives only as data, a missing file
 * breaks nothing, what was read persists. So most of these tests assert what happens when something is not there, and the
 * validator tests feed it broken catalogs to prove it complains rather than trusting that it would.
 *
 * There is **no shipped narrative** (`public/config/narrative.json` does not exist) — writing it is `W7-04` and belongs to
 * the owner. That is why the catalogs here are fixtures: they check the mechanism, not content.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_NARRATIVE,
  EMPTY_NARRATIVE_PROGRESS,
  NARRATIVE_STORAGE_KEY,
  NARRATIVE_TRIGGER_TYPES,
  hasRead,
  markRead,
  nodesForTrigger,
  parseNarrativeProgress,
  pendingNodes,
  serializeNarrativeProgress,
  validateNarrative,
  type NarrativeReferences,
} from './narrative'

const references: NarrativeReferences = {
  zoneIds: new Set(['near-perimeter', 'water-line']),
  encounterIds: new Set(['perimeter-checkpoint', 'water-cache']),
}

const node = (overrides: Record<string, unknown> = {}) => ({
  id: 'intro',
  trigger: { type: 'zone-enter', ref: 'near-perimeter' },
  lines: [{ speaker: 'Оперативник', text: 'Реплика-фикстура, не шиппящийся текст.' }],
  ...overrides,
})

const catalog = (entries: unknown[]) => ({ contentVersion: 1, kind: 'narrative', entries })

/* `refs` is a required argument, not a defaulted one: a default cannot express "explicitly no references", because
   passing `undefined` silently falls back to it — which is how the first version of the no-references test passed the
   shipped set instead of none. */
const unwrap = (input: unknown, refs?: NarrativeReferences) => {
  const result = validateNarrative(input, refs)
  if (!result.ok) throw result.error
  return result.value
}

const issuesOf = (input: unknown, refs: NarrativeReferences | undefined = references) => {
  const result = validateNarrative(input, refs)
  expect(result.ok, 'expected this catalog to be rejected').toBe(false)
  return result.ok ? [] : result.error.issues.map((issue) => issue.path)
}

describe('W7-03 the narrative format', () => {
  it('accepts a well-formed catalog for every trigger type', () => {
    const parsed = unwrap(
      catalog([
        node(),
        node({ id: 'after-checkpoint', trigger: { type: 'encounter-complete', ref: 'perimeter-checkpoint' } }),
        node({ id: 'home', trigger: { type: 'base-return' } }),
      ]),
      references,
    )
    expect(parsed.nodes.map((entry) => entry.id)).toEqual(['intro', 'after-checkpoint', 'home'])
    /* Every declared trigger type is exercised, so a type nobody covers cannot sit in the union untested. */
    expect(new Set(parsed.nodes.map((entry) => entry.trigger.type))).toEqual(new Set(NARRATIVE_TRIGGER_TYPES))
  })

  it('rejects a node pointing at a zone or encounter that does not exist', () => {
    /*
     * The rule that makes this validator worth having. A node referencing a missing zone is a line the player can never
     * see, and it looks perfectly valid in the file — exactly the class of defect `validate:content` exists to catch.
     */
    expect(issuesOf(catalog([node({ trigger: { type: 'zone-enter', ref: 'no-such-zone' } })]))).toContain(
      '$.entries[0].trigger.ref',
    )
    expect(
      issuesOf(catalog([node({ trigger: { type: 'encounter-complete', ref: 'no-such-encounter' } })])),
    ).toContain('$.entries[0].trigger.ref')
    /* And a zone id is not accepted where an encounter id is required: the two sets are checked separately. */
    expect(issuesOf(catalog([node({ trigger: { type: 'encounter-complete', ref: 'near-perimeter' } })]))).toContain(
      '$.entries[0].trigger.ref',
    )
  })

  it('checks the format without references, but then cannot check them', () => {
    /* `references` is optional so the shape can be validated in isolation; this pins that the cross-reference rule is the
       thing lost, so a caller omitting it is making a visible trade rather than an invisible one. */
    expect(unwrap(catalog([node({ trigger: { type: 'zone-enter', ref: 'no-such-zone' } })]), undefined).nodes).toHaveLength(1)
  })

  it('refuses a ref on base-return, which has nothing to filter by', () => {
    expect(issuesOf(catalog([node({ id: 'home', trigger: { type: 'base-return', ref: 'near-perimeter' } })]))).toContain(
      '$.entries[0].trigger.ref',
    )
  })

  it('rejects empty speakers, empty text and empty line lists', () => {
    /* All three render as a blank box on screen, which is why they are content errors rather than cosmetic ones. */
    expect(issuesOf(catalog([node({ lines: [] })]))).toContain('$.entries[0].lines')
    expect(issuesOf(catalog([node({ lines: [{ speaker: '', text: 'x' }] })]))).toContain('$.entries[0].lines[0].speaker')
    expect(issuesOf(catalog([node({ lines: [{ speaker: 'x', text: '   ' }] })]))).toContain('$.entries[0].lines[0].text')
  })

  it('rejects an unknown trigger type, a duplicate id and a wrong envelope', () => {
    expect(issuesOf(catalog([node({ trigger: { type: 'on-death', ref: 'near-perimeter' } })]))).toContain(
      '$.entries[0].trigger.type',
    )
    expect(issuesOf(catalog([node(), node()])).some((path) => path.includes('intro'))).toBe(true)
    expect(issuesOf({ contentVersion: 1, kind: 'missions', entries: [] })).toContain('$.kind')
  })

  it('reports every problem in one pass rather than only the first', () => {
    /* A validator that stops at the first issue turns one authoring session into several. */
    const paths = issuesOf(catalog([node({ id: '', lines: [{ speaker: '', text: '' }] })]))
    expect(paths.length).toBeGreaterThanOrEqual(3)
  })
})

describe('W7-03 trigger resolution', () => {
  const shipped = () =>
    unwrap(
      catalog([
        node({ id: 'zone-a', trigger: { type: 'zone-enter', ref: 'near-perimeter' } }),
        node({ id: 'zone-b', trigger: { type: 'zone-enter', ref: 'water-line' } }),
        node({ id: 'enc', trigger: { type: 'encounter-complete', ref: 'water-cache' } }),
        node({ id: 'home', trigger: { type: 'base-return' } }),
      ]),
      references,
    )

  it('returns only the nodes whose trigger and reference both match', () => {
    expect(nodesForTrigger(shipped(), { type: 'zone-enter', ref: 'near-perimeter' }).map((n) => n.id)).toEqual(['zone-a'])
    expect(nodesForTrigger(shipped(), { type: 'encounter-complete', ref: 'water-cache' }).map((n) => n.id)).toEqual(['enc'])
    expect(nodesForTrigger(shipped(), { type: 'base-return' }).map((n) => n.id)).toEqual(['home'])
    /* Matching type but different ref must not fire: this is the check that a zone's text stays in its zone. */
    expect(nodesForTrigger(shipped(), { type: 'zone-enter', ref: 'water-line' }).map((n) => n.id)).toEqual(['zone-b'])
  })

  it('returns nothing when no node matches, which is the shipped state', () => {
    /* There is no narrative catalog in the build, so this is the case that actually runs today. */
    expect(nodesForTrigger(EMPTY_NARRATIVE, { type: 'base-return' })).toEqual([])
    expect(nodesForTrigger(shipped(), { type: 'zone-enter', ref: 'unvisited-zone' })).toEqual([])
  })

  it('preserves catalog order instead of imposing one', () => {
    const ordered = unwrap(
      catalog([
        node({ id: 'second', trigger: { type: 'base-return' } }),
        node({ id: 'first', trigger: { type: 'base-return' } }),
      ]),
      references,
    )
    /* The author's sequence is the intended reading order; sorting here would silently override it. */
    expect(nodesForTrigger(ordered, { type: 'base-return' }).map((n) => n.id)).toEqual(['second', 'first'])
  })
})

describe('W7-03 read progress', () => {
  it('stores ids only, never a copy of the text', () => {
    /* Copying text into progress would make the save the second source of truth for content, so a later edit to a line
       would leave the old wording persisted. */
    const progress = markRead(EMPTY_NARRATIVE_PROGRESS, 'intro')
    expect(progress).toEqual({ readNodeIds: ['intro'] })
    expect(serializeNarrativeProgress(progress)).not.toContain('Реплика')
  })

  it('is idempotent and returns the same object when nothing changes', () => {
    const once = markRead(EMPTY_NARRATIVE_PROGRESS, 'intro')
    /* Reference equality, so a caller can skip a write when there is nothing to write. */
    expect(markRead(once, 'intro')).toBe(once)
    expect(markRead(once, '')).toBe(once)
    expect(hasRead(once, 'intro')).toBe(true)
    expect(hasRead(once, 'other')).toBe(false)
  })

  it('survives a round trip and tolerates anything unreadable', () => {
    const progress = markRead(markRead(EMPTY_NARRATIVE_PROGRESS, 'a'), 'b')
    expect(parseNarrativeProgress(serializeNarrativeProgress(progress))).toEqual(progress)
    /* Unread narrative is never a fatal state: corrupt storage degrades to "nothing read" rather than throwing. */
    for (const broken of [null, '', 'not json', '{}', '{"readNodeIds":"x"}', '[]'])
      expect(parseNarrativeProgress(broken), broken ?? 'null').toEqual(EMPTY_NARRATIVE_PROGRESS)
    /* A hand-edited file cannot smuggle in duplicates or non-strings. */
    expect(parseNarrativeProgress('{"readNodeIds":["a","a","",7]}')).toEqual({ readNodeIds: ['a'] })
  })

  it('lives outside the save, so a progress reset cannot erase it', () => {
    /* Same decision as `eden.tutorial.v1` and `eden.settings.v1`, and for the same reason: a player who restarts must not
       be shown the opening again. The key is asserted here because that is what the reset path skips. */
    expect(NARRATIVE_STORAGE_KEY).toBe('eden.narrative.v1')
    expect(NARRATIVE_STORAGE_KEY.startsWith('eden.save')).toBe(false)
  })

  it('shows a node once: pending excludes what was read', () => {
    /* Without this the persistence half is pointless — a `zone-enter` node would replay on every visit. */
    const parsed = unwrap(catalog([node({ id: 'intro' }), node({ id: 'intro-2' })]), references)
    const trigger = { type: 'zone-enter' as const, ref: 'near-perimeter' }
    expect(pendingNodes(parsed, EMPTY_NARRATIVE_PROGRESS, trigger).map((n) => n.id)).toEqual(['intro', 'intro-2'])
    const afterFirst = markRead(EMPTY_NARRATIVE_PROGRESS, 'intro')
    expect(pendingNodes(parsed, afterFirst, trigger).map((n) => n.id)).toEqual(['intro-2'])
    const afterBoth = markRead(afterFirst, 'intro-2')
    expect(pendingNodes(parsed, afterBoth, trigger)).toEqual([])
  })
})
