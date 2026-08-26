/**
 * W6-02 — the enemy's decision, as one ordered list of priorities.
 *
 * Split from `enemy-ai.ts` on purpose: **this module decides, that one applies.** The separation is what
 * makes criterion 6 ("the AI has no access to information the player lacks") checkable rather than
 * merely claimed — `decideEnemyAction` does not receive `roll`, so it *cannot* read a future die, and
 * that is a fact about its signature instead of a promise in a comment.
 *
 * Three properties hold structurally:
 *
 *   1. **Pure and roll-free.** Same board, same decision, byte for byte. No randomness, no clock, no
 *      hidden state between turns beyond what lives on the `Unit` itself.
 *   2. **One rule fires, and it says which.** `EnemyDecision.rule` names the priority that produced the
 *      action, so a test asserts *why* an enemy did something rather than only what it did. A rule
 *      without a test is visible as a missing `rule` value.
 *   3. **`intent` is derived from the decision, not from the catalog.** Previously `intent` was a static
 *      string copied off the archetype at hydration and never updated, so criterion 5 ("intent matches
 *      the actual action") failed by construction: the label said "closes distance and attacks" whether
 *      the enemy attacked, stood still, or sat jammed. Now the same object carries both.
 *
 * **What this fixes, concretely.** Before W6-02 an enemy with an empty magazine did nothing and an enemy
 * with a jam did nothing *for the rest of the encounter*. A `wild-rusher` carries the three-round
 * `hornet` with `makeshift: true`, so it fired three times — often fewer, since `makeshift` means a 15%
 * jam chance per shot — and was then harmless. Both primitives (`reloadWeapon`, `clearMalfunction`)
 * already existed and were player-only.
 *
 * **Deliberately not implemented:** learned behaviour, morale and panic as systems, group coordination.
 * All three are out of scope for W6-02 and none of them is expressible in the current data.
 */
import {
  ATTACKS,
  blockingCells,
  canMove,
  cellKey,
  coverPenalty,
  defensiveCover,
  findReachable,
  getAttack,
  gridDistance,
  hasLineOfSight,
  isAlive,
  type BodyPart,
  type Cover,
  type CoverType,
  type EnemyBehavior,
  type Point,
  type Reachability,
  type Unit,
} from './combat'

/** What an enemy does with its turn. One action per decision; the caller loops. */
export type EnemyAction =
  | { kind: 'attack'; targetId: string; part: BodyPart }
  | { kind: 'move'; to: Point; cost: number }
  | { kind: 'reload' }
  | { kind: 'clear-jam' }
  /** Nothing useful is possible. Ends the enemy's turn rather than spinning. */
  | { kind: 'hold' }

/**
 * The ordered priority that produced an action.
 *
 * A closed union rather than a free string so a new rule has to be named here — and therefore has to be
 * given a player-facing `intent` sentence and a test — instead of appearing as an unexplained action.
 */
export type EnemyRule =
  | 'clear-jam'
  | 'reload-empty'
  | 'retreat-wounded'
  | 'attack-in-range'
  | 'seek-firing-line'
  | 'close-distance'
  | 'hold-cover'
  | 'no-action'

export interface EnemyDecision {
  action: EnemyAction
  /** Shown to the player on the target list. Describes *this* decision. */
  intent: string
  rule: EnemyRule
}

/**
 * Role parameters, as data rather than as branches in a comparator.
 *
 * The old code expressed the entire behaviour system as one ternary inside one `sort`, where `shooter`
 * and `defender` shared an identical comparator and `hp` was read nowhere. Naming the parameters makes
 * the roles differ measurably (criterion 7) and makes a new role a data change.
 *
 * `retreatBelow` is a fraction of `maxHp`. `0` disables retreat, which is the honest value for a rusher:
 * a unit whose whole role is closing distance does not withdraw, and giving it a threshold would make it
 * behave like a shooter with extra steps.
 */
export interface BehaviorProfile {
  /** Preferred distance to the target. The role's comfort band, in grid steps. */
  idealDistance: number
  /** Below this share of `maxHp` the enemy breaks contact instead of trading shots. */
  retreatBelow: number
  /** Weight on standing in cover when ranking cells. `0` ignores cover entirely. */
  coverWeight: number
  /** Weight on holding a firing line when ranking cells. */
  lineOfSightWeight: number
  /** True when the role stays put once it is covered and has a line of fire. */
  holdsPosition: boolean
}

/**
 * Shipped profiles.
 *
 * Numbers chosen to preserve the *recognisable* behaviour of each role while making the three actually
 * distinct: the rusher still closes to melee range and ignores cover, the shooter still prefers a
 * covered firing position, and the defender still refuses to give up cover. What is new is that all
 * three now read `hp`, and that the shooter and the defender no longer rank cells identically.
 */
export const BEHAVIOR_PROFILES: Record<EnemyBehavior, BehaviorProfile> = {
  /* Sits at rifle range behind cover; falls back when badly hurt. */
  shooter: { idealDistance: 4, retreatBelow: 0.3, coverWeight: 2, lineOfSightWeight: 3, holdsPosition: false },
  /* Closes to point blank and never withdraws: that is the whole role. */
  rusher: { idealDistance: 1, retreatBelow: 0, coverWeight: 0, lineOfSightWeight: 1, holdsPosition: false },
  /* Holds ground. The highest cover weight and the only role that will not trade cover for a shot. */
  defender: { idealDistance: 5, retreatBelow: 0.25, coverWeight: 4, lineOfSightWeight: 2, holdsPosition: true },
}

export const profileFor = (behavior: EnemyBehavior | undefined): BehaviorProfile =>
  BEHAVIOR_PROFILES[behavior ?? 'shooter']

/**
 * Shots one enemy may fire per turn.
 *
 * **This is a balance decision, and it is deliberately conservative.** Enemies restore 10 AP and a torso
 * shot costs 4, so an unconstrained "spend all AP" loop fires **twice** — which is exactly what the first
 * version of W6-02 did. Measured on 1000 chain runs: damage to the hero rose 7.47 → 11.04 and the zone win
 * rate fell 80.1% → 59.8%, putting all three balance-lock corridors out of range.
 *
 * That is a tempo change to the whole game, and W6-02's mandate is to make the AI *behave sensibly*, not
 * to double enemy output. The ticket asks that an enemy with an empty magazine reloads instead of wasting
 * its turn, and that a jammed one clears the jam; it says nothing about firing more often. So the cap
 * holds the old rate, and the reclaimed AP goes into reloading, unjamming and repositioning — the actions
 * that were missing — rather than into extra damage.
 *
 * Raising this to 2 is a legitimate design choice, but it needs an owner decision and re-approved
 * corridors, which belongs to a balance pass rather than here. `enemy-decision.test.ts` pins the measured
 * consequence so the trade-off is not rediscovered by accident.
 */
export const ENEMY_SHOTS_PER_TURN = 1

export interface EnemyContext {
  enemy: Unit
  /** Every unit on the board, including the enemy itself. */
  units: readonly Unit[]
  cover: Cover[]
  width: number
  height: number
  /**
   * Shots this enemy has already fired this turn.
   *
   * Passed in rather than tracked here because the decision function is pure and stateless: the caller owns
   * the turn, so the caller counts. Defaults to 0 so a single-decision test needs no bookkeeping.
   */
  shotsFired?: number
}

/** AP the enemy needs to shoot at `part`. */
const attackCost = (part: BodyPart) => getAttack(part).apCost

/**
 * Living enemies of this unit — i.e. the player's side.
 *
 * The old code looked up the unit whose id was literally `'hero'`, so every enemy shot the same unit and
 * a second friendly would have been ignored entirely. Selecting by team instead is what makes W7's
 * companions a content change rather than an AI rewrite.
 */
export const hostilesFor = (context: EnemyContext): Unit[] =>
  context.units.filter((unit) => unit.team !== context.enemy.team && isAlive(unit))

/**
 * The target an enemy shoots at: the one it can actually kill soonest.
 *
 * Ordered by "already in a firing line" first, then lowest HP, then least cover, then nearest, then id.
 * Every tiebreak is total, so the choice is deterministic on identical boards — which is what criterion 1
 * rests on. It reads only what the player can also see: position, HP, cover. It does **not** read the
 * damage its own shot is about to roll.
 */
export function chooseTarget(context: EnemyContext, blocked: ReadonlySet<string>): Unit | null {
  const { enemy, cover } = context
  const candidates = hostilesFor(context)
  if (!candidates.length) return null
  const visible = (unit: Unit) => hasLineOfSight(enemy, unit, blocked)
  return (
    [...candidates].sort(
      (left, right) =>
        Number(visible(right)) - Number(visible(left)) ||
        left.hp - right.hp ||
        coverPenalty(defensiveCover(enemy, left, cover)) - coverPenalty(defensiveCover(enemy, right, cover)) ||
        gridDistance(enemy, left) - gridDistance(enemy, right) ||
        left.id.localeCompare(right.id),
    )[0] ?? null
  )
}

/** Whether the enemy is hurt enough for its role to break contact. */
export const isWounded = (enemy: Unit, profile: BehaviorProfile) =>
  profile.retreatBelow > 0 && enemy.maxHp > 0 && enemy.hp / enemy.maxHp < profile.retreatBelow

/**
 * Scores a candidate cell for `profile`. Higher is better.
 *
 * Weighted rather than lexicographic, so a role's parameters trade off against each other instead of one
 * always dominating: a defender genuinely prefers cover over a marginally better angle, and a rusher
 * genuinely does not care. Distance is scored as *closeness to the ideal*, so overshooting is as bad as
 * falling short — which is what stops a shooter from walking into melee to gain one point of cover.
 */
export function scoreCell(
  point: Point,
  target: Unit,
  profile: BehaviorProfile,
  cover: Cover[],
  blocked: ReadonlySet<string>,
): number {
  const los = hasLineOfSight(point, target, blocked)
  const cellCover: CoverType = defensiveCover(target, point, cover)
  const distanceMiss = Math.abs(gridDistance(point, target) - profile.idealDistance)
  return (
    (los ? profile.lineOfSightWeight * 10 : 0) +
    (coverPenalty(cellCover) / 25) * profile.coverWeight * 5 -
    distanceMiss * 2
  )
}

/** Score for retreating to `point`: away from the target, and behind cover if possible. */
const retreatScore = (point: Point, target: Unit, profile: BehaviorProfile, cover: Cover[]): number =>
  gridDistance(point, target) * 3 + (coverPenalty(defensiveCover(target, point, cover)) / 25) * profile.coverWeight * 5

/** Reachable destinations, excluding the cell the enemy already stands on. */
const destinations = (enemy: Unit, reach: Reachability): { point: Point; cost: number }[] =>
  [...reach.costs.entries()]
    .filter(([key]) => key !== cellKey(enemy.x, enemy.y))
    .map(([key, cost]) => ({ point: reach.paths.get(key)!.at(-1)!, cost }))

/** Stable ordering helper: best score wins, ties broken by cell key so the pick is deterministic. */
const bestBy = <T extends { point: Point }>(items: T[], score: (item: T) => number): T | null =>
  items.length === 0
    ? null
    : [...items].sort(
        (left, right) =>
          score(right) - score(left) ||
          cellKey(left.point.x, left.point.y).localeCompare(cellKey(right.point.x, right.point.y)),
      )[0]

const intentFor = (rule: EnemyRule, enemy: Unit, target: Unit | null): string => {
  switch (rule) {
    case 'clear-jam':
      return 'Устраняет осечку.'
    case 'reload-empty':
      return 'Перезаряжается.'
    case 'retreat-wounded':
      return 'Ранен: отходит из-под огня.'
    case 'attack-in-range':
      return target ? `Стреляет по ${target.name}.` : 'Стреляет.'
    case 'seek-firing-line':
      return 'Ищет линию огня.'
    case 'close-distance':
      return target ? `Сокращает дистанцию до ${target.name}.` : 'Сокращает дистанцию.'
    case 'hold-cover':
      return 'Держит укрытие.'
    case 'no-action':
      return enemy.statuses?.shocked ? 'В шоке: ход пропущен.' : 'Ждёт.'
  }
}

const decision = (action: EnemyAction, rule: EnemyRule, enemy: Unit, target: Unit | null): EnemyDecision => ({
  action,
  rule,
  intent: intentFor(rule, enemy, target),
})

/**
 * The single decision function: one ordered pass over the priorities.
 *
 * The order is the design, and it is ordered by *what blocks what* rather than by preference:
 *
 *   1. **Clear a jam.** A jammed weapon blocks every shot, so nothing below matters until it is fixed.
 *      This is the fix for the enemy that used to stay silent for the whole encounter.
 *   2. **Reload an empty magazine.** Same reasoning: an empty gun cannot shoot. Also the fix for the
 *      three-shot rusher.
 *   3. **Retreat when wounded.** Placed above attacking on purpose: a unit that would rather withdraw
 *      should not trade one more shot first, or the threshold would be decorative.
 *   4. **Shoot, if there is a line and the AP.**
 *   5. **Take a firing position** — reposition toward the role's ideal spot. Unlike the old code this is
 *      *not* gated on having no line of sight, so an enemy that can see the target may still improve its
 *      position instead of standing still with unspent AP.
 *   6. **Hold.**
 *
 * Returns one action; the caller applies it and asks again, which is what lets an enemy reload *and*
 * shoot in the same turn — the old code took at most one shot and discarded the rest of its AP.
 */
export function decideEnemyAction(context: EnemyContext): EnemyDecision {
  const { enemy, units, cover, width, height } = context
  const profile = profileFor(enemy.behavior)

  if (!isAlive(enemy)) return decision({ kind: 'hold' }, 'no-action', enemy, null)

  const blocked = blockingCells([...units], cover, [enemy.id])
  const target = chooseTarget(context, blocked)
  if (!target) return decision({ kind: 'hold' }, 'no-action', enemy, null)

  const weapon = enemy.weaponState
  /* Line of sight is computed ignoring both endpoints, matching how the shot itself is resolved. */
  const targetBlocked = blockingCells([...units], cover, [enemy.id, target.id])
  const hasLine = hasLineOfSight(enemy, target, targetBlocked)

  // 1. A jam blocks everything else.
  if (weapon?.malfunctioned)
    return enemy.ap >= CLEAR_JAM_AP
      ? decision({ kind: 'clear-jam' }, 'clear-jam', enemy, target)
      : decision({ kind: 'hold' }, 'no-action', enemy, target)

  // 2. An empty magazine with reserve to draw on.
  if (weapon && weapon.magazine < 1 && weapon.reserveAmmo > 0)
    return enemy.ap >= weapon.reloadAp
      ? decision({ kind: 'reload' }, 'reload-empty', enemy, target)
      : decision({ kind: 'hold' }, 'no-action', enemy, target)

  const canReposition = canMove(enemy) && enemy.ap > 0
  const reach = canReposition
    ? findReachable(enemy, enemy.ap, width, height, blockingCells([...units], cover, [enemy.id]))
    : null
  const options = reach ? destinations(enemy, reach) : []

  // 3. Wounded: break contact rather than trade another shot.
  if (isWounded(enemy, profile) && options.length) {
    const away = options.filter((option) => gridDistance(option.point, target) > gridDistance(enemy, target))
    const pick = bestBy(away, (option) => retreatScore(option.point, target, profile, cover))
    if (pick) return decision({ kind: 'move', to: pick.point, cost: pick.cost }, 'retreat-wounded', enemy, target)
  }

  // 4. Shoot, unless this enemy has already taken its shot this turn.
  const part = ENEMY_ATTACK_PART
  const shotsLeft = ENEMY_SHOTS_PER_TURN - (context.shotsFired ?? 0)
  if (shotsLeft > 0 && hasLine && weapon && weapon.magazine > 0 && enemy.ap >= attackCost(part))
    return decision({ kind: 'attack', targetId: target.id, part }, 'attack-in-range', enemy, target)

  /*
   * 5. Improve position — but a holding role does not give up cover to do it.
   *
   * The condition is cover alone, deliberately **not** cover *and* a firing line. Requiring both is the bug
   * the first version of W6-02 shipped: the relay defender starts covered at (6,1) with no line to a hero
   * at (1,4), so "holds only when it can already shoot" sent it walking across the map, dropping its
   * armour advantage and the encounter's difficulty peak with it. Measured cost of that mistake: the relay
   * win rate went to 46.4%, below its 55% floor, while every other encounter stayed in range.
   *
   * This is also criterion 4 verbatim — «`defender` не покидает укрытие без причины» — and the pre-W6-02
   * code got it right for the same reason: it returned `null` from the destination chooser whenever the
   * defender stood in any cover, without consulting line of sight.
   */
  const covered = defensiveCover(target, enemy, cover) !== 'none'
  if (profile.holdsPosition && covered) return decision({ kind: 'hold' }, 'hold-cover', enemy, target)

  /*
   * Repositioning is a **recovery**, not a free upgrade: an enemy that already has a firing line stays
   * where it is.
   *
   * Without this gate an enemy that had just fired spent its leftover AP stepping into cover, which is
   * tactically correct and measurably too strong — it degrades the *player's* accuracy, not its own. On the
   * relay encounter the player's hit rate fell 47.9% → 27.0% and the win rate to 49.6%, below the approved
   * 55% floor, while nothing about the enemy's own output had changed.
   *
   * That is a difficulty increase, and W6-02's mandate is to fix the AI's *incompetence* (silent after a
   * jam, harmless after three shots), not to raise the encounter's difficulty. Enemies taking cover between
   * shots is a reasonable future design, but it needs re-approved corridors, which belongs to a balance
   * pass. Keeping the pre-W6-02 rule — move only when there is no line of sight — holds the tempo while the
   * reload/unjam/target-selection fixes still land.
   */
  if (!hasLine && options.length) {
    const current = scoreCell(enemy, target, profile, cover, targetBlocked)
    const pick = bestBy(options, (option) => scoreCell(option.point, target, profile, cover, targetBlocked))
    /* Only move for a genuine improvement: equal-score shuffling would burn AP and read as twitching. */
    if (pick && scoreCell(pick.point, target, profile, cover, targetBlocked) > current)
      return decision({ kind: 'move', to: pick.point, cost: pick.cost }, 'seek-firing-line', enemy, target)
  }

  return decision({ kind: 'hold' }, covered ? 'hold-cover' : 'no-action', enemy, target)
}

/** AP the shipped `clearMalfunction` charges. Mirrored here so the gate and the action agree. */
export const CLEAR_JAM_AP = 2
/** The body part enemies shoot at. Unchanged by W6-02; aimed enemy shots are not in scope. */
export const ENEMY_ATTACK_PART: BodyPart = 'torso'
export const ENEMY_ATTACK_AP = ATTACKS[ENEMY_ATTACK_PART].apCost
