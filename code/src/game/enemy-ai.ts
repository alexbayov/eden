/**
 * Enemy turn resolution and movement choice, extracted from `combat.ts` unchanged (W6-02, step 1).
 *
 * **This module is a move, not a rewrite.** Every branch, comparison and roll below is the code that
 * previously lived on two lines of `combat.ts` — `chooseEnemyDestination` at 1122 characters and
 * `runEnemyTurn` at 3318. Nothing about the behaviour changed, and the tests that covered it are the
 * same tests. The extraction happens first and on its own so that the actual W6-02 changes (target
 * selection, reload, jam clearing, live `intent`) arrive as a readable diff instead of edits inside a
 * 3.3 kB line that no reviewer can check.
 *
 * The one thing deliberately made explicit rather than copied verbatim: the attack AP gate was the
 * literal `4`, which is `ATTACKS.torso.apCost`. It is now derived from the attack it gates, and
 * `enemy-ai.test.ts` asserts the two are equal — so this is provably the same number rather than a
 * coincidence maintained by hand.
 *
 * ---
 *
 * **What this code actually does today, stated plainly because the next commits change it.** Read as
 * a specification of the *current* AI, every line here is a limitation rather than a design:
 *
 *   - the target is hardcoded to the unit whose id is literally `'hero'`; there is no target choice;
 *   - the body part is hardcoded to `torso`; there are no aimed shots;
 *   - an enemy takes **one** shot per turn and discards whatever AP is left;
 *   - movement happens **only** when there is no line of sight, so an enemy that can already see the
 *     hero never repositions;
 *   - an enemy with an empty magazine does **not** reload, and one with a jam does **not** clear it —
 *     `reloadWeapon` and `clearMalfunction` exist and are called only by the player. A `wild-rusher`
 *     carrying the three-round `hornet` therefore fires three times and is harmless for the rest of
 *     the encounter, and a 15% jam chance per shot can silence it sooner;
 *   - `shooter` and `defender` share one comparator; the only difference is that a defender already in
 *     cover does not move at all. `hp` is never read, so there is no retreat threshold.
 *
 * **Determinism.** The decision is a pure function of `(units, cover, reach)` and never touches `roll`.
 * `roll` is consumed only at the two commit points — the enemy's attack and the Overwatch reaction —
 * always as `hit, crit, malfunction` in that literal order. That order is part of the measured system:
 * `sim/battle.ts` notes that the player consumes `malfunction, hit, crit` instead, and changing how many
 * values an enemy draws shifts every seeded result.
 */
import {
  advanceStatuses,
  blockingCells,
  canMove,
  cellKey,
  combatAttack,
  coverPenalty,
  defensiveCover,
  findReachable,
  getAttack,
  gridDistance,
  hasLineOfSight,
  isAlive,
  OVERWATCH_HIT_MODIFIER,
  startTurn,
  type BodyPart,
  type Cover,
  type EnemyTurnResult,
  type Point,
  type Reachability,
  type Unit,
} from './combat'

/**
 * The body part every enemy shoots at, and the AP gate derived from it.
 *
 * Named constants rather than the inline literals they replace, so the coupling between "enemies shoot
 * the torso" and "enemies need 4 AP to shoot" is visible instead of being two unrelated numbers.
 */
export const ENEMY_ATTACK_PART: BodyPart = 'torso'
export const ENEMY_ATTACK_AP = getAttack(ENEMY_ATTACK_PART).apCost

/**
 * The cell an enemy moves to, or `null` to stay put.
 *
 * Behaviour differences, in full — this is the entire behaviour system as it stands:
 *
 *   - `rusher` sorts by Manhattan distance to the hero ascending, ties broken by cell key. It ignores
 *     line of sight and cover completely.
 *   - `shooter` sorts by line of sight, then by cover, then by distance.
 *   - `defender` uses the **same comparator as `shooter`**. Its only distinct rule is the early return:
 *     a defender that already stands in any cover does not move.
 */
export function chooseEnemyDestination(
  enemy: Unit,
  hero: Unit,
  reach: Reachability,
  cover: Cover[],
  blocked: ReadonlySet<string>,
): Point | null {
  const options = [...reach.costs.keys()]
    .filter((key) => key !== cellKey(enemy.x, enemy.y))
    .map((key) => reach.paths.get(key)!.at(-1)!)
  if (!options.length) return null

  const los = (point: Point) => hasLineOfSight(point, hero, blocked)
  const cov = (point: Point) => defensiveCover(hero, point, cover)

  /* A defender that is already covered holds its ground; out of cover it behaves as a shooter. */
  if (enemy.behavior === 'defender' && cov(enemy) !== 'none') return null

  return (
    options.sort((left, right) =>
      enemy.behavior === 'rusher'
        ? gridDistance(left, hero) - gridDistance(right, hero) ||
          cellKey(left.x, left.y).localeCompare(cellKey(right.x, right.y))
        : Number(los(right)) - Number(los(left)) ||
          coverPenalty(cov(right)) - coverPenalty(cov(left)) ||
          gridDistance(left, hero) - gridDistance(right, hero),
    )[0] ?? null
  )
}

/** Battle-log line for a resolved attack, shared by the enemy shot and the Overwatch reaction. */
const outcomeLabel = (result: ReturnType<typeof combatAttack>) =>
  result.malfunctioned ? 'осечка' : result.attack?.hit ? `${result.attack.damage} урона` : 'промах'

/**
 * Resolves the whole enemy phase: every living enemy acts once, in `units` array order.
 *
 * Per enemy: restore AP, take one torso shot at the hero if it has the AP and a firing line, then — only
 * if it has *no* firing line — walk toward a chosen cell, checking Overwatch on every step. Statuses
 * decay at the end of each enemy's own turn, and the hero's Overwatch is cleared once the phase ends
 * whether or not it fired.
 */
export function runEnemyTurn(
  units: Unit[],
  width: number,
  height: number,
  cover: Cover[],
  roll: () => number,
): EnemyTurnResult {
  let next = units.map((unit) => (unit.team === 'enemy' && isAlive(unit) ? startTurn(unit) : { ...unit }))
  const log: string[] = []
  const unitById = (id: string) => next.find((unit) => unit.id === id)!

  /**
   * The hero's single Overwatch reaction, fired when an enemy steps from no-LOS into LOS.
   *
   * Always a torso shot through the same `combatAttack` pipeline as any other, so it spends a round and
   * durability exactly like a normal shot, and it is consumed afterwards (`overwatch: undefined`).
   */
  const reactToMovement = (enemyId: string): boolean => {
    const hero = unitById('hero')
    const enemy = unitById(enemyId)
    if (
      !isAlive(hero) ||
      !isAlive(enemy) ||
      !hero.overwatch ||
      hero.overwatch.reservedAp < getAttack('torso').apCost
    )
      return false

    const reactingHero = { ...hero, ap: hero.overwatch.reservedAp }
    const result = combatAttack(
      reactingHero,
      enemy,
      'torso',
      defensiveCover(reactingHero, enemy, cover),
      { hit: roll(), crit: roll(), malfunction: roll() },
      OVERWATCH_HIT_MODIFIER,
    )
    const resolvedHero = { ...result.unit, ap: 0, overwatch: undefined }
    next = next.map((unit) =>
      unit.id === hero.id ? resolvedHero : unit.id === enemy.id ? result.target : unit,
    )
    /* Logged only after the result exists, so the line can never claim an outcome that never resolved. */
    if (result.ok) log.push(`Overwatch: ${outcomeLabel(result)}.`)
    return result.ok
  }

  /* Ids are captured before the loop: an enemy killed by an Overwatch reaction mid-phase must not
     change who else gets a turn. */
  const enemyIds = next.filter((unit) => unit.team === 'enemy' && isAlive(unit)).map((unit) => unit.id)

  for (const id of enemyIds) {
    let enemy = unitById(id)
    let hero = unitById('hero')

    // ---- one shot, if there is AP and a firing line ------------------------------------------
    if (
      isAlive(hero) &&
      isAlive(enemy) &&
      enemy.ap >= ENEMY_ATTACK_AP &&
      hasLineOfSight(enemy, hero, blockingCells(next, cover, [enemy.id, hero.id]))
    ) {
      const result = combatAttack(enemy, hero, ENEMY_ATTACK_PART, defensiveCover(enemy, hero, cover), {
        hit: roll(),
        crit: roll(),
        malfunction: roll(),
      })
      next = next.map((unit) =>
        unit.id === enemy.id ? result.unit : unit.id === hero.id ? result.target : unit,
      )
      enemy = unitById(id)
      hero = unitById('hero')
      log.push(`${enemy.name}: ${outcomeLabel(result)}.`)
    }

    // ---- movement, only as a no-line-of-sight recovery ---------------------------------------
    if (
      isAlive(enemy) &&
      canMove(enemy) &&
      !hasLineOfSight(enemy, hero, blockingCells(next, cover, [enemy.id, hero.id]))
    ) {
      const reach = findReachable(enemy, enemy.ap, width, height, blockingCells(next, cover, [enemy.id]))
      const point = chooseEnemyDestination(
        enemy,
        hero,
        reach,
        cover,
        blockingCells(next, cover, [enemy.id, hero.id]),
      )
      const path = point ? reach.paths.get(cellKey(point.x, point.y)) : null

      if (path) {
        let moved = false
        /* Walked cell by cell at 1 AP each, because Overwatch reacts to the *step* that reveals the
           enemy, not to the destination. */
        for (const step of path.slice(1)) {
          const beforeMove = unitById(id)
          const currentHero = unitById('hero')
          const beforeLos = hasLineOfSight(
            beforeMove,
            currentHero,
            blockingCells(next, cover, [beforeMove.id, currentHero.id]),
          )

          next = next.map((unit) => (unit.id === id ? { ...unit, ...step, ap: unit.ap - 1 } : unit))

          const afterMove = unitById(id)
          const afterHero = unitById('hero')
          const afterLos = hasLineOfSight(
            afterMove,
            afterHero,
            blockingCells(next, cover, [afterMove.id, afterHero.id]),
          )
          moved = true

          if (!beforeLos && afterLos) {
            reactToMovement(id)
            if (!isAlive(unitById(id))) break
          }
        }
        if (moved) log.push(`${enemy.name}: перемещение.`)
      }
    }

    next = next.map((unit) => (unit.id === id ? advanceStatuses(unit) : unit))
  }

  /* Overwatch is spent by the phase whether or not it fired: it is a reaction to *this* enemy turn. */
  next = next.map((unit) => (unit.id === 'hero' ? { ...unit, overwatch: undefined } : unit))
  return { units: next, log, heroDefeated: !isAlive(unitById('hero')) }
}
