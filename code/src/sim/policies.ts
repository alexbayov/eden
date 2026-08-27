/**
 * Hero decision policies for the balance simulator (W3-01).
 *
 * A policy stands in for the player. It only chooses between actions the game already offers —
 * which enemy, which body part, reload, unjam, reposition, pass — and never computes an outcome.
 * All three policies are deterministic given identical state (ties broken by cell/unit id) so a
 * seed fully determines a battle.
 *
 * These are not "good play". They are three reference behaviours that bracket the interesting
 * range:
 *
 *   | policy          | body part | uses cover | why it exists |
 *   |-----------------|-----------|------------|---------------|
 *   | `greedy-torso`  | torso     | no         | throughput floor: cheapest reliable shot, no positioning |
 *   | `cover-torso`   | torso     | yes        | the intended play pattern |
 *   | `cover-head`    | head      | yes        | damage/execution ceiling at a 25-point accuracy penalty |
 *
 * `cover-head` falls back to a torso shot when a head shot is unaffordable (6 AP vs 4), because a
 * policy that stalls would measure the stall rather than head-shot play.
 *
 * A policy returns exactly one action per call and is asked again after it resolves, so
 * "take cover, then shoot" is two decisions rather than a compound one.
 */
import {
  canMove,
  cellKey,
  coverPenalty,
  defensiveCover,
  getAttack,
  gridDistance,
  hasLineOfSight,
  type BodyPart,
  type Cover,
  type CoverType,
  type Point,
  type Reachability,
  type Unit,
} from '../game/combat'
import type { ArenaConfig } from '../game/content'
import type { ObjectiveParams, ObjectiveState } from '../game/objective'

export interface PolicyContext {
  hero: Unit
  /** Living enemies. */
  enemies: Unit[]
  /** Enemies the hero currently has a firing line to. */
  visibleEnemies: Unit[]
  arena: ArenaConfig
  cover: Cover[]
  /** Cover the target benefits from against the hero, i.e. the hero's accuracy penalty. */
  coverFor: (target: Unit) => CoverType
  /** Cells the hero can reach with current AP. Memoised by the caller; safe to call repeatedly. */
  reachable: () => Reachability
  /**
   * The encounter's objective and its live state.
   *
   * Needed because two of the four objective types cannot be played by fighting at all: `retrieve` is finished by
   * standing on a cell, taking an item and walking to an exit, and `escape` by reaching an exit. A policy without
   * this could only ever shoot, which is why the first `retrieve` encounter measured a 0% win rate over 103 runs
   * while being perfectly winnable — the simulator had no way to express the winning line.
   *
   * Optional so that every existing caller and fixture keeps compiling; when absent the policies behave exactly as
   * they did before, which is what keeps the `eliminate`/`secure` corridors comparable.
   */
  objective?: { params: ObjectiveParams; state: ObjectiveState }
}

export type PolicyDecision =
  | { kind: 'attack'; target: Unit; part: BodyPart }
  | { kind: 'reload' }
  | { kind: 'move'; to: Point; cost: number }
  /** Take the `retrieve` objective's item; only legal on its cell, and the runtime re-checks that. */
  | { kind: 'pick-up' }
  | { kind: 'pass' }

export interface Policy {
  id: string
  description: string
  decide: (context: PolicyContext) => PolicyDecision
}

export const POLICY_IDS = ['greedy-torso', 'cover-torso', 'cover-head'] as const
export type PolicyId = (typeof POLICY_IDS)[number]

/** Lowest HP first, then least cover, then id: a stable "finish the weakest reachable target". */
const pickTarget = (context: PolicyContext): Unit | null =>
  [...context.visibleEnemies].sort(
    (left, right) =>
      left.hp - right.hp ||
      coverPenalty(context.coverFor(left)) - coverPenalty(context.coverFor(right)) ||
      left.id.localeCompare(right.id),
  )[0] ?? null

const canFire = (hero: Unit, part: BodyPart) =>
  Boolean(hero.weaponState) &&
  !hero.weaponState!.malfunctioned &&
  hero.weaponState!.magazine > 0 &&
  hero.ap >= getAttack(part).apCost

const canReload = (hero: Unit) =>
  Boolean(hero.weaponState) &&
  !hero.weaponState!.malfunctioned &&
  hero.weaponState!.magazine < hero.weaponState!.magazineSize &&
  hero.weaponState!.reserveAmmo > 0 &&
  hero.ap >= hero.weaponState!.reloadAp

const fullCoverCells = (arena: ArenaConfig) =>
  new Set(arena.cover.filter((entry) => entry.type === 'full').map((entry) => cellKey(entry.x, entry.y)))

/**
 * The best reachable cell that strictly improves the hero's cover against `target`, keeps a firing
 * line, and still leaves `apAfter` action points for the shot. `null` when standing still is at
 * least as good — the caller then shoots instead of wandering.
 */
function betterCover(context: PolicyContext, target: Unit, apAfter: number): { to: Point; cost: number } | null {
  const { hero, cover, arena } = context
  const reach = context.reachable()
  const here = cellKey(hero.x, hero.y)
  const current = coverPenalty(defensiveCover(target, hero, cover))
  const blocked = fullCoverCells(arena)
  const options = [...reach.costs.keys()]
    .filter((key) => key !== here)
    .map((key) => ({ point: reach.paths.get(key)!.at(-1)!, cost: reach.costs.get(key)! }))
    .filter((entry) => hero.ap - entry.cost >= apAfter)
    .filter((entry) => hasLineOfSight(entry.point, target, blocked))
    .map((entry) => ({ ...entry, cover: coverPenalty(defensiveCover(target, { ...hero, ...entry.point }, cover)) }))
    .filter((entry) => entry.cover > current)
    .sort(
      (left, right) =>
        right.cover - left.cover ||
        left.cost - right.cost ||
        cellKey(left.point.x, left.point.y).localeCompare(cellKey(right.point.x, right.point.y)),
    )
  return options[0] ? { to: options[0].point, cost: options[0].cost } : null
}

/** Closes distance to `target`. Used only when nothing is visible, so a battle cannot stall. */
function approach(context: PolicyContext, target: Unit): { to: Point; cost: number } | null {
  const { hero } = context
  const reach = context.reachable()
  const here = cellKey(hero.x, hero.y)
  const current = gridDistance(hero, target)
  const options = [...reach.costs.keys()]
    .filter((key) => key !== here)
    .map((key) => ({ point: reach.paths.get(key)!.at(-1)!, cost: reach.costs.get(key)! }))
    .filter((entry) => gridDistance(entry.point, target) < current)
    .sort(
      (left, right) =>
        gridDistance(left.point, target) - gridDistance(right.point, target) ||
        left.cost - right.cost ||
        cellKey(left.point.x, left.point.y).localeCompare(cellKey(right.point.x, right.point.y)),
    )
  return options[0] ? { to: options[0].point, cost: options[0].cost } : null
}

const nearestEnemy = (context: PolicyContext): Unit | null =>
  [...context.enemies].sort(
    (left, right) =>
      gridDistance(context.hero, left) - gridDistance(context.hero, right) || left.id.localeCompare(right.id),
  )[0] ?? null

/** A step toward `goal`, or the goal itself when it is reachable this turn. Cheapest, then stable by cell. */
function stepToward(context: PolicyContext, goal: Point): { to: Point; cost: number } | null {
  const { hero } = context
  const reach = context.reachable()
  const here = cellKey(hero.x, hero.y)
  const direct = reach.costs.get(cellKey(goal.x, goal.y))
  if (direct !== undefined && direct >= 1 && direct <= hero.ap) return { to: goal, cost: direct }
  const current = gridDistance(hero, goal)
  const options = [...reach.costs.keys()]
    .filter((key) => key !== here)
    .map((key) => ({ point: reach.paths.get(key)!.at(-1)!, cost: reach.costs.get(key)! }))
    .filter((entry) => entry.cost <= hero.ap && gridDistance(entry.point, goal) < current)
    .sort(
      (left, right) =>
        gridDistance(left.point, goal) - gridDistance(right.point, goal) ||
        left.cost - right.cost ||
        cellKey(left.point.x, left.point.y).localeCompare(cellKey(right.point.x, right.point.y)),
    )
  return options[0] ? { to: options[0].point, cost: options[0].cost } : null
}

/**
 * The objective's own winning line, for the two types that combat cannot finish.
 *
 * Returns `null` for `eliminate` and `secure`, so those encounters keep taking exactly the decisions they took
 * before this existed — that is deliberate and load-bearing, because their win-rate corridors were measured with the
 * old behaviour and a "smarter" hero would have invalidated them without any balance change.
 *
 * For `retrieve`/`escape` the objective takes priority over shooting. That is the honest reading of the mission: the
 * player is told to carry something out or to leave, and a hero who stops to win a firefight they were not asked to
 * win is measuring an `eliminate`. Enemies still shoot back throughout, so the cost of ignoring them is paid in the
 * damage-taken and win-rate numbers rather than assumed away.
 */
function objectiveMove(context: PolicyContext): PolicyDecision | null {
  const objective = context.objective
  if (!objective) return null
  const { hero } = context
  const { params, state } = objective
  if (params.kind === 'escape') {
    if (hero.x === params.exit.x && hero.y === params.exit.y) return { kind: 'pass' }
    if (!canMove(hero) || hero.ap < 1) return null
    const step = stepToward(context, params.exit)
    return step ? { kind: 'move', ...step } : null
  }
  if (params.kind === 'secure') {
    /*
     * Only once the board is cleared, and only to step onto the point.
     *
     * A `secure` mission is finished by *standing* somewhere, and nothing in the policy layer ever walked there:
     * `relay-station` passes only because one of its enemies happens to stand inside the hold zone, so "approach the
     * nearest enemy" coincides with "enter the zone". On a map where it does not coincide, the simulator killed
     * everything, kept the hero at full HP and then idled to the turn limit — measured as 31.9% `turn-limit` and a
     * 0% win rate on a mission a player finishes by taking four steps.
     *
     * Deliberately gated on there being **no living enemy left**, rather than pursuing the point under fire. That is
     * the narrow case where the objective is achievable at zero risk and failing it is unambiguously a simulator
     * defect. It also cannot alter any battle in which an enemy is still alive, which is what keeps the existing
     * `relay-station` corridor a comparable measurement instead of a number produced by a different policy.
     */
    if (context.enemies.length > 0) return null
    const inside = Math.max(Math.abs(hero.x - params.zone.x), Math.abs(hero.y - params.zone.y)) <= params.radius
    if (inside) return null
    if (!canMove(hero) || hero.ap < 1) return null
    const step = stepToward(context, params.zone)
    return step ? { kind: 'move', ...step } : null
  }
  if (params.kind === 'retrieve') {
    if (!state.carrying) {
      if (hero.x === params.at.x && hero.y === params.at.y) return { kind: 'pick-up' }
      if (!canMove(hero) || hero.ap < 1) return null
      const step = stepToward(context, params.at)
      return step ? { kind: 'move', ...step } : null
    }
    if (hero.x === params.exit.x && hero.y === params.exit.y) return { kind: 'pass' }
    if (!canMove(hero) || hero.ap < 1) return null
    const step = stepToward(context, params.exit)
    return step ? { kind: 'move', ...step } : null
  }
  return null
}

/**
 * Shared skeleton: pursue a `retrieve`/`escape` objective -> reposition (optional) -> fire -> reload -> approach ->
 * pass.
 *
 * The objective step is first and returns `null` for `eliminate`/`secure`, so those encounters fall through to the
 * exact sequence this function has always run.
 */
function shooter(id: PolicyId, description: string, part: BodyPart, useCover: boolean): Policy {
  return {
    id,
    description,
    decide(context) {
      const { hero } = context
      const objectiveStep = objectiveMove(context)
      if (objectiveStep) return objectiveStep
      const target = pickTarget(context)
      if (target) {
        const firePart = canFire(hero, part) ? part : part !== 'torso' && canFire(hero, 'torso') ? 'torso' : null
        if (useCover && canMove(hero)) {
          const cost = getAttack(firePart ?? 'torso').apCost
          const step = betterCover(context, target, cost)
          if (step) return { kind: 'move', ...step }
        }
        if (firePart) return { kind: 'attack', target, part: firePart }
        if (canReload(hero)) return { kind: 'reload' }
        return { kind: 'pass' }
      }
      if (canReload(hero)) return { kind: 'reload' }
      const closest = nearestEnemy(context)
      if (closest && canMove(hero) && hero.ap > 0) {
        const step = approach(context, closest)
        if (step) return { kind: 'move', ...step }
      }
      return { kind: 'pass' }
    },
  }
}

export const POLICIES: Record<PolicyId, Policy> = {
  'greedy-torso': shooter(
    'greedy-torso',
    'Всегда стреляет в торс по самой слабой видимой цели; укрытие не используется.',
    'torso',
    false,
  ),
  'cover-torso': shooter(
    'cover-torso',
    'Занимает лучшее укрытие с сохранением линии огня, затем стреляет в торс.',
    'torso',
    true,
  ),
  'cover-head': shooter(
    'cover-head',
    'Занимает укрытие и стреляет в голову; при недостатке ОЧ переходит на торс.',
    'head',
    true,
  ),
}

export const policyById = (id: string): Policy => {
  const policy = POLICIES[id as PolicyId]
  if (!policy) throw new Error(`Неизвестная политика: ${id}. Доступны: ${POLICY_IDS.join(', ')}.`)
  return policy
}
