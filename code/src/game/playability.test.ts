/**
 * W7-02 — validator tests, written as falsifiability checks.
 *
 * The failure mode this file exists to prevent: a validator that passes the shipped content and would pass
 * almost anything else too. A green run against `public/config` proves nothing on its own — the content was
 * already known good. So every check below **breaks something deliberately** and asserts the validator catches
 * it, one class of defect per test, so a regression names which check stopped working.
 *
 * The shipped-content run is still here (criterion 5), but it is the *least* informative test in the file.
 *
 * Playability is tested against hand-built grids rather than the shipped maps, because the interesting cases —
 * a walled-off enemy, an isolated pocket, two heroes — do not exist in shipped content and must not be
 * introduced there just to be testable.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AUTHORING_REACH_TURNS,
  canEngage,
  checkPlayability,
  hasBlockingIssues,
  heroReachableCells,
  type PlayabilityIssue,
} from './playability'
import { parseArenaContent, type ArenaContent } from './content'
import { validateMissions } from './campaign-content'
import type { ObjectiveParams } from './objective'

const shipped = (name: string) => JSON.parse(readFileSync(`public/config/${name}.json`, 'utf8'))
const LIVE_MAPS = ['perimeter-checkpoint', 'collapsed-yard', 'relay-station'] as const

/** A minimal well-formed arena the tests then break in one specific way. */
const arena = (overrides: Partial<ArenaContent> = {}): ArenaContent => ({
  contentVersion: 1,
  id: 'test-arena',
  name: 'Тестовая арена',
  width: 6,
  height: 4,
  tile: { width: 1, height: 1 },
  units: [
    { id: 'hero', name: 'Hero', team: 'player', hp: 24, maxHp: 24, aim: 72, color: '#fff', x: 0, y: 0 },
    { id: 'raider', name: 'Raider', team: 'enemy', hp: 16, maxHp: 16, aim: 55, color: '#000', x: 4, y: 0 },
  ] as ArenaContent['units'],
  cover: [],
  ...overrides,
})

const ids = (issues: readonly PlayabilityIssue[]) => issues.map((issue) => issue.id)

describe('W7-02 the shipped content passes, in both modes (criterion 5)', () => {
  it('reports no playability errors on any live map', () => {
    /* The least informative test here, and deliberately so: this content was already known good. It guards
       against the validator becoming *stricter* than the game and rejecting shipped maps. */
    const missions = validateMissions(shipped('missions'))
    expect(missions.ok).toBe(true)
    if (!missions.ok) return
    for (const id of LIVE_MAPS) {
      const map = parseArenaContent(shipped(id))
      const objective = missions.value.find((mission) => mission.arenaId === map.id)?.objectiveParams
      for (const strict of [false, true]) {
        const issues = checkPlayability({ arena: map, objective, strict })
        expect(issues, `${id} strict=${strict}`).toEqual([])
      }
    }
  })

  it('passes the test fixture map too, so the checks are not tuned to three files', () => {
    const map = parseArenaContent(shipped('arena'))
    expect(checkPlayability({ arena: map, strict: true })).toEqual([])
  })
})

describe('W7-02 structural defects are caught (criterion 1)', () => {
  it('rejects a map with no hero', () => {
    const broken = arena({ units: arena().units.filter((unit) => unit.id !== 'hero') })
    const issues = checkPlayability({ arena: broken })
    expect(ids(issues)).toContain('hero-missing')
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('rejects two player units, since the runtime requires exactly one hero', () => {
    /* `validateSave` enforces exactly one hero; a map that ships two produces a save the game cannot load. */
    const twice = arena()
    const broken = arena({ units: [...twice.units, { ...twice.units[0], id: 'hero-2', x: 1, y: 1 }] })
    expect(ids(checkPlayability({ arena: broken }))).toContain('hero-count')
  })

  it('rejects a unit outside the grid', () => {
    const broken = arena({
      units: arena().units.map((unit) => (unit.id === 'raider' ? { ...unit, x: 99 } : unit)),
    })
    const issues = checkPlayability({ arena: broken })
    expect(ids(issues)).toContain('unit-out-of-bounds')
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('rejects cover outside the grid', () => {
    const broken = arena({ cover: [{ x: 9, y: 9, type: 'full' }] as ArenaContent['cover'] })
    expect(ids(checkPlayability({ arena: broken }))).toContain('cover-out-of-bounds')
  })

  it('rejects two units sharing a cell', () => {
    /* Not expressible in play: movement onto an occupied cell is refused and the pair would read as one blocker. */
    const broken = arena({
      units: arena().units.map((unit) => (unit.id === 'raider' ? { ...unit, x: 0, y: 0 } : unit)),
    })
    expect(ids(checkPlayability({ arena: broken }))).toContain('units-overlap')
  })

  it('rejects a unit standing inside full cover', () => {
    /* The game's own blocker rules would wall it in: `blockingCells` includes full cover. */
    const broken = arena({ cover: [{ x: 4, y: 0, type: 'full' }] as ArenaContent['cover'] })
    expect(ids(checkPlayability({ arena: broken }))).toContain('unit-inside-cover')
  })

  it('rejects a map with no enemies under an eliminate objective', () => {
    const broken = arena({ units: arena().units.filter((unit) => unit.team !== 'enemy') })
    expect(ids(checkPlayability({ arena: broken, objective: { kind: 'eliminate' } }))).toContain('no-enemies')
    /* But an escape map with no enemies is legitimate: leaving is the objective. */
    const escape: ObjectiveParams = { kind: 'escape', exit: { x: 5, y: 3 } }
    expect(ids(checkPlayability({ arena: broken, objective: escape }))).not.toContain('no-enemies')
  })
})

describe('W7-02 unplayable geometry is caught (criterion 2)', () => {
  /** A 3-wide corridor with the enemy sealed behind a full-cover wall. */
  const walledOff = () =>
    arena({
      width: 5,
      height: 3,
      units: [
        { id: 'hero', name: 'Hero', team: 'player', hp: 24, maxHp: 24, aim: 72, color: '#fff', x: 0, y: 1 },
        { id: 'raider', name: 'Raider', team: 'enemy', hp: 16, maxHp: 16, aim: 55, color: '#000', x: 4, y: 1 },
      ] as ArenaContent['units'],
      cover: [
        { x: 3, y: 0, type: 'full' },
        { x: 3, y: 1, type: 'full' },
        { x: 3, y: 2, type: 'full' },
      ] as ArenaContent['cover'],
    })

  it('rejects an enemy that cannot be shot from anywhere reachable, in strict mode', () => {
    /*
     * Criterion 2. A warning by default and an error under `--strict-playability`, because an `eliminate` map
     * genuinely cannot be finished while that enemy stands there — but a `secure` or `escape` map may legitimately
     * contain an enemy the hero never has to touch, and failing those would push authors to route around the
     * validator.
     */
    const map = walledOff()
    expect(canEngage(map, { x: 4, y: 1 })).toBe(false)

    const lenient = checkPlayability({ arena: map, strict: false })
    expect(ids(lenient)).toContain('enemy-unengageable')
    expect(hasBlockingIssues(lenient)).toBe(false)

    const strict = checkPlayability({ arena: map, strict: true })
    expect(ids(strict)).toContain('enemy-unengageable')
    expect(hasBlockingIssues(strict)).toBe(true)
  })

  it('reports the pocket the wall creates as an isolated region', () => {
    const issues = checkPlayability({ arena: walledOff(), strict: true })
    expect(ids(issues)).toContain('isolated-region')
    /* The message names actual cells, so an author can go look at them. */
    expect(issues.find((issue) => issue.id === 'isolated-region')!.message).toMatch(/4,\d/)
  })

  it('rejects an objective cell the hero cannot walk to', () => {
    const map = walledOff()
    const escape: ObjectiveParams = { kind: 'escape', exit: { x: 4, y: 0 } }
    expect(ids(checkPlayability({ arena: map, objective: escape, strict: true }))).toContain(
      'objective-unreachable',
    )
    /* A reachable exit on the hero's side of the wall is fine. */
    const reachable: ObjectiveParams = { kind: 'escape', exit: { x: 2, y: 0 } }
    expect(ids(checkPlayability({ arena: map, objective: reachable, strict: true }))).not.toContain(
      'objective-unreachable',
    )
  })

  it('rejects a hero with nowhere to move', () => {
    const boxed = arena({
      width: 3,
      height: 3,
      units: [
        { id: 'hero', name: 'Hero', team: 'player', hp: 24, maxHp: 24, aim: 72, color: '#fff', x: 0, y: 0 },
        { id: 'raider', name: 'Raider', team: 'enemy', hp: 16, maxHp: 16, aim: 55, color: '#000', x: 2, y: 2 },
      ] as ArenaContent['units'],
      cover: [
        { x: 1, y: 0, type: 'full' },
        { x: 0, y: 1, type: 'full' },
      ] as ArenaContent['cover'],
    })
    const issues = checkPlayability({ arena: boxed })
    expect(ids(issues)).toContain('hero-immobile')
    expect(hasBlockingIssues(issues)).toBe(true)
  })

  it('warns about a map with no cover without failing it', () => {
    /* Playable, merely poor. Promoting quality findings to errors is how a validator gets bypassed. */
    const issues = checkPlayability({ arena: arena({ cover: [] }), strict: true })
    expect(ids(issues)).toContain('no-cover')
    expect(issues.find((issue) => issue.id === 'no-cover')!.level).toBe('warning')
    expect(hasBlockingIssues(issues)).toBe(false)
  })
})

describe('W7-02 reachability uses the game rules, not its own walk', () => {
  it('counts an occupied cell as walkable, because units move', () => {
    /*
     * The defect this pins. `findReachable` treats other units as blockers, so an enemy's own tile is never
     * "reachable" while it stands there — but it is not walled off either, it frees up the moment the enemy dies.
     * Counting those cells reported **every shipped map** as having an isolated region, which is how it was found.
     */
    const map = arena()
    const reachable = heroReachableCells(map)
    /* The enemy's cell is genuinely not in the reachable set... */
    expect(reachable.has('4,0')).toBe(false)
    /* ...and yet the map has no isolated region, because occupancy is not a wall. */
    expect(ids(checkPlayability({ arena: map, strict: true }))).not.toContain('isolated-region')
  })

  it('allows several turns of walking, so a far cell is not mistaken for a walled one', () => {
    /* A hero has 10 AP and the shipped maps are 7–8 wide, so single-turn reachability would reject ordinary
       content. The check exists to find walls, and a wall does not become passable with more AP. */
    expect(AUTHORING_REACH_TURNS).toBeGreaterThan(1)
    const wide = arena({ width: 20, height: 3 })
    expect(ids(checkPlayability({ arena: wide, strict: true }))).not.toContain('isolated-region')
  })
})
