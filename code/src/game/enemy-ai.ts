/**
 * W6-02 — applies enemy decisions to the board. `enemy-decision.ts` decides; this module executes.
 *
 * The split is the point. Everything that *chooses* is pure and roll-free, so "the AI cannot read a die
 * the player has not seen" is a property of a signature rather than a claim in a comment. Everything that
 * *commits* — the dice, the AP, the log — lives here.
 *
 * **What changed against the pre-W6-02 loop.** The old version took at most one torso shot at the unit
 * literally named `'hero'`, then moved only if it had no line of sight, then discarded whatever AP was
 * left. It never reloaded and never cleared a jam, both of which it had primitives for. So an enemy with
 * an empty magazine stood still, and an enemy with a jam was harmless for the rest of the encounter — a
 * `wild-rusher` with the three-round `hornet` fired three times, often fewer given a 15% jam chance per
 * shot, and then followed the hero around doing nothing.
 *
 * Now the loop asks for a decision, applies it, and asks again until the enemy runs out of AP or options.
 * That is what lets one enemy clear a jam *and* shoot in the same turn.
 *
 * **Termination is structural, not assumed.** Every action costs at least 1 AP (`clear-jam` 2, `reload`
 * `reloadAp >= 1`, `move` `cost >= 1`, `attack` `apCost >= 4`), so the enemy's AP strictly decreases and
 * `hold` ends the turn. The guard below turns that into an enforced invariant: a future action kind that
 * spent nothing would end the turn instead of spinning forever.
 *
 * **Roll order is part of the measured system.** `roll` is consumed only at the two commit points — the
 * enemy's shot and the Overwatch reaction — always as `hit, crit, malfunction`. `sim/battle.ts` notes the
 * player draws `malfunction, hit, crit` instead. Changing *how many* values an enemy draws shifts every
 * seeded result, which is why W6-02 required re-measuring the balance corridors rather than assuming the
 * old numbers still described the game.
 */
import {
  advanceStatuses,
  blockingCells,
  cellKey,
  clearMalfunction,
  combatAttack,
  defensiveCover,
  findReachable,
  getAttack,
  hasLineOfSight,
  isAlive,
  OVERWATCH_HIT_MODIFIER,
  reloadWeapon,
  startTurn,
  type Cover,
  type EnemyTurnResult,
  type Unit,
} from './combat'
import { CLEAR_JAM_AP, decideEnemyAction, type EnemyDecision } from './enemy-decision'

export { ENEMY_ATTACK_AP, ENEMY_ATTACK_PART } from './enemy-decision'

/** Battle-log line for a resolved attack, shared by the enemy shot and the Overwatch reaction. */
const outcomeLabel = (result: ReturnType<typeof combatAttack>) =>
  result.malfunctioned ? 'осечка' : result.attack?.hit ? `${result.attack.damage} урона` : 'промах'

/**
 * Resolves the whole enemy phase: every living enemy spends its turn, in `units` array order.
 *
 * Per enemy: restore AP, then act until out of AP or out of useful options. `intent` is written from the
 * decision that was actually taken, which is what makes the label on the target list true (criterion 5)
 * instead of a static string copied off the archetype. Statuses decay at the end of each enemy's own turn,
 * and the hero's Overwatch is cleared once the phase ends whether or not it fired.
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

  /**
   * Walks the enemy to `to` one cell at a time, checking Overwatch on every step.
   *
   * Cell by cell rather than teleporting to the destination, because Overwatch reacts to the *step* that
   * reveals the enemy, not to where it ends up. Returns false when the enemy died on the way, so the
   * caller stops spending its turn.
   */
  const walk = (id: string, to: { x: number; y: number }, blockedForPath: ReadonlySet<string>): boolean => {
    const mover = unitById(id)
    const reach = findReachable(mover, mover.ap, width, height, blockedForPath)
    const path = reach.paths.get(cellKey(to.x, to.y))
    if (!path || path.length < 2) return true

    for (const step of path.slice(1)) {
      const beforeMove = unitById(id)
      const hostiles = next.filter((unit) => unit.team !== beforeMove.team && isAlive(unit))
      const watcher = hostiles.find((unit) => unit.overwatch)
      const losBefore = watcher
        ? hasLineOfSight(beforeMove, watcher, blockingCells(next, cover, [beforeMove.id, watcher.id]))
        : false

      next = next.map((unit) => (unit.id === id ? { ...unit, ...step, ap: unit.ap - 1 } : unit))

      if (watcher) {
        const afterMove = unitById(id)
        const afterWatcher = unitById(watcher.id)
        const losAfter = hasLineOfSight(
          afterMove,
          afterWatcher,
          blockingCells(next, cover, [afterMove.id, afterWatcher.id]),
        )
        /* Only a genuine no-LOS → LOS edge triggers the reaction; the invariant predates W6-02. */
        if (!losBefore && losAfter) {
          reactToMovement(id)
          if (!isAlive(unitById(id))) return false
        }
      }
    }
    return true
  }

  for (const id of enemyIds) {
    /*
     * One action per iteration; the turn ends on `hold`, on death, or when nothing was spent. The AP guard
     * makes termination an enforced invariant rather than an assumption about action costs.
     */
    let apGuard = Number.POSITIVE_INFINITY
    let lastDecision: EnemyDecision | null = null
    /* Counted by the caller because the decision function is pure and stateless. Caps the shots per turn
       so W6-02 does not silently double enemy damage output — see `ENEMY_SHOTS_PER_TURN`. */
    let shotsFired = 0

    for (;;) {
      const enemy = unitById(id)
      if (!isAlive(enemy)) break
      if (enemy.ap >= apGuard) break
      apGuard = enemy.ap

      const context = { enemy, units: next, cover, width, height, shotsFired }
      const chosen = decideEnemyAction(context)
      const { action } = chosen

      /*
       * `intent` records the last action actually *taken*, not the last decision *made*.
       *
       * Every turn ends on a `hold` — that is how the loop terminates — so recording every decision would
       * overwrite "fired at the operative" with "waits" on the way out, and the label would read as though
       * the enemy had done nothing on the turn it shot someone. A `hold` is only meaningful as an intent
       * when it is the *whole* turn, which is the `?? chosen` below.
       */
      if (action.kind === 'hold') {
        lastDecision ??= chosen
        break
      }
      lastDecision = chosen

      if (action.kind === 'clear-jam') {
        const cleared = clearMalfunction(enemy, CLEAR_JAM_AP)
        if (!cleared) break
        next = next.map((unit) => (unit.id === id ? cleared : unit))
        log.push(`${enemy.name}: осечка устранена.`)
        continue
      }

      if (action.kind === 'reload') {
        const reloaded = reloadWeapon(enemy)
        if (!reloaded) break
        next = next.map((unit) => (unit.id === id ? reloaded : unit))
        log.push(`${enemy.name}: перезарядка.`)
        continue
      }

      if (action.kind === 'move') {
        const survived = walk(id, action.to, blockingCells(next, cover, [id]))
        log.push(`${enemy.name}: перемещение.`)
        if (!survived) break
        continue
      }

      const target = unitById(action.targetId)
      if (!isAlive(target)) break
      const result = combatAttack(enemy, target, action.part, defensiveCover(enemy, target, cover), {
        hit: roll(),
        crit: roll(),
        malfunction: roll(),
      })
      if (!result.ok) break
      shotsFired += 1
      next = next.map((unit) =>
        unit.id === enemy.id ? result.unit : unit.id === target.id ? result.target : unit,
      )
      log.push(`${enemy.name}: ${outcomeLabel(result)}.`)
    }

    /* `intent` records what this enemy actually did, so the target list cannot describe a plan the unit
       never carried out (criterion 5). */
    next = next.map((unit) =>
      unit.id === id
        ? advanceStatuses(lastDecision ? { ...unit, intent: lastDecision.intent } : unit)
        : unit,
    )
  }

  /* Overwatch is spent by the phase whether or not it fired: it is a reaction to *this* enemy turn. */
  next = next.map((unit) => (unit.id === 'hero' ? { ...unit, overwatch: undefined } : unit))
  return { units: next, log, heroDefeated: !isAlive(unitById('hero')) }
}
