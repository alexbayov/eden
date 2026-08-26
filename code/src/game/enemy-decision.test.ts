/**
 * W6-02 — enemy decision tests.
 *
 * Organised around the acceptance criteria, and each is asserted as a *property* where it can be. Two
 * groups matter more than the rest:
 *
 *   - **the criteria that failed before this ticket** — an enemy with an empty magazine wasted its turn,
 *     and one with a jam was harmless for the remainder of the encounter. Both had working primitives
 *     that only the player ever called;
 *   - **the balance guards**. Three of the decisions below exist because the first version of W6-02 was
 *     tactically better and measurably too strong, and a test that only checked "the AI reloads" would
 *     have shipped all three regressions. Each guard names its measured cost.
 *
 * Determinism and honesty are checked structurally rather than described: `decideEnemyAction` receives no
 * `roll`, so the tests can assert byte-identical decisions on identical boards and know the function had
 * nothing random to consult.
 */
import { describe, expect, it } from 'vitest'
import {
  BEHAVIOR_PROFILES,
  CLEAR_JAM_AP,
  ENEMY_ATTACK_AP,
  ENEMY_ATTACK_PART,
  ENEMY_SHOTS_PER_TURN,
  chooseTarget,
  decideEnemyAction,
  hostilesFor,
  isWounded,
  profileFor,
  scoreCell,
  type EnemyContext,
} from './enemy-decision'
import { ATTACKS, blockingCells, defensiveCover, type Cover, type Unit, type WeaponState } from './combat'
import { runEnemyTurn } from './enemy-ai'

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
const hero = (overrides: Partial<Unit> = {}) =>
  unit({ id: 'hero', team: 'player', hp: 24, maxHp: 24, x: 4, y: 0, ...overrides })

const weapon = (overrides: Partial<WeaponState> = {}): WeaponState => ({
  weaponInstanceId: 'w-1',
  weaponId: 'pm',
  name: 'ПМ',
  ammoId: '9x18',
  baseDamage: 20,
  accuracyModifier: 0,
  critModifier: 0,
  penetration: 0,
  ammoDamageModifier: 0,
  ammoPenetrationModifier: 0,
  magazine: 8,
  magazineSize: 8,
  reserveAmmo: 16,
  durability: 100,
  maxDurability: 100,
  durabilityPerShot: 1,
  reloadAp: 3,
  makeshift: false,
  ...overrides,
})

const context = (enemy: Unit, units: Unit[], overrides: Partial<EnemyContext> = {}): EnemyContext => ({
  enemy,
  units: [enemy, ...units],
  cover: [],
  width: 8,
  height: 4,
  ...overrides,
})

describe('W6-02 the two criteria that failed before this ticket', () => {
  it('reloads an empty magazine instead of wasting the turn (criterion 2)', () => {
    /*
     * The measured consequence of the old behaviour: a `wild-rusher` carries the three-round `hornet`, so it
     * fired three times and then followed the hero around doing nothing for the rest of the encounter.
     * `reloadWeapon` existed the whole time and was called only by the player.
     */
    const enemy = unit({ id: 'e', x: 0, y: 0, behavior: 'shooter', weaponState: weapon({ magazine: 0, reserveAmmo: 8 }) })
    const decision = decideEnemyAction(context(enemy, [hero()]))
    expect(decision.rule).toBe('reload-empty')
    expect(decision.action.kind).toBe('reload')
    expect(decision.intent).toContain('Перезаряж')
  })

  it('clears a jam before anything else, because a jam blocks every shot (criterion 3)', () => {
    const enemy = unit({ id: 'e', x: 0, y: 0, behavior: 'shooter', weaponState: weapon({ malfunctioned: true }) })
    const decision = decideEnemyAction(context(enemy, [hero()]))
    expect(decision.rule).toBe('clear-jam')
    expect(decision.action.kind).toBe('clear-jam')
    /* Ahead of reloading and shooting on purpose: nothing below it can work until the weapon does. */
    const alsoEmpty = unit({
      id: 'e',
      x: 0,
      y: 0,
      behavior: 'shooter',
      weaponState: weapon({ malfunctioned: true, magazine: 0, reserveAmmo: 8 }),
    })
    expect(decideEnemyAction(context(alsoEmpty, [hero()])).rule).toBe('clear-jam')
  })

  it('does neither when it cannot afford to, and does not pretend otherwise', () => {
    /* A refusal has to be visible as `hold`, not as a silently dropped action. */
    const poorJam = unit({
      id: 'e',
      ap: CLEAR_JAM_AP - 1,
      behavior: 'shooter',
      weaponState: weapon({ malfunctioned: true }),
    })
    expect(decideEnemyAction(context(poorJam, [hero()])).action.kind).toBe('hold')

    const poorReload = unit({ id: 'e', ap: 1, behavior: 'shooter', weaponState: weapon({ magazine: 0, reserveAmmo: 8 }) })
    expect(decideEnemyAction(context(poorReload, [hero()])).action.kind).toBe('hold')

    /* No reserve left: there is nothing to reload, so reloading must not be proposed. */
    const dry = unit({ id: 'e', behavior: 'shooter', weaponState: weapon({ magazine: 0, reserveAmmo: 0 }) })
    expect(decideEnemyAction(context(dry, [hero()])).rule).not.toBe('reload-empty')
  })

  it('reloads and then shoots within one turn, which the old single-action loop could not', () => {
    /* Driven through the real turn resolver: the point is that the *loop* asks again after an action. */
    const enemy = unit({
      id: 'e',
      x: 2,
      y: 0,
      behavior: 'shooter',
      weaponState: weapon({ magazine: 0, reserveAmmo: 8, reloadAp: 3 }),
    })
    const result = runEnemyTurn([hero({ x: 4, y: 0 }), enemy], 8, 4, [], () => 100)
    expect(result.log.some((line) => line.includes('перезарядка'))).toBe(true)
    const after = result.units.find((u) => u.id === 'e')!
    /* Eight loaded minus the one fired. */
    expect(after.weaponState?.magazine).toBe(7)
  })
})

describe('W6-02 target selection', () => {
  it('picks by team, not by the id "hero"', () => {
    /* The old code looked up the unit literally named `'hero'`, so a second friendly would have been
       invisible to every enemy. Selecting by team is what makes W7 companions a content change. */
    const enemy = unit({ id: 'e' })
    const friends = [hero({ x: 2, y: 0 }), unit({ id: 'ally', team: 'player', x: 3, y: 0 })]
    expect(hostilesFor(context(enemy, friends)).map((u) => u.id)).toEqual(['hero', 'ally'])
    /* Dead friendlies are not targets. */
    expect(hostilesFor(context(enemy, [hero({ hp: 0 })]))).toEqual([])
  })

  it('prefers a visible target, then the weakest one', () => {
    const enemy = unit({ id: 'e', x: 0, y: 0 })
    /* Both in the open on separate rows, so neither blocks the line to the other. */
    const strong = hero({ x: 2, y: 0, hp: 24 })
    const weak = unit({ id: 'ally', team: 'player', x: 2, y: 2, hp: 5 })
    const units = [enemy, strong, weak]
    const picked = chooseTarget(context(enemy, [strong, weak]), blockingCells(units, [], [enemy.id]))
    expect(picked?.id).toBe('ally')
  })

  it('ignores a lower-HP target it cannot see, rather than firing blind', () => {
    /* Visibility outranks HP: shooting at something behind a wall would be the AI acting on information it
       does not have, which is the inverse of criterion 6. */
    const enemy = unit({ id: 'e', x: 0, y: 0 })
    const visible = hero({ x: 2, y: 0, hp: 24 })
    const hidden = unit({ id: 'ally', team: 'player', x: 4, y: 0, hp: 1 })
    const cover: Cover[] = [{ x: 3, y: 0, kind: 'full' }]
    const units = [enemy, visible, hidden]
    const picked = chooseTarget(
      context(enemy, [visible, hidden], { cover }),
      blockingCells(units, cover, [enemy.id]),
    )
    expect(picked?.id).toBe('hero')
  })

  it('holds when there is nobody left to fight', () => {
    const enemy = unit({ id: 'e', weaponState: weapon() })
    const decision = decideEnemyAction(context(enemy, [hero({ hp: 0 })]))
    expect(decision.action.kind).toBe('hold')
    expect(decision.rule).toBe('no-action')
  })
})

describe('W6-02 roles differ measurably (criterion 7)', () => {
  it('gives the three behaviours different parameters, not different names', () => {
    /*
     * Before this ticket `shooter` and `defender` shared one comparator verbatim; the only difference was
     * that a covered defender did not move, and `hp` was read nowhere at all. Compared as whole profiles so
     * a future role cannot be added as a duplicate with a new label.
     */
    const profiles = Object.entries(BEHAVIOR_PROFILES)
    for (const [name, profile] of profiles)
      for (const [otherName, other] of profiles)
        if (name !== otherName)
          expect(JSON.stringify(profile), `${name} vs ${otherName}`).not.toBe(JSON.stringify(other))

    /* And the distinctions are the ones the roles are named for. */
    expect(BEHAVIOR_PROFILES.rusher.idealDistance).toBeLessThan(BEHAVIOR_PROFILES.shooter.idealDistance)
    expect(BEHAVIOR_PROFILES.defender.coverWeight).toBeGreaterThan(BEHAVIOR_PROFILES.shooter.coverWeight)
    expect(BEHAVIOR_PROFILES.rusher.coverWeight).toBe(0)
    expect(BEHAVIOR_PROFILES.defender.holdsPosition).toBe(true)
    expect(BEHAVIOR_PROFILES.shooter.holdsPosition).toBe(false)
  })

  it('never retreats a rusher, because closing distance is the whole role', () => {
    const rusher = unit({ id: 'e', hp: 1, maxHp: 20, behavior: 'rusher', weaponState: weapon() })
    expect(isWounded(rusher, profileFor('rusher'))).toBe(false)
    /* A shooter at the same HP does withdraw. */
    expect(isWounded({ ...rusher, behavior: 'shooter' }, profileFor('shooter'))).toBe(true)
  })

  it('retreats a wounded shooter away from the target instead of trading another shot', () => {
    /* Ordered above attacking deliberately: a unit that would rather leave must not take one more shot
       first, or the threshold is decorative. */
    const enemy = unit({ id: 'e', x: 4, y: 0, hp: 2, maxHp: 20, behavior: 'shooter', weaponState: weapon() })
    const target = hero({ x: 5, y: 0 })
    const decision = decideEnemyAction(context(enemy, [target]))
    expect(decision.rule).toBe('retreat-wounded')
    if (decision.action.kind !== 'move') throw new Error('expected a retreat move')
    const before = Math.abs(enemy.x - target.x) + Math.abs(enemy.y - target.y)
    const after = Math.abs(decision.action.to.x - target.x) + Math.abs(decision.action.to.y - target.y)
    expect(after).toBeGreaterThan(before)
  })

  it('keeps a covered defender in its cover, whatever its firing line (criterion 4)', () => {
    /*
     * Regression guard with a measured cost. The first version held only when the defender *also* had a
     * firing line, so the shipped relay defender — covered at (6,1), no line to a hero at (1,4) — walked
     * across the map and gave up its armour advantage. Relay win rate fell to 46.4%, below its 55% floor.
     * The pre-W6-02 code got this right by not consulting line of sight at all.
     */
    const cover: Cover[] = [{ x: 5, y: 0, kind: 'full' }]
    const defender = unit({ id: 'e', x: 6, y: 0, behavior: 'defender', weaponState: weapon() })
    const target = hero({ x: 0, y: 3 })
    expect(defensiveCover(target, defender, cover)).not.toBe('none')
    const decision = decideEnemyAction(context(defender, [target], { cover }))
    expect(decision.action.kind).toBe('hold')
    expect(decision.rule).toBe('hold-cover')

    /* Out of cover it behaves like any other role and looks for a position. */
    const exposed = { ...defender, x: 2, y: 0 }
    expect(decideEnemyAction(context(exposed, [target], { cover })).rule).not.toBe('hold-cover')
  })
})

describe('W6-02 balance guards', () => {
  it('caps shots per turn, so the AI fix is not a damage increase', () => {
    /*
     * Measured cost of removing this cap: enemies restore 10 AP and a torso shot costs 4, so an
     * unconstrained loop fires twice. Damage to the hero rose 7.47 → 11.04 and the zone win rate fell
     * 80.1% → 59.8%, putting all three balance-lock corridors out of range. Raising the cap is a legitimate
     * design choice that needs re-approved corridors; it is not something an AI ticket should do quietly.
     */
    expect(ENEMY_SHOTS_PER_TURN).toBe(1)
    /* The cap is only meaningful because a second shot is otherwise affordable. */
    expect(ENEMY_ATTACK_AP * 2).toBeLessThanOrEqual(10)

    const enemy = unit({ id: 'e', x: 2, y: 0, behavior: 'shooter', weaponState: weapon() })
    const spent = decideEnemyAction(context(enemy, [hero({ x: 4, y: 0 })], { shotsFired: ENEMY_SHOTS_PER_TURN }))
    expect(spent.rule).not.toBe('attack-in-range')

    /* And the resolver honours it: one round leaves the magazine, not two. */
    const result = runEnemyTurn([hero({ x: 4, y: 0 }), enemy], 8, 4, [], () => 100)
    expect(result.units.find((u) => u.id === 'e')?.weaponState?.magazine).toBe(7)
  })

  it('repositions only as a no-line-of-sight recovery', () => {
    /*
     * The third guard, and the subtlest. Letting an enemy spend leftover AP stepping into cover is
     * tactically correct and degrades the *player's* accuracy, not its own: relay hit rate 47.9% → 27.0%
     * and win rate 49.6%, again under the floor, with no change to enemy output. Enemies taking cover
     * between shots is a fine future design; it is a difficulty change, not an AI-competence fix.
     */
    const cover: Cover[] = [{ x: 3, y: 1, kind: 'partial' }]
    const enemy = unit({ id: 'e', x: 3, y: 0, behavior: 'shooter', weaponState: weapon() })
    const target = hero({ x: 6, y: 0 })
    /* Has a line and has already fired: it must not go shopping for cover. */
    const decision = decideEnemyAction(context(enemy, [target], { cover, shotsFired: 1 }))
    expect(decision.action.kind).not.toBe('move')

    /* With the line blocked it does move. */
    const blockedCover: Cover[] = [{ x: 4, y: 0, kind: 'full' }]
    const blindEnemy = unit({ id: 'e', x: 2, y: 0, behavior: 'shooter', weaponState: weapon() })
    const seeking = decideEnemyAction(context(blindEnemy, [target], { cover: blockedCover }))
    expect(seeking.rule).toBe('seek-firing-line')
    expect(seeking.action.kind).toBe('move')
  })
})

describe('W6-02 determinism and honesty (criteria 1 and 6)', () => {
  it('returns byte-identical decisions for identical boards', () => {
    /* `decideEnemyAction` takes no `roll`, so this is a statement about a pure function rather than about
       a lucky seed. Repeated on a scored, cover-bearing board so ties actually have to be broken. */
    const cover: Cover[] = [
      { x: 2, y: 1, kind: 'partial' },
      { x: 3, y: 2, kind: 'full' },
    ]
    const enemy = unit({ id: 'e', x: 1, y: 1, behavior: 'shooter', weaponState: weapon() })
    const units = [hero({ x: 5, y: 3 }), unit({ id: 'ally', team: 'player', x: 5, y: 1, hp: 9 })]
    const first = decideEnemyAction(context(enemy, units, { cover }))
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(JSON.stringify(decideEnemyAction(context(enemy, units, { cover })))).toBe(JSON.stringify(first))
  })

  it('does not mutate the board it was given', () => {
    /* The decision is an observation. A mutated input would make the caller's ordering significant and the
       whole determinism claim unverifiable. */
    const cover: Cover[] = [{ x: 2, y: 1, kind: 'partial' }]
    const enemy = unit({ id: 'e', x: 1, y: 1, behavior: 'shooter', weaponState: weapon() })
    const units = [enemy, hero({ x: 5, y: 1 }), unit({ id: 'ally', team: 'player', x: 5, y: 3, hp: 9 })]
    const snapshot = JSON.stringify({ units, cover })
    decideEnemyAction({ enemy, units, cover, width: 8, height: 4 })
    expect(JSON.stringify({ units, cover })).toBe(snapshot)
  })

  it('shoots the torso, at the cost the attack catalog states', () => {
    /* The AP gate and the attack it gates are one number read from content, not two maintained by hand. */
    expect(ENEMY_ATTACK_PART).toBe('torso')
    expect(ENEMY_ATTACK_AP).toBe(ATTACKS[ENEMY_ATTACK_PART].apCost)
  })
})

describe('W6-02 intent describes the action taken (criterion 5)', () => {
  it('carries a distinct sentence for every rule', () => {
    /* Before this, `intent` was a static string copied off the archetype at hydration and never updated, so
       the label read "closes distance and attacks" whether the unit attacked, stood still or sat jammed. */
    const cover: Cover[] = [{ x: 5, y: 0, kind: 'full' }]
    const cases: [string, EnemyContext][] = [
      ['clear-jam', context(unit({ id: 'e', behavior: 'shooter', weaponState: weapon({ malfunctioned: true }) }), [hero()])],
      ['reload-empty', context(unit({ id: 'e', behavior: 'shooter', weaponState: weapon({ magazine: 0 }) }), [hero()])],
      ['attack-in-range', context(unit({ id: 'e', x: 2, y: 0, behavior: 'shooter', weaponState: weapon() }), [hero({ x: 4, y: 0 })])],
      [
        'retreat-wounded',
        context(unit({ id: 'e', x: 4, y: 0, hp: 2, behavior: 'shooter', weaponState: weapon() }), [hero({ x: 5, y: 0 })]),
      ],
      [
        'hold-cover',
        context(unit({ id: 'e', x: 6, y: 0, behavior: 'defender', weaponState: weapon() }), [hero({ x: 0, y: 3 })], { cover }),
      ],
    ]
    const seen = new Set<string>()
    for (const [expectedRule, built] of cases) {
      const decision = decideEnemyAction(built)
      expect(decision.rule, `expected rule ${expectedRule}`).toBe(expectedRule)
      expect(decision.intent.length, expectedRule).toBeGreaterThan(0)
      seen.add(decision.intent)
    }
    /* Distinct sentences: a shared string would make the readout useless precisely when it matters. */
    expect(seen.size).toBe(cases.length)
  })

  it('writes the executed decision onto the unit, so the target list cannot lie', () => {
    const jammed = unit({ id: 'e', x: 2, y: 0, behavior: 'shooter', weaponState: weapon({ malfunctioned: true }) })
    const result = runEnemyTurn([hero({ x: 4, y: 0 }), jammed], 8, 4, [], () => 100)
    const after = result.units.find((u) => u.id === 'e')!
    /* It cleared the jam and then fired, so the surviving intent describes the last thing it did. */
    expect(after.intent).toBeDefined()
    expect(after.intent).not.toContain('Сокращает дистанцию')
    expect(result.log.some((line) => line.includes('осечка устранена'))).toBe(true)
  })

  it('replaces the static archetype string once the unit has acted', () => {
    const stale = unit({
      id: 'e',
      x: 2,
      y: 0,
      behavior: 'rusher',
      intent: 'Сокращает дистанцию и атакует вблизи.',
      weaponState: weapon(),
    })
    const result = runEnemyTurn([hero({ x: 4, y: 0 }), stale], 8, 4, [], () => 100)
    const after = result.units.find((u) => u.id === 'e')!
    expect(after.intent).not.toBe(stale.intent)
    expect(after.intent).toContain('Стреляет')
  })
})

describe('W6-02 cell scoring', () => {
  it('scores closeness to the role ideal, so overshooting is as bad as falling short', () => {
    /* Without this a shooter would walk into melee to gain a point of cover, which is neither its role nor
       something the old distance-descending comparator did. */
    const target = hero({ x: 5, y: 0 })
    const profile = profileFor('shooter')
    const blocked = new Set<string>()
    const atIdeal = scoreCell({ x: 5 - profile.idealDistance, y: 0 }, target, profile, [], blocked)
    const tooClose = scoreCell({ x: 4, y: 0 }, target, profile, [], blocked)
    const tooFar = scoreCell({ x: 0, y: 0 }, target, profile, [], blocked)
    expect(atIdeal).toBeGreaterThan(tooClose)
    expect(atIdeal).toBeGreaterThan(tooFar)
  })

  it('values cover for a defender and ignores it for a rusher', () => {
    /*
     * Isolated by scoring the *same cell* twice, once with a cover object beside it and once without. Two
     * different cells cannot isolate this: `defensiveCover` depends on the direction to the target, so
     * moving the cell changes distance and line of sight at the same time, and the comparison would measure
     * three things at once. (An earlier version of this test did exactly that and read the geometry wrong.)
     */
    const target = hero({ x: 5, y: 0 })
    const cell = { x: 2, y: 0 }
    const blocked = new Set<string>()
    /* The cell adjacent to `cell` on the way to the target is what shields it. */
    const shielded: Cover[] = [{ x: 3, y: 0, kind: 'full' }]
    expect(defensiveCover(target, cell, shielded)).not.toBe('none')
    expect(defensiveCover(target, cell, [])).toBe('none')

    const gainFor = (behavior: 'defender' | 'rusher' | 'shooter') =>
      scoreCell(cell, target, profileFor(behavior), shielded, blocked) -
      scoreCell(cell, target, profileFor(behavior), [], blocked)

    /* A rusher is indifferent to cover by construction — `coverWeight: 0`. */
    expect(gainFor('rusher')).toBe(0)
    /* A defender values it more than a shooter, which is the difference their roles are named for. */
    expect(gainFor('defender')).toBeGreaterThan(gainFor('shooter'))
    expect(gainFor('shooter')).toBeGreaterThan(0)
  })
})
