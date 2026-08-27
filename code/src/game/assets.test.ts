/**
 * W8-02 — the asset registry as a contract, checked against the shipped `art/registry.json`.
 *
 * The ticket's five criteria are all statements about *absence*: the game must stay playable with no art at all. So most
 * of these tests assert what happens when a file is missing, and the falsifiability checks feed the validator broken
 * registries to prove it complains rather than trusting that it would.
 *
 * The registry is read from disk rather than fixtured, because a validator that only ever sees hand-built objects proves
 * nothing about the file the game ships.
 */
import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ASSET_IDS,
  CRITICAL_EFFECT_STATES,
  PLACEHOLDER_AUTHOR,
  PLACEHOLDER_LICENSE,
  parseAssetRegistry,
  resolveAsset,
  resolveFallbackColor,
  validateAssetRegistry,
  type AssetEntry,
  type AssetRegistry,
} from './assets'
import { COLORS } from '../tokens'

const registry = parseAssetRegistry(JSON.parse(readFileSync('../art/registry.json', 'utf8')))

/** Paths that actually exist on disk. Empty today, and criterion 5 is about exactly that state. */
const deliveredPaths = new Set(registry.entries.map((entry) => entry.path).filter((path) => existsSync(`../${path}`)))

/** A deep copy of the shipped registry with one thing broken, for the falsifiability checks. */
type MutableRegistry = { contentVersion: number; kind: 'asset-registry'; entries: AssetEntry[] }
const withEntries = (change: (entries: AssetEntry[]) => void): AssetRegistry => {
  const draft = structuredClone(registry) as MutableRegistry
  change(draft.entries)
  return draft
}

describe('W8-02 the shipped registry satisfies doc 23 §7', () => {
  it('parses and has no validation issues', () => {
    expect(validateAssetRegistry(registry, deliveredPaths)).toEqual([])
  })

  it('gives every entry an author and a licence (criterion 2)', () => {
    for (const entry of registry.entries) {
      expect(entry.author.length, `${entry.id} author`).toBeGreaterThan(0)
      expect(entry.license.length, `${entry.id} license`).toBeGreaterThan(0)
    }
  })

  it('covers every critical combat state with a fallback (criterion 3)', () => {
    /* These are the readouts a player cannot infer: a missing hit or armour marker means they cannot tell what happened
       to them. Doc 19 requires each to survive with no art. */
    for (const state of CRITICAL_EFFECT_STATES) {
      const entry = registry.entries.find((candidate) => candidate.id === `effect-${state}`)
      expect(entry, `effect-${state} must exist`).toBeDefined()
      expect(entry!.fallback.type).toMatch(/shape|letter/)
    }
  })

  it('gives every UI icon a monochrome fallback', () => {
    const icons = registry.entries.filter((entry) => entry.kind === 'icon')
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) expect(icon.fallback.monochrome, `${icon.id}`).toBe(true)
  })

  it('references design tokens for every fallback colour, never a literal', () => {
    /* Doc 23 §7 rule 6. A literal hex here would rebuild the parallel palette W8-01 removed, in a second file. */
    for (const entry of registry.entries) {
      expect(entry.fallback.color, `${entry.id}`).toMatch(/^token:/)
      expect(resolveFallbackColor(entry.fallback.color), `${entry.id} resolves`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('matches the ids the code asks for, in both directions (criterion 4)', () => {
    /* Doc 23 §7 rule 5, and the reason `ASSET_IDS` exists. An id in code with no entry is art nobody tracks a licence
       for; an entry with no code reference will rot. Compared as sets so either direction fails. */
    expect([...registry.entries.map((entry) => entry.id)].sort()).toEqual([...ASSET_IDS].sort())
  })
})

describe('W8-02 a missing file never breaks the game (criteria 1 and 5)', () => {
  it('resolves every code-declared id to something drawable with an empty asset directory', () => {
    /* Criterion 5 as a property: with *no* files at all, every id the game asks for still yields a drawable answer. */
    for (const id of ASSET_IDS) {
      const resolved = resolveAsset(registry, id, new Set())
      expect(resolved.source, `${id} falls back`).toBe('fallback')
      if (resolved.source === 'fallback') {
        expect(resolved.color, `${id} colour`).toMatch(/^#[0-9a-f]{6}$/i)
        if (resolved.type === 'letter') expect([...(resolved.glyph ?? '')]).toHaveLength(1)
      }
    }
  })

  it('prefers the file once it exists, and the fallback otherwise', () => {
    const entry = registry.entries[0]
    expect(resolveAsset(registry, entry.id, new Set([entry.path]))).toEqual({ source: 'file', path: entry.path })
    expect(resolveAsset(registry, entry.id, new Set()).source).toBe('fallback')
  })

  it('is total: an unregistered id still draws instead of throwing', () => {
    /* The registry test above is what makes an unknown id a build failure. At runtime it must still render something,
       because a thrown error inside a renderer is a blank screen. */
    expect(resolveAsset(registry, 'no-such-asset', new Set())).toEqual({
      source: 'fallback',
      type: 'shape',
      color: COLORS.textMuted,
    })
  })

  it('ships no asset files yet, which is the state criterion 5 is about', () => {
    /* Recorded as a fact rather than assumed: if art is delivered later this test is the reminder that the placeholder
       licences must be replaced, which `validateAssetRegistry` then enforces. */
    expect(deliveredPaths.size).toBe(0)
  })
})

describe('W8-02 the validator rejects a broken registry', () => {
  it('rejects a missing licence or author', () => {
    expect(validateAssetRegistry(withEntries((entries) => void (entries[0].license = '')))).toContainEqual(
      expect.objectContaining({ path: 'entries[0].license' }),
    )
    expect(validateAssetRegistry(withEntries((entries) => void (entries[0].author = '')))).toContainEqual(
      expect.objectContaining({ path: 'entries[0].author' }),
    )
  })

  it('rejects a literal colour in a fallback', () => {
    const issues = validateAssetRegistry(withEntries((entries) => void (entries[0].fallback.color = '#ff0000')))
    expect(issues).toContainEqual(expect.objectContaining({ path: 'entries[0].fallback.color' }))
  })

  it('rejects a token reference that names no shipped token', () => {
    const issues = validateAssetRegistry(withEntries((entries) => void (entries[0].fallback.color = 'token:nope')))
    expect(issues).toContainEqual(expect.objectContaining({ path: 'entries[0].fallback.color' }))
  })

  it('rejects a dropped critical effect', () => {
    const issues = validateAssetRegistry(
      withEntries((entries) => {
        const index = entries.findIndex((entry) => entry.id === 'effect-armor')
        entries.splice(index, 1)
      }),
    )
    expect(issues).toContainEqual(expect.objectContaining({ path: 'entries.effect-armor' }))
  })

  it('rejects an icon whose fallback is not monochrome', () => {
    const issues = validateAssetRegistry(
      withEntries((entries) => {
        const icon = entries.find((entry) => entry.kind === 'icon')!
        icon.fallback.monochrome = false
      }),
    )
    expect(issues).toContainEqual(expect.objectContaining({ path: expect.stringContaining('monochrome') }))
  })

  it('rejects a duplicated id', () => {
    const issues = validateAssetRegistry(withEntries((entries) => void entries.push({ ...entries[0] })))
    expect(issues.some((issue) => issue.message.includes('дублирующийся'))).toBe(true)
  })

  it('refuses to let a delivered file keep the placeholder licence', () => {
    /* The rule that makes rule 1 mean something over time: the placeholder describes a fallback this project drew, so it
       must not silently become the licence of record for a real, external asset. */
    const entry = registry.entries[0]
    expect(entry.license).toBe(PLACEHOLDER_LICENSE)
    expect(entry.author).toBe(PLACEHOLDER_AUTHOR)
    const issues = validateAssetRegistry(registry, new Set([entry.path]))
    expect(issues).toContainEqual(
      expect.objectContaining({ path: 'entries[0].license', message: expect.stringContaining('placeholder') }),
    )
    /* And a real licence on a delivered file is accepted. */
    const licensed = withEntries((entries) => {
      entries[0].license = 'CC0-1.0'
      entries[0].author = 'Real Author'
    })
    expect(validateAssetRegistry(licensed, new Set([entry.path]))).toEqual([])
  })

  it('throws with every issue listed when parsing an invalid payload', () => {
    expect(() => parseAssetRegistry({ contentVersion: 1, kind: 'asset-registry', entries: [{ id: 'x' }] })).toThrow(
      /Реестр ассетов невалиден/,
    )
    expect(() => parseAssetRegistry({ nope: true })).toThrow(/ожидается объект/)
  })
})
