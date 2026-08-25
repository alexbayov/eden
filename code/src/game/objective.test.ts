/**
 * W6-01 — objective runtime tests.
 *
 * Everything here is pure: no DOM, no save adapter, no Phaser. The tests are organised around the four
 * acceptance criteria that are checkable at this level, and each one is asserted as a *property* where
 * it can be rather than as a happy path:
 *
 *   - **criterion 1** — every objective type completes by its own condition. Asserted both positively
 *     (the condition completes it) and negatively (the *other* types' conditions do not), because the
 *     defect this ticket exists to fix was precisely three types sharing one condition;
 *   - **criterion 3** — invalid `objectiveParams` are rejected at load, per type, including the case
 *     that used to pass silently: `retrieve`/`escape` being rewritten to `secure`;
 *   - **criterion 4** — a failed objective is its own outcome, distinct from a defeat;
 *   - the shipped catalog is driven through the real validator, so `missions.json` cannot declare an
 *     objective the runtime cannot resolve.
 *
 * The turn clock gets its own section. It is the part that went wrong first: counting a held turn
 * inside `evaluateObjective` made the hold advance twice per turn (once after the player's action, once
 * at the end of the enemy phase), so a two-turn hold finished in ~1.3 turns. `advanceObjectiveTurn` is
 * now the single writer, and the tests below pin that it is idempotent under repeated evaluation.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateMissions } from './campaign-content'
import type { Unit } from './combat'
import {
  OBJECTIVE_TYPES,
  advanceObjectiveTurn,
  canPickUp,
  evaluateObjective,
  initialObjectiveState,
  isObjectiveState,
  objectiveCells,
  objectiveProgress,
  pickUpObjective,
  validateObjective,
  validateObjectiveGeometry,
  zoneHeld,
  type ObjectiveContext,
  type ObjectiveParams,
  type ObjectiveState,
} from './objective'

const unit = (overrides: Partial<Unit> & { id: string }): Unit => ({
  name: overrides.id,
  hp: 20,
  maxHp: 20,
  team: 'enemy',
  aim: 55,
  color: '#000000',
  ap: 10,
  x: 0,
  y: 0,
  ...overrides,
})
const hero = (overrides: Partial<Unit> = {}) => unit({ id: 'hero', team: 'player', maxHp: 24, hp: 24, ...overrides })
const enemy = (overrides: Partial<Unit> & { id: string }) => unit(overrides)

const context = (
  params: ObjectiveParams,
  units: Unit[],
  overrides: { state?: Partial<ObjectiveState>; turn?: number; turnLimit?: number } = {},
): ObjectiveContext => ({
  params,
  state: { ...initialObjectiveState(), ...(overrides.state ?? {}) },
  units,
  turn: overrides.turn ?? 1,
  turnLimit: overrides.turnLimit,
})

describe('W6-01 objective completion, one rule per type', () => {
  it('completes eliminate only when every enemy is dead', () => {
    const params: ObjectiveParams = { kind: 'eliminate' }
    const alive = [hero(), enemy({ id: 'a', hp: 5 }), enemy({ id: 'b', hp: 0 })]
    expect(evaluateObjective(context(params, alive)).outcome).toBe('active')

    const cleared = [hero(), enemy({ id: 'a', hp: 0 }), enemy({ id: 'b', hp: 0 })]
    const done = evaluateObjective(context(params, cleared))
    expect(done.outcome).toBe('complete')
    expect(done.reason).toContain('противник')
  })

  it('completes secure on held turns, and never on a cleared board alone', () => {
    /*
     * The regression this ticket is named for. `relay-station` declared `secure` and was resolved by
     * clearing the map, which made the objective a label. Here a board with no enemies left is still
     * `active` until the hold has actually been counted.
     */
    const params: ObjectiveParams = { kind: 'secure', zone: { x: 5, y: 3 }, radius: 1, holdTurns: 2 }
    const cleared = [hero({ x: 5, y: 3 }), enemy({ id: 'a', hp: 0 })]
    expect(evaluateObjective(context(params, cleared)).outcome).toBe('active')

    expect(evaluateObjective(context(params, cleared, { state: { heldTurns: 1 } })).outcome).toBe('active')
    const held = evaluateObjective(context(params, cleared, { state: { heldTurns: 2 } }))
    expect(held.outcome).toBe('complete')
    expect(held.reason).toContain('удержана')
  })

  it('completes retrieve only when the item has been taken and carried to the exit', () => {
    const params: ObjectiveParams = { kind: 'retrieve', itemId: 'relay-core', at: { x: 4, y: 1 }, exit: { x: 0, y: 5 } }
    const atExit = [hero({ x: 0, y: 5 })]

    /* At the exit without the item is not a delivery — the old shared condition would have accepted a
       cleared board here regardless of position. */
    expect(evaluateObjective(context(params, atExit)).outcome).toBe('active')
    /* Carrying it but standing elsewhere is not a delivery either. */
    expect(evaluateObjective(context(params, [hero({ x: 4, y: 1 })], { state: { carrying: true } })).outcome).toBe('active')

    const delivered = evaluateObjective(context(params, atExit, { state: { carrying: true } }))
    expect(delivered.outcome).toBe('complete')
    expect(delivered.reason).toContain('Груз доставлен')
    /* And clearing the board does nothing for a retrieval. */
    expect(evaluateObjective(context(params, [hero({ x: 2, y: 2 }), enemy({ id: 'a', hp: 0 })])).outcome).toBe('active')
  })

  it('completes escape by standing on the exit, with enemies alive and irrelevant', () => {
    const params: ObjectiveParams = { kind: 'escape', exit: { x: 7, y: 0 } }
    const guarded = [hero({ x: 7, y: 0 }), enemy({ id: 'a', hp: 16 })]
    const escaped = evaluateObjective(context(params, guarded))
    expect(escaped.outcome).toBe('complete')
    expect(escaped.reason).toContain('покинул')
    /* Killing everything is not an escape. */
    expect(evaluateObjective(context(params, [hero({ x: 1, y: 1 }), enemy({ id: 'a', hp: 0 })])).outcome).toBe('active')
  })

  it('reports active while the hero is down, leaving the defeat to the combat layer', () => {
    /* Two systems must not both claim the same transition: `missionDefeat` owns a dead hero. If this
       returned `failed` the player would be told the objective expired when they were shot. */
    const params: ObjectiveParams = { kind: 'escape', exit: { x: 0, y: 0 } }
    const down = [hero({ x: 0, y: 0, hp: 0 })]
    expect(evaluateObjective(context(params, down)).outcome).toBe('active')
    expect(evaluateObjective(context(params, down, { turn: 99, turnLimit: 3 })).outcome).toBe('active')
  })
})

describe('W6-01 objective failure as its own outcome (criterion 4)', () => {
  it('fails a timed retrieve or escape while the hero is alive and unharmed', () => {
    const escape: ObjectiveParams = { kind: 'escape', exit: { x: 7, y: 0 } }
    const healthy = [hero({ x: 1, y: 1 })]
    expect(evaluateObjective(context(escape, healthy, { turn: 6, turnLimit: 6 })).outcome).toBe('active')
    const expired = evaluateObjective(context(escape, healthy, { turn: 7, turnLimit: 6 }))
    expect(expired.outcome).toBe('failed')
    expect(expired.reason).toContain('Время вышло')
  })

  it('distinguishes timing out with the cargo from timing out without it', () => {
    /* Different sentences because they are different mistakes: one is "I never found it", the other is
       "I found it and could not get out". Collapsing them would make the failure unactionable. */
    const params: ObjectiveParams = { kind: 'retrieve', itemId: 'relay-core', at: { x: 4, y: 1 }, exit: { x: 0, y: 5 } }
    const late = { turn: 9, turnLimit: 8 }
    const withoutCargo = evaluateObjective(context(params, [hero({ x: 2, y: 2 })], late))
    const withCargo = evaluateObjective(context(params, [hero({ x: 2, y: 2 })], { ...late, state: { carrying: true } }))
    expect(withoutCargo.outcome).toBe('failed')
    expect(withCargo.outcome).toBe('failed')
    expect(withoutCargo.reason).not.toBe(withCargo.reason)
    expect(withCargo.reason).toContain('выйти не удалось')
  })

  it('never fails an untimed objective, however long it runs', () => {
    /* `eliminate` and `secure` have no deadline: an unfinished cleanup is unfinished, not failed, and a
       `secure` mission's own `holdTurns` is its clock. A deadline here would be an invented rule. */
    for (const params of [
      { kind: 'eliminate' } as const,
      { kind: 'secure', zone: { x: 1, y: 1 }, radius: 0, holdTurns: 3 } as const,
    ])
      expect(evaluateObjective(context(params, [hero(), enemy({ id: 'a', hp: 9 })], { turn: 500 })).outcome).toBe('active')
  })
})

describe('W6-01 the hold clock has exactly one writer', () => {
  const params: ObjectiveParams = { kind: 'secure', zone: { x: 5, y: 3 }, radius: 1, holdTurns: 2 }

  it('advances only through advanceObjectiveTurn, so evaluation cannot double-count', () => {
    /*
     * The actual bug, pinned. `evaluateObjective` used to count the held turn itself, and it is called
     * both after a player action and at the end of the enemy phase — so a two-turn hold completed in
     * 1.32 turns in the simulator. Evaluating repeatedly must now change nothing.
     */
    const board = [hero({ x: 5, y: 3 })]
    const start = initialObjectiveState()
    const evaluated = evaluateObjective(context(params, board, { state: start }))
    expect(evaluated.state).toEqual(start)
    expect(evaluateObjective(context(params, board, { state: evaluated.state })).state).toEqual(start)

    /* One boundary, one increment. */
    const afterOne = advanceObjectiveTurn(context(params, board, { state: start }))
    expect(afterOne.heldTurns).toBe(1)
    const afterTwo = advanceObjectiveTurn(context(params, board, { state: afterOne }))
    expect(afterTwo.heldTurns).toBe(2)
    expect(evaluateObjective(context(params, board, { state: afterTwo })).outcome).toBe('complete')
  })

  it('resets the count the moment the zone is not held', () => {
    const inside = advanceObjectiveTurn(context(params, [hero({ x: 5, y: 3 })], { state: { heldTurns: 1 } }))
    expect(inside.heldTurns).toBe(2)
    /* Walking out drops the progress rather than pausing it: "consecutive" is the whole point. */
    const outside = advanceObjectiveTurn(context(params, [hero({ x: 0, y: 0 })], { state: { heldTurns: 1 } }))
    expect(outside.heldTurns).toBe(0)
  })

  it('treats a contested zone as not held, so securing requires clearing', () => {
    /* Without this, `secure` would be "stand still for N turns while being shot", and the enemy could be
       ignored entirely — which is how the objective would collapse back into a formality. */
    expect(zoneHeld([hero({ x: 5, y: 3 })], { x: 5, y: 3 }, 1)).toBe(true)
    expect(zoneHeld([hero({ x: 5, y: 3 }), enemy({ id: 'a', x: 5, y: 4, hp: 12 })], { x: 5, y: 3 }, 1)).toBe(false)
    /* A dead enemy does not contest it. */
    expect(zoneHeld([hero({ x: 5, y: 3 }), enemy({ id: 'a', x: 5, y: 4, hp: 0 })], { x: 5, y: 3 }, 1)).toBe(true)
    /* An enemy outside the radius does not contest it either. */
    expect(zoneHeld([hero({ x: 5, y: 3 }), enemy({ id: 'a', x: 5, y: 5, hp: 12 })], { x: 5, y: 3 }, 1)).toBe(true)
    /* A downed hero holds nothing. */
    expect(zoneHeld([hero({ x: 5, y: 3, hp: 0 })], { x: 5, y: 3 }, 1)).toBe(false)
  })

  it('leaves non-secure objectives untouched at the turn boundary', () => {
    /* Identity, not deep equality: only `secure` has a per-turn clock, and a rebuilt-but-equal object
       would mean the boundary is writing state for objectives that have none. The context is built by
       hand here because the `context` helper spreads a fresh state object. */
    const state: ObjectiveState = { heldTurns: 0, carrying: true }
    for (const params of [
      { kind: 'eliminate' } as const,
      { kind: 'escape', exit: { x: 1, y: 1 } } as const,
      { kind: 'retrieve', itemId: 'x', at: { x: 1, y: 1 }, exit: { x: 2, y: 2 } } as const,
    ])
      expect(advanceObjectiveTurn({ params, state, units: [hero()], turn: 1 })).toBe(state)
  })
})

describe('W6-01 cargo pickup is explicit', () => {
  const params: ObjectiveParams = { kind: 'retrieve', itemId: 'relay-core', at: { x: 4, y: 1 }, exit: { x: 0, y: 5 } }

  it('is available only on the cargo cell, and only once', () => {
    expect(canPickUp(context(params, [hero({ x: 4, y: 1 })]))).toBe(true)
    expect(canPickUp(context(params, [hero({ x: 4, y: 2 })]))).toBe(false)
    /* Already carrying: nothing left to take. */
    expect(canPickUp(context(params, [hero({ x: 4, y: 1 })], { state: { carrying: true } }))).toBe(false)
    /* A downed hero picks nothing up. */
    expect(canPickUp(context(params, [hero({ x: 4, y: 1, hp: 0 })]))).toBe(false)
    /* And no other objective type has cargo at all. */
    expect(canPickUp(context({ kind: 'eliminate' }, [hero({ x: 4, y: 1 })]))).toBe(false)
  })

  it('refuses rather than silently doing nothing', () => {
    /* A null return is what lets the shell report an honest refusal; a no-op returning the same state
       would let a button claim success for nothing. */
    expect(pickUpObjective(context(params, [hero({ x: 0, y: 0 })]))).toBeNull()
    const taken = pickUpObjective(context(params, [hero({ x: 4, y: 1 })]))
    expect(taken).toEqual({ heldTurns: 0, carrying: true })
  })
})

describe('W6-01 per-turn progress readout (criterion 2)', () => {
  it('counts eliminate progress against the encounter roster', () => {
    const view = objectiveProgress(
      context({ kind: 'eliminate' }, [hero(), enemy({ id: 'a', hp: 0 }), enemy({ id: 'b', hp: 7 })]),
    )
    expect(view).toMatchObject({ kind: 'eliminate', done: 1, total: 2 })
    expect(view.detail).toBe('1/2 целей')
    expect(view.turnsLeft).toBeNull()
  })

  it('states both the hold count and whether the point is currently held', () => {
    /* Two different situations that share a number: "1/2 and holding" versus "1/2 and pushed off" are
       not the same board, and a bare fraction would read identically in both. */
    const params: ObjectiveParams = { kind: 'secure', zone: { x: 5, y: 3 }, radius: 1, holdTurns: 2 }
    const holding = objectiveProgress(context(params, [hero({ x: 5, y: 3 })], { state: { heldTurns: 1 } }))
    expect(holding).toMatchObject({ done: 1, total: 2, actionable: true })
    expect(holding.detail).toContain('удержания')

    const pushedOff = objectiveProgress(context(params, [hero({ x: 0, y: 0 })], { state: { heldTurns: 1 } }))
    expect(pushedOff).toMatchObject({ actionable: false })
    expect(pushedOff.detail).toContain('не удерживается')
  })

  it('switches the retrieve label from pickup to delivery once the cargo is taken', () => {
    const params: ObjectiveParams = { kind: 'retrieve', itemId: 'relay-core', at: { x: 4, y: 1 }, exit: { x: 0, y: 5 } }
    const before = objectiveProgress(context(params, [hero({ x: 0, y: 0 })]))
    expect(before.label).toContain('Забрать')
    expect(before.done).toBe(0)
    const after = objectiveProgress(context(params, [hero({ x: 0, y: 0 })], { state: { carrying: true } }))
    expect(after.label).toContain('выходу')
    expect(after.done).toBe(1)
  })

  it('counts the remaining turns of a deadline, and floors at zero', () => {
    const params: ObjectiveParams = { kind: 'escape', exit: { x: 7, y: 0 } }
    expect(objectiveProgress(context(params, [hero()], { turn: 1, turnLimit: 8 })).turnsLeft).toBe(8)
    expect(objectiveProgress(context(params, [hero()], { turn: 8, turnLimit: 8 })).turnsLeft).toBe(1)
    expect(objectiveProgress(context(params, [hero()], { turn: 20, turnLimit: 8 })).turnsLeft).toBe(0)
  })

  it('never disagrees with the completion rule about whether the objective is done', () => {
    /*
     * The property that matters more than any single label: a readout derived from a separate copy of
     * the rules is how a UI starts lying about the mission. Checked across every type by driving both
     * functions from the same context.
     */
    const cases: { params: ObjectiveParams; units: Unit[]; state?: Partial<ObjectiveState> }[] = [
      { params: { kind: 'eliminate' }, units: [hero(), enemy({ id: 'a', hp: 0 })] },
      { params: { kind: 'eliminate' }, units: [hero(), enemy({ id: 'a', hp: 4 })] },
      { params: { kind: 'secure', zone: { x: 1, y: 1 }, radius: 0, holdTurns: 2 }, units: [hero({ x: 1, y: 1 })], state: { heldTurns: 2 } },
      { params: { kind: 'secure', zone: { x: 1, y: 1 }, radius: 0, holdTurns: 2 }, units: [hero({ x: 1, y: 1 })], state: { heldTurns: 1 } },
      { params: { kind: 'escape', exit: { x: 2, y: 2 } }, units: [hero({ x: 2, y: 2 })] },
      { params: { kind: 'escape', exit: { x: 2, y: 2 } }, units: [hero({ x: 0, y: 0 })] },
      { params: { kind: 'retrieve', itemId: 'c', at: { x: 1, y: 0 }, exit: { x: 3, y: 3 } }, units: [hero({ x: 3, y: 3 })], state: { carrying: true } },
      { params: { kind: 'retrieve', itemId: 'c', at: { x: 1, y: 0 }, exit: { x: 3, y: 3 } }, units: [hero({ x: 3, y: 3 })] },
    ]
    for (const entry of cases) {
      const built = context(entry.params, entry.units, { state: entry.state })
      const complete = evaluateObjective(built).outcome === 'complete'
      const view = objectiveProgress(built)
      expect(view.done >= view.total, `${entry.params.kind}: readout must agree with completion`).toBe(complete)
    }
  })
})

describe('W6-01 objectiveParams validation at load (criterion 3)', () => {
  it('accepts the four types and rejects anything else, without rewriting', () => {
    /*
     * The silent rewrite this replaces: `checkMission` accepted `retrieve` and `escape` and returned
     * them as `secure`, so a retrieval mission shipped as a cleanup with nothing anywhere saying so.
     * Each type must now come back as itself.
     */
    expect(OBJECTIVE_TYPES).toEqual(['eliminate', 'secure', 'retrieve', 'escape'])
    const params: Record<string, unknown> = {
      eliminate: undefined,
      secure: { zone: { x: 1, y: 1 }, radius: 1, holdTurns: 2 },
      retrieve: { itemId: 'c', at: { x: 1, y: 1 }, exit: { x: 2, y: 2 } },
      escape: { exit: { x: 2, y: 2 } },
    }
    for (const kind of OBJECTIVE_TYPES) {
      const result = validateObjective(kind, params[kind], '$')
      expect(result.ok, kind).toBe(true)
      if (result.ok) expect(result.value.kind, `${kind} must not be rewritten`).toBe(kind)
    }
    expect(validateObjective('capture', {}, '$').ok).toBe(false)
    expect(validateObjective(undefined, {}, '$').ok).toBe(false)
  })

  it('rejects params that belong to a different objective type', () => {
    /* The mismatch that used to be undetectable: a `secure` mission carrying an exit, or an `escape`
       carrying `holdTurns`, both looked fine because nothing validated the pairing. */
    expect(validateObjective('secure', { exit: { x: 1, y: 1 } }, '$').ok).toBe(false)
    expect(validateObjective('escape', { zone: { x: 1, y: 1 }, radius: 0, holdTurns: 2 }, '$').ok).toBe(false)
    expect(validateObjective('retrieve', { exit: { x: 1, y: 1 } }, '$').ok).toBe(false)
    /* And `eliminate` must not look configurable when it is not. */
    const configured = validateObjective('eliminate', { holdTurns: 3 }, '$')
    expect(configured.ok).toBe(false)
    if (!configured.ok) expect(configured.issues[0].message).toContain('не принимает параметров')
  })

  it('requires params at all for the three configurable types', () => {
    for (const kind of ['secure', 'retrieve', 'escape'] as const) {
      const missing = validateObjective(kind, undefined, '$')
      expect(missing.ok, kind).toBe(false)
      if (!missing.ok) expect(missing.issues[0].path).toBe('$.objectiveParams')
    }
  })

  it('rejects out-of-range and non-integer values with the offending path', () => {
    const bad: [string, unknown, string][] = [
      ['secure', { zone: { x: 1, y: 1 }, radius: 4, holdTurns: 2 }, '$.objectiveParams.radius'],
      ['secure', { zone: { x: 1, y: 1 }, radius: 1, holdTurns: 0 }, '$.objectiveParams.holdTurns'],
      ['secure', { zone: { x: 1, y: 1 }, radius: 1, holdTurns: 99 }, '$.objectiveParams.holdTurns'],
      ['secure', { zone: { x: -1, y: 1 }, radius: 1, holdTurns: 2 }, '$.objectiveParams.zone.x'],
      ['secure', { zone: { x: 1, y: 1.5 }, radius: 1, holdTurns: 2 }, '$.objectiveParams.zone.y'],
      ['retrieve', { itemId: '', at: { x: 1, y: 1 }, exit: { x: 2, y: 2 } }, '$.objectiveParams.itemId'],
      ['escape', { exit: { x: 1 } }, '$.objectiveParams.exit.y'],
    ]
    for (const [kind, params, path] of bad) {
      const result = validateObjective(kind, params, '$')
      expect(result.ok, `${kind} ${path}`).toBe(false)
      if (!result.ok) expect(result.issues.map((issue) => issue.path)).toContain(path)
    }
  })

  it('bounds-checks objective geometry against the arena it runs on', () => {
    /* An exit outside the map is an unwinnable mission that looks perfectly valid in `missions.json`.
       Split from the shape check because missions are validated before any arena is fetched. */
    const params: ObjectiveParams = { kind: 'retrieve', itemId: 'c', at: { x: 4, y: 1 }, exit: { x: 9, y: 9 } }
    expect(validateObjectiveGeometry(params, { width: 8, height: 6 }, '$')).toEqual([
      { path: '$.exit.x', message: 'внутри арены (< 8)' },
      { path: '$.exit.y', message: 'внутри арены (< 6)' },
    ])
    expect(validateObjectiveGeometry(params, { width: 10, height: 10 }, '$')).toEqual([])
    /* `eliminate` names no cells, so it can never be out of bounds. */
    expect(objectiveCells({ kind: 'eliminate' })).toEqual([])
    /* A radius overhanging the edge is a smaller zone, not a broken mission: only the centre is checked,
       otherwise securing a corner would be forbidden. */
    expect(
      validateObjectiveGeometry({ kind: 'secure', zone: { x: 7, y: 5 }, radius: 3, holdTurns: 2 }, { width: 8, height: 6 }, '$'),
    ).toEqual([])
  })

  it('validates persisted objective state, because a hand-edited hold is a free win', () => {
    expect(isObjectiveState({ heldTurns: 0, carrying: false })).toBe(true)
    expect(isObjectiveState({ heldTurns: -1, carrying: false })).toBe(false)
    expect(isObjectiveState({ heldTurns: 1.5, carrying: false })).toBe(false)
    expect(isObjectiveState({ heldTurns: 1 })).toBe(false)
    expect(isObjectiveState(null)).toBe(false)
  })
})

describe('W6-01 the shipped catalog resolves through the real validator', () => {
  const missions = validateMissions(JSON.parse(readFileSync('public/config/missions.json', 'utf8')))

  it('parses every shipped encounter, keeping its declared objective', () => {
    expect(missions.ok).toBe(true)
    if (!missions.ok) return
    for (const mission of missions.value)
      expect(mission.objectiveParams.kind, mission.id).toBe(mission.objective)
  })

  it('gives relay-station a real hold condition rather than a label', () => {
    /* doc 10 §Ограничения alpha recorded that this encounter ended in the same cleanup as an
       `eliminate`. The point of W6-01 is that it no longer does. */
    if (!missions.ok) return
    const relay = missions.value.find((mission) => mission.id === 'relay-station')
    expect(relay?.objective).toBe('secure')
    expect(relay?.objectiveParams).toMatchObject({ kind: 'secure' })
    if (relay?.objectiveParams.kind !== 'secure') throw new Error('relay-station must declare secure params')
    expect(relay.objectiveParams.holdTurns).toBeGreaterThan(1)
  })

  it('resolves every shipped objective to a reachable completion, not a dead end', () => {
    /*
     * A cheap unwinnability check across the catalog: whatever the objective is, *some* board state
     * completes it. Without this, a mission could validate, load, play and simply never finish.
     */
    if (!missions.ok) return
    for (const mission of missions.value) {
      const params = mission.objectiveParams
      const completing: Unit[] =
        params.kind === 'eliminate'
          ? [hero(), enemy({ id: 'a', hp: 0 })]
          : params.kind === 'secure'
            ? [hero({ x: params.zone.x, y: params.zone.y })]
            : params.kind === 'escape'
              ? [hero({ x: params.exit.x, y: params.exit.y })]
              : [hero({ x: params.exit.x, y: params.exit.y })]
      const state: Partial<ObjectiveState> =
        params.kind === 'secure' ? { heldTurns: params.holdTurns } : params.kind === 'retrieve' ? { carrying: true } : {}
      expect(evaluateObjective(context(params, completing, { state })).outcome, mission.id).toBe('complete')
    }
  })
})
