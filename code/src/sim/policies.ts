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
}

export type PolicyDecision =
  | { kind: 'attack'; target: Unit; part: BodyPart }
  | { kind: 'reload' }
  | { kind: 'move'; to: Point; cost: number }
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

/** Shared skeleton: reposition (optional) -> fire -> reload -> approach -> pass. */
function shooter(id: PolicyId, description: string, part: BodyPart, useCover: boolean): Policy {
  return {
    id,
    description,
    decide(context) {
      const { hero } = context
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
