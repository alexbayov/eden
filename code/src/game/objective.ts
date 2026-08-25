/**
 * W6-01 — the **pure** objective runtime: what actually ends an encounter, per objective type.
 *
 * Before this module there was exactly one win condition in the whole game — every enemy dead —
 * inlined in the attack handler (`app.tsx`), and `missions.json`'s `objective` field was decoration:
 * `grep '\.objective'` found only the validator's own error path. Worse, `checkMission` *accepted*
 * `retrieve` and `escape` and silently rewrote them to `secure`, so a content author could ship a
 * retrieval mission and get a cleanup mission with no warning anywhere. `docs/10` §Ограничения alpha
 * admitted this in writing. This module is the replacement, and the reduction is deleted.
 *
 * Four decisions, each closing a way the old shape could mislead:
 *
 *   1. **One evaluator, four rules.** `evaluateObjective` is total over `ObjectiveType`, so a new
 *      objective type cannot compile without a completion rule, a progress readout and a validated
 *      parameter shape. The old code could not express "this mission ends differently" at all.
 *   2. **Parameters are content, validated by type.** `secure` needs `holdTurns`, `retrieve` needs an
 *      `itemId` and a pickup cell, `escape` needs an exit; `eliminate` needs nothing and must not
 *      carry any. A mismatch is a *load-time* error (`validateObjective`), not a mission that quietly
 *      behaves like something else.
 *   3. **Progress is derived, never stored twice.** `objectiveProgress` reads the same state the
 *      completion rule reads, so the readout a player sees each turn cannot disagree with what ends
 *      the mission. The only new persisted state is what genuinely cannot be derived from the board:
 *      how many consecutive turns the zone has been held, and whether the item was picked up.
 *   4. **Failure is an outcome, not a defeat.** `escape` and `retrieve` can be *failed* while the hero
 *      is alive and every enemy is dead — the turn limit runs out. That is a third reason a mission
 *      can end, and the campaign layer records it distinctly from being knocked out.
 *
 * **Deliberately not implemented:** procedural objectives, multi-objective missions, optional
 * secondary goals. All three are out of scope for W6-01 and none of them is expressible in
 * `missions.json` today, so adding a hook for them would be speculative structure.
 */
import { isAlive, type Unit } from './combat'

/**
 * The four MVP objective types.
 *
 * `retrieve` and `escape` are no longer aliases of `secure`: each has its own completion rule below.
 */
export type ObjectiveType = 'eliminate' | 'secure' | 'retrieve' | 'escape'

export const OBJECTIVE_TYPES: readonly ObjectiveType[] = ['eliminate', 'secure', 'retrieve', 'escape']

/** A board cell. Objective geometry is absolute, in the same coordinates units use. */
export interface ObjectiveCell {
  x: number
  y: number
}

/**
 * Parameters per objective type, as a discriminated union rather than a bag of optional fields.
 *
 * The union is what makes "invalid params for this type" a *type* error in code and a load-time error
 * in content, instead of an undefined read at turn 3 of a live mission.
 */
export type ObjectiveParams =
  /** Nothing to configure: kill everything. */
  | { kind: 'eliminate' }
  /**
   * Hold `zone` for `holdTurns` consecutive player turns.
   *
   * `radius` is Chebyshev, so `0` means the exact cell and `1` means a 3×3 area. Holding is broken by
   * leaving *or* by an enemy standing inside the zone: a point is not secured while it is contested.
   */
  | { kind: 'secure'; zone: ObjectiveCell; radius: number; holdTurns: number }
  /**
   * Pick `itemId` up at `at`, then leave through `exit`.
   *
   * `itemId` is content's name for the objective item and is shown to the player; it is deliberately
   * *not* required to exist in `items.json`, because a mission objective is not inventory — see
   * `validateObjective`.
   */
  | { kind: 'retrieve'; itemId: string; at: ObjectiveCell; exit: ObjectiveCell }
  /** Reach `exit`. The simplest rule, and the one that most needs a live progress readout. */
  | { kind: 'escape'; exit: ObjectiveCell }

/**
 * Objective state that cannot be derived from the board.
 *
 * Kept as small as possible on purpose: everything else — enemies alive, hero position, turn number —
 * is already in the save, and duplicating it here would create a second source of truth that can
 * drift from the units array. `heldTurns` and `carrying` are the only two facts the board forgets.
 */
export interface ObjectiveState {
  /** Consecutive player turns the zone has been held. Resets to 0 the moment it is not held. */
  heldTurns: number
  /** Whether the objective item has been picked up. Always false for other objective types. */
  carrying: boolean
}

export const initialObjectiveState = (): ObjectiveState => ({ heldTurns: 0, carrying: false })

/**
 * How a mission can end.
 *
 * `failed` is the new outcome W6-01 introduces: the objective became unachievable, or its deadline
 * passed, while the hero is still standing. Distinct from a defeat because nothing was lost in
 * combat, and distinct from a retreat because the player did not choose it.
 */
export type ObjectiveOutcome = 'active' | 'complete' | 'failed'

export interface ObjectiveEvaluation {
  outcome: ObjectiveOutcome
  /** Why, in the player's language. Empty while `active` has nothing to explain. */
  reason: string
  /** The state to persist for the next turn. Never the input object when it changed. */
  state: ObjectiveState
}

export interface ObjectiveContext {
  params: ObjectiveParams
  state: ObjectiveState
  units: readonly Unit[]
  /** 1-based player turn, as `SaveData.turn` counts it. */
  turn: number
  /**
   * Turn after which an unfinished timed objective fails, or `undefined` for no deadline.
   *
   * Only `retrieve` and `escape` can time out. `eliminate` and `secure` cannot: an eliminate mission
   * with enemies left is simply not finished, and a secure mission's own `holdTurns` is its clock.
   */
  turnLimit?: number
}

const hero = (units: readonly Unit[]) => units.find((unit) => unit.id === 'hero')

/** Chebyshev distance: a `radius` zone is a square, which is what a grid player reads off the board. */
const withinZone = (at: ObjectiveCell, zone: ObjectiveCell, radius: number) =>
  Math.max(Math.abs(at.x - zone.x), Math.abs(at.y - zone.y)) <= radius

export const enemiesAlive = (units: readonly Unit[]) =>
  units.filter((unit) => unit.team === 'enemy' && isAlive(unit)).length

/**
 * Whether the zone is held *right now*: the hero stands inside it and no living enemy does.
 *
 * The contested clause is what stops `secure` from being "stand still for N turns while being shot":
 * an enemy inside the zone breaks the count, so securing a point means clearing it first.
 */
export function zoneHeld(units: readonly Unit[], zone: ObjectiveCell, radius: number): boolean {
  const operative = hero(units)
  if (!operative || !isAlive(operative)) return false
  if (!withinZone(operative, zone, radius)) return false
  return !units.some((unit) => unit.team === 'enemy' && isAlive(unit) && withinZone(unit, zone, radius))
}

/** Whether the hero is standing on the objective item's cell and has not taken it yet. */
export const canPickUp = (context: ObjectiveContext): boolean => {
  if (context.params.kind !== 'retrieve' || context.state.carrying) return false
  const operative = hero(context.units)
  return !!operative && isAlive(operative) && operative.x === context.params.at.x && operative.y === context.params.at.y
}

/**
 * Picks the objective item up. Refuses rather than no-ops silently, so a caller cannot report success
 * for an action that did nothing.
 */
export function pickUpObjective(context: ObjectiveContext): ObjectiveState | null {
  return canPickUp(context) ? { ...context.state, carrying: true } : null
}

const atExit = (units: readonly Unit[], exit: ObjectiveCell) => {
  const operative = hero(units)
  return !!operative && isAlive(operative) && operative.x === exit.x && operative.y === exit.y
}

const timedOut = (context: ObjectiveContext) =>
  context.turnLimit !== undefined && context.turn > context.turnLimit

/**
 * Advances the objective's **per-turn** clock. Called exactly once per resolved turn, at the turn
 * boundary, and nowhere else.
 *
 * Split from `evaluateObjective` after that function's first version got this wrong: it both counted a
 * held turn and reported completion, and it is called from two places (after a player action, and at
 * the end of the enemy phase). The result was a hold that advanced twice per turn, so `relay-station`
 * completed in ~1.3 turns instead of 2 — a two-turn objective finished before the second turn began.
 * With the clock separated, "how many turns has this been held" has exactly one writer and it is
 * impossible to double-count by adding another call site.
 *
 * The hold is measured on the board *after* the enemy has moved, which is the honest reading of
 * "held for a turn": the point was still yours when the turn ended.
 */
export function advanceObjectiveTurn(context: ObjectiveContext): ObjectiveState {
  const { params, state, units } = context
  if (params.kind !== 'secure') return state
  const held = zoneHeld(units, params.zone, params.radius)
  const heldTurns = held ? state.heldTurns + 1 : 0
  return heldTurns === state.heldTurns ? state : { ...state, heldTurns }
}

/**
 * The single completion rule, total over the four types.
 *
 * **Reads state; never advances it.** Safe to call after any action and as often as needed — the turn
 * clock belongs to `advanceObjectiveTurn`. `state` is returned unchanged so callers can keep treating
 * the evaluation as the one thing to persist.
 */
export function evaluateObjective(context: ObjectiveContext): ObjectiveEvaluation {
  const { params, state, units } = context
  const operative = hero(units)
  /* A dead hero is a defeat, which the combat layer owns. Reported as `active` so this module never
     competes with `missionDefeat` for the same transition. */
  if (!operative || !isAlive(operative)) return { outcome: 'active', reason: '', state }

  switch (params.kind) {
    case 'eliminate':
      return enemiesAlive(units) === 0
        ? { outcome: 'complete', reason: 'Все противники уничтожены.', state }
        : { outcome: 'active', reason: '', state }

    case 'secure':
      return state.heldTurns >= params.holdTurns
        ? { outcome: 'complete', reason: `Точка удержана ${params.holdTurns} ход(ов).`, state }
        : { outcome: 'active', reason: '', state }

    case 'retrieve': {
      if (state.carrying && atExit(units, params.exit))
        return { outcome: 'complete', reason: 'Груз доставлен к точке выхода.', state }
      /* Timing out with the item in hand and timing out without it are different failures, and the
         player deserves to be told which. */
      if (timedOut(context))
        return {
          outcome: 'failed',
          reason: state.carrying
            ? 'Время вышло: груз забран, но выйти не удалось.'
            : 'Время вышло: груз не найден.',
          state,
        }
      return { outcome: 'active', reason: '', state }
    }

    case 'escape': {
      if (atExit(units, params.exit)) return { outcome: 'complete', reason: 'Оперативник покинул зону.', state }
      if (timedOut(context)) return { outcome: 'failed', reason: 'Время вышло: выйти из зоны не удалось.', state }
      return { outcome: 'active', reason: '', state }
    }
  }
}

export interface ObjectiveProgress {
  kind: ObjectiveType
  /** Headline the player reads: what to do, and how far along it is. */
  label: string
  /** Short step readout, e.g. `2/3 ходов`. Empty when the objective has no countable step. */
  detail: string
  /** Steps done and needed, for a progress bar. `total` is 1 for a binary objective. */
  done: number
  total: number
  /** True when the objective can be finished by an action available right now. */
  actionable: boolean
  /** Turns left before a timed objective fails, or `null` when it has no deadline. */
  turnsLeft: number | null
}

/**
 * The per-turn readout (W6-01 criterion 2).
 *
 * Derived from the same inputs as `evaluateObjective`, deliberately: a progress bar computed from a
 * separate copy of the rules is exactly how a UI starts lying about the mission.
 */
export function objectiveProgress(context: ObjectiveContext): ObjectiveProgress {
  const { params, state, units } = context
  const turnsLeft = context.turnLimit === undefined ? null : Math.max(0, context.turnLimit - context.turn + 1)
  const base = { turnsLeft, actionable: false, detail: '', done: 0, total: 1 }

  switch (params.kind) {
    case 'eliminate': {
      const alive = enemiesAlive(units)
      const total = Math.max(1, units.filter((unit) => unit.team === 'enemy').length)
      return {
        ...base,
        kind: 'eliminate',
        label: 'Уничтожить всех противников',
        detail: `${total - alive}/${total} целей`,
        done: total - alive,
        total,
      }
    }
    case 'secure': {
      const held = zoneHeld(units, params.zone, params.radius)
      return {
        ...base,
        kind: 'secure',
        label: `Удерживать точку (${params.zone.x}, ${params.zone.y})`,
        detail: held
          ? `${state.heldTurns}/${params.holdTurns} ходов удержания`
          : `${state.heldTurns}/${params.holdTurns} ходов — точка не удерживается`,
        done: Math.min(state.heldTurns, params.holdTurns),
        total: params.holdTurns,
        actionable: held,
      }
    }
    case 'retrieve': {
      /*
       * Two steps, and the second one *is* the delivery. Counting only the pickup left the readout at
       * 1/2 on the turn the mission completed, which is the readout disagreeing with the rule that ended
       * the mission — the exact failure mode this whole function is shaped to avoid.
       */
      const delivered = state.carrying && atExit(units, params.exit)
      return {
        ...base,
        kind: 'retrieve',
        label: state.carrying
          ? `Доставить груз к выходу (${params.exit.x}, ${params.exit.y})`
          : `Забрать груз в (${params.at.x}, ${params.at.y})`,
        detail: delivered ? 'груз доставлен' : state.carrying ? 'груз забран' : 'груз не забран',
        done: (state.carrying ? 1 : 0) + (delivered ? 1 : 0),
        total: 2,
        actionable: canPickUp(context) || delivered,
      }
    }
    case 'escape':
      return {
        ...base,
        kind: 'escape',
        label: `Дойти до точки выхода (${params.exit.x}, ${params.exit.y})`,
        detail: atExit(units, params.exit) ? 'на точке выхода' : 'вне точки выхода',
        done: atExit(units, params.exit) ? 1 : 0,
        total: 1,
        actionable: atExit(units, params.exit),
      }
  }
}

export interface ObjectiveIssue {
  path: string
  message: string
}

const cellIssues = (value: unknown, path: string, bounds: ObjectiveBounds | undefined): ObjectiveIssue[] => {
  if (!value || typeof value !== 'object') return [{ path, message: 'объект { x, y }' }]
  const cell = value as Record<string, unknown>
  const issues: ObjectiveIssue[] = []
  for (const axis of ['x', 'y'] as const) {
    const coordinate = cell[axis]
    if (typeof coordinate !== 'number' || !Number.isInteger(coordinate) || coordinate < 0)
      issues.push({ path: `${path}.${axis}`, message: 'целое >= 0' })
    else if (bounds && coordinate >= (axis === 'x' ? bounds.width : bounds.height))
      /* Checked against the arena rather than left to the runtime: an exit outside the map is an
         unwinnable mission, and finding that out mid-encounter is the worst possible time. */
      issues.push({
        path: `${path}.${axis}`,
        message: `внутри арены (< ${axis === 'x' ? bounds.width : bounds.height})`,
      })
  }
  return issues
}

/** Arena dimensions an objective's geometry must fit inside, when the caller has them. */
export interface ObjectiveBounds {
  width: number
  height: number
}

/**
 * Validates raw `objectiveParams` against the declared objective type (W6-01 criterion 3).
 *
 * Returns the parsed union on success and every issue on failure. Two rules that are easy to miss:
 * `eliminate` must not carry params at all (a mission that looks configured but is not would be a
 * silent lie of the same family as the old `retrieve → secure` rewrite), and geometry is bounds-checked
 * against the arena when the arena is known.
 */
export function validateObjective(
  objective: unknown,
  params: unknown,
  path: string,
  bounds?: ObjectiveBounds,
): { ok: true; value: ObjectiveParams } | { ok: false; issues: ObjectiveIssue[] } {
  if (typeof objective !== 'string' || !(OBJECTIVE_TYPES as readonly string[]).includes(objective))
    return { ok: false, issues: [{ path: `${path}.objective`, message: OBJECTIVE_TYPES.join(' | ') }] }
  const kind = objective as ObjectiveType
  const paramsPath = `${path}.objectiveParams`

  if (kind === 'eliminate')
    return params === undefined || (typeof params === 'object' && params !== null && Object.keys(params).length === 0)
      ? { ok: true, value: { kind: 'eliminate' } }
      : { ok: false, issues: [{ path: paramsPath, message: 'цель eliminate не принимает параметров' }] }

  if (!params || typeof params !== 'object' || Array.isArray(params))
    return { ok: false, issues: [{ path: paramsPath, message: `обязателен для цели ${kind}` }] }
  const raw = params as Record<string, unknown>
  const issues: ObjectiveIssue[] = []

  if (kind === 'secure') {
    issues.push(...cellIssues(raw.zone, `${paramsPath}.zone`, bounds))
    const radius = raw.radius === undefined ? 0 : raw.radius
    if (typeof radius !== 'number' || !Number.isInteger(radius) || radius < 0 || radius > 3)
      issues.push({ path: `${paramsPath}.radius`, message: 'целое 0..3' })
    if (typeof raw.holdTurns !== 'number' || !Number.isInteger(raw.holdTurns) || raw.holdTurns < 1 || raw.holdTurns > 10)
      issues.push({ path: `${paramsPath}.holdTurns`, message: 'целое 1..10' })
    return issues.length
      ? { ok: false, issues }
      : {
          ok: true,
          value: {
            kind: 'secure',
            zone: raw.zone as ObjectiveCell,
            radius: radius as number,
            holdTurns: raw.holdTurns as number,
          },
        }
  }

  if (kind === 'retrieve') {
    if (typeof raw.itemId !== 'string' || raw.itemId.length === 0)
      issues.push({ path: `${paramsPath}.itemId`, message: 'непустая строка' })
    issues.push(...cellIssues(raw.at, `${paramsPath}.at`, bounds))
    issues.push(...cellIssues(raw.exit, `${paramsPath}.exit`, bounds))
    return issues.length
      ? { ok: false, issues }
      : {
          ok: true,
          value: {
            kind: 'retrieve',
            itemId: raw.itemId as string,
            at: raw.at as ObjectiveCell,
            exit: raw.exit as ObjectiveCell,
          },
        }
  }

  issues.push(...cellIssues(raw.exit, `${paramsPath}.exit`, bounds))
  return issues.length ? { ok: false, issues } : { ok: true, value: { kind: 'escape', exit: raw.exit as ObjectiveCell } }
}

/**
 * Every cell an objective names, labelled, so a caller with the arena in hand can bounds-check them.
 *
 * Separate from `validateObjective` because the two halves happen at different times: `missions.json`
 * is validated before any arena is fetched, so the shape check cannot know the map size. Returning
 * labelled cells rather than doing the check here keeps this module free of arena types.
 */
export function objectiveCells(params: ObjectiveParams): { label: string; cell: ObjectiveCell }[] {
  switch (params.kind) {
    case 'eliminate':
      return []
    case 'secure':
      return [{ label: 'zone', cell: params.zone }]
    case 'retrieve':
      return [
        { label: 'at', cell: params.at },
        { label: 'exit', cell: params.exit },
      ]
    case 'escape':
      return [{ label: 'exit', cell: params.exit }]
  }
}

/**
 * Bounds-checks an objective's geometry against the arena it runs on.
 *
 * A `secure` zone is checked at its *centre* only: a radius that overhangs the edge is a smaller
 * effective zone, not a broken mission, and rejecting it would forbid securing a corner.
 */
export function validateObjectiveGeometry(
  params: ObjectiveParams,
  bounds: ObjectiveBounds,
  path: string,
): ObjectiveIssue[] {
  return objectiveCells(params).flatMap(({ label, cell }) => {
    const issues: ObjectiveIssue[] = []
    if (cell.x >= bounds.width)
      issues.push({ path: `${path}.${label}.x`, message: `внутри арены (< ${bounds.width})` })
    if (cell.y >= bounds.height)
      issues.push({ path: `${path}.${label}.y`, message: `внутри арены (< ${bounds.height})` })
    return issues
  })
}

/** Whether a persisted objective state is structurally sound, for the save validator. */
export const isObjectiveState = (value: unknown): value is ObjectiveState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    typeof state.heldTurns === 'number' &&
    Number.isInteger(state.heldTurns) &&
    state.heldTurns >= 0 &&
    typeof state.carrying === 'boolean'
  )
}
