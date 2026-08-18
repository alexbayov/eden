import { describe, expect, it } from 'vitest'
import { CONTENT_VERSION, ContentValidationError, parseArenaContent, validateArenaContent } from './content'

const content = {
  contentVersion: CONTENT_VERSION,
  id: 'test-arena',
  name: 'Test arena',
  width: 4,
  height: 3,
  tile: { width: 92, height: 46 },
  units: [
    { id: 'hero', name: 'Hero', team: 'player', x: 0, y: 0, hp: 20, maxHp: 20, aim: 70, color: '#ffffff' },
    { id: 'enemy', name: 'Enemy', team: 'enemy', x: 3, y: 2, hp: 10, maxHp: 10, aim: 50, color: '#ff0000' },
  ],
  cover: [{ x: 1, y: 1, type: 'full' }],
}

describe('versioned arena content', () => {
  it('accepts the shared v1 arena/mission contract', () => {
    expect(validateArenaContent(content)).toEqual({ ok: true, value: content })
  })

  it('migrates legacy unversioned arena data into v1', () => {
    const legacy = { ...content }
    delete (legacy as { contentVersion?: number }).contentVersion
    expect(parseArenaContent(legacy)).toEqual(content)
  })

  it('returns typed errors with useful field paths', () => {
    const badShape = validateArenaContent({ ...content, units: [{ id: 'hero' }], cover: [{ x: 8, y: 0, type: 'wall' }] })
    expect(badShape.ok).toBe(false)
    if (!badShape.ok) expect(badShape.error).toBeInstanceOf(ContentValidationError)
    if (!badShape.ok) expect(badShape.error.code).toBe('shape')
    if (!badShape.ok) expect(badShape.error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['$.units[0].name', '$.cover[0].x', '$.cover[0].type']))

    const future = validateArenaContent({ ...content, contentVersion: 2 })
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.error.code).toBe('version')
    expect(() => parseArenaContent({ ...content, contentVersion: 2 })).toThrow(ContentValidationError)
  })
})
