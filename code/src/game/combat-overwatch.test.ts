/**
 * W6-04 — Overwatch readout and save-validation tests.
 *
 * The mechanic worked before this ticket and was covered by `m3-equipment.test.ts` and
 * `session.integration.test.ts`. Two things were not covered because they did not exist: any display of the
 * reservation, and any validation of the persisted block.
 *
 * The validation half is the more serious. `grep overwatch src/game/save.ts` returned nothing, so a
 * hand-edited save could carry `reservedAp: 9999` — a reaction far stronger than the game can grant — or
 * `reservedAp: 'lots'`, which would flow into `combatAttack`'s AP comparison as a string. Both loaded cleanly.
 * The tests below assert each of those payloads is now refused, one case per defect, so a regression names
 * which one came back.
 *
 * No rule is restated here: AP costs come from `ATTACKS`, the modifier from `OVERWATCH_HIT_MODIFIER`, and the
 * reaction chance is compared against `calculateHitBreakdown` called with the same arguments the reaction uses.
 */
import { describe, expect, it } from 'vitest'
import {
  OVERWATCH_ACTIVATION_AP,
  OVERWATCH_HIT_MODIFIER,
  OVERWATCH_REACTION_AP,
  OVERWATCH_REACTION_PART,
  OVERWATCH_TOTAL_AP,
  buildOverwatchView,
  isOverwatchState,
  reserveCanReact,
  reservedApFor,
} from './combat-overwatch'
import { AP_MAX, ATTACKS, calculateHitBreakdown, type Unit } from './combat'

const hero = (overrides: Partial<Unit> = {}): Unit => ({
  id: 'hero',
  name: 'Оперативник',
  hp: 24,
  maxHp: 24,
  team: 'player',
  aim: 72,
  color: '#ffffff',
  ap: 10,
  x: 0,
  y: 0,
  ...overrides,
})
const enemy = (overrides: Partial<Unit> = {}): Unit =>
  hero({ id: 'raider', name: 'Raider', team: 'enemy', hp: 16, maxHp: 16, x: 4, y: 0, ...overrides })

describe('W6-04 the AP requirement is derived, not typed three times', () => {
  it('totals activation plus the reaction the reserve has to pay for', () => {
    /*
     * `app.tsx` gated activation on the literal `6` while `OVERWATCH_ACTIVATION_AP = 2` sat in `combat.ts`
     * with no consumers at all. The `6` was really `2 + torso.apCost`, a coincidence that would have broken
     * silently if a torso shot were repriced — and the failure mode is nasty: a reserve smaller than the
     * reaction's cost produces an Overwatch that can never fire, because `enemy-ai.ts` refuses it.
     */
    expect(OVERWATCH_REACTION_PART).toBe('torso')
    expect(OVERWATCH_REACTION_AP).toBe(ATTACKS.torso.apCost)
    expect(OVERWATCH_TOTAL_AP).toBe(OVERWATCH_ACTIVATION_AP + OVERWATCH_REACTION_AP)
    /* The invariant that matters: the gate always leaves enough to actually react. */
    expect(reserveCanReact(reservedApFor(OVERWATCH_TOTAL_AP))).toBe(true)
    expect(reserveCanReact(reservedApFor(OVERWATCH_TOTAL_AP - 1))).toBe(false)
  })

  it('reserves everything left after the activation cost', () => {
    expect(reservedApFor(10)).toBe(10 - OVERWATCH_ACTIVATION_AP)
    /* Never negative: a hero with less AP than the activation reserves nothing rather than a debt. */
    expect(reservedApFor(1)).toBe(0)
    expect(reservedApFor(0)).toBe(0)
  })
})

describe('W6-04 the readout states the reservation and the penalty (criterion 1)', () => {
  it('prices activation before it is committed', () => {
    /* Overwatch spends a whole turn on a bet about the enemy phase, so both numbers have to be knowable in
       advance. Neither was displayed anywhere before this ticket. */
    const view = buildOverwatchView({ hero: hero({ ap: 10 }), phase: 'player' })
    expect(view.active).toBe(false)
    expect(view.available).toBe(true)
    expect(view.reservedAp).toBe(reservedApFor(10))
    expect(view.canReact).toBe(true)
    expect(view.hitModifier).toBe(OVERWATCH_HIT_MODIFIER)
    expect(view.totalAp).toBe(OVERWATCH_TOTAL_AP)
    /* The summary carries the reservation and the penalty, which is what the control shows. */
    expect(view.summary).toContain(String(OVERWATCH_ACTIVATION_AP))
    expect(view.summary).toContain(String(OVERWATCH_HIT_MODIFIER))
  })

  it('reports the live reserve once active, not a recomputed one', () => {
    /* After activation the hero is at 0 AP, so recomputing from `ap` would show a reserve of 0 while the unit
       genuinely holds one. Read off the persisted block instead. */
    const watching = hero({ ap: 0, overwatch: { reservedAp: 8 } })
    const view = buildOverwatchView({ hero: watching, phase: 'player' })
    expect(view.active).toBe(true)
    expect(view.reservedAp).toBe(8)
    expect(view.canReact).toBe(true)
    expect(view.blocked).toBe('already-active')
    expect(view.reason).toContain('одна за ход')
  })

  it('flags a reserve too small to ever fire', () => {
    /* Reachable through `startTurn` penalties: a hero on 5 AP reserves 3, and `enemy-ai.ts` will refuse the
       reaction. Saying so is the difference between a wasted turn and an informed one. */
    const view = buildOverwatchView({ hero: hero({ ap: 0, overwatch: { reservedAp: OVERWATCH_REACTION_AP - 1 } }), phase: 'player' })
    expect(view.active).toBe(true)
    expect(view.canReact).toBe(false)
  })

  it('prices the reaction with the same call the reaction itself makes', () => {
    /*
     * Criterion 1's second half. Compared against `calculateHitBreakdown` invoked exactly as `enemy-ai.ts`
     * invokes it — torso, the target's cover, `OVERWATCH_HIT_MODIFIER` — so the number shown is the number
     * rolled against rather than a second implementation of the formula.
     */
    const attacker = hero({ ap: 10 })
    const target = enemy()
    const view = buildOverwatchView({ hero: attacker, phase: 'player', target, targetCover: 'partial' })
    const expected = calculateHitBreakdown(
      { ...attacker, ap: view.reservedAp },
      target,
      OVERWATCH_REACTION_PART,
      'partial',
      OVERWATCH_HIT_MODIFIER,
    ).final
    expect(view.reactionChance).toBe(expected)
    /* And it is genuinely worse than an ordinary shot, by the modifier. */
    const ordinary = calculateHitBreakdown({ ...attacker, ap: view.reservedAp }, target, 'torso', 'partial').final
    expect(view.reactionChance!).toBeLessThan(ordinary)
  })

  it('omits the chance when no target is selected, rather than inventing one', () => {
    /* Overwatch is armed without choosing a target — the reaction fires at whoever walks into the line — so a
       chance with nothing selected would be a number about nobody. */
    const view = buildOverwatchView({ hero: hero(), phase: 'player' })
    expect(view.reactionChance).toBeNull()
    expect(view.summary).not.toContain('шанс')
  })

  it('shows the chance before activation, not only after it', () => {
    /*
     * Found by the browser spec. The first version appended the chance only while `active`, which is backwards:
     * Overwatch is committed a whole turn in advance, so the figure matters *before* the press. Afterwards the
     * decision has already been made.
     */
    const target = enemy()
    const armed = buildOverwatchView({ hero: hero({ ap: 10 }), phase: 'player', target })
    expect(armed.active).toBe(false)
    expect(armed.reactionChance).not.toBeNull()
    expect(armed.summary).toContain(`шанс реакции ${armed.reactionChance}%`)
    /* And still present once active, so the readout does not disappear when the turn is spent. */
    const watching = buildOverwatchView({ hero: hero({ ap: 0, overwatch: { reservedAp: 8 } }), phase: 'player', target })
    expect(watching.summary).toContain('шанс реакции')
  })

  it('refuses with a specific reason for each blocker', () => {
    const cases: [string, ReturnType<typeof buildOverwatchView>][] = [
      ['no-hero', buildOverwatchView({ hero: undefined, phase: 'player' })],
      ['not-player-turn', buildOverwatchView({ hero: hero(), phase: 'enemy' })],
      ['already-active', buildOverwatchView({ hero: hero({ overwatch: { reservedAp: 6 } }), phase: 'player' })],
      ['insufficient-ap', buildOverwatchView({ hero: hero({ ap: OVERWATCH_TOTAL_AP - 1 }), phase: 'player' })],
    ]
    const reasons = new Set<string>()
    for (const [blocker, view] of cases) {
      expect(view.blocked, blocker).toBe(blocker)
      expect(view.available, blocker).toBe(false)
      expect(view.reason.length, blocker).toBeGreaterThan(0)
      reasons.add(view.reason)
    }
    /* Distinct sentences: a shared refusal is how the posture control used to mislead. */
    expect(reasons.size).toBe(cases.length)
    /* The AP refusal states the requirement and what the hero actually has. */
    const poor = buildOverwatchView({ hero: hero({ ap: 3 }), phase: 'player' })
    expect(poor.reason).toContain(String(OVERWATCH_TOTAL_AP))
    expect(poor.reason).toContain('3')
  })

  it('treats a downed hero as having no operative at all', () => {
    expect(buildOverwatchView({ hero: hero({ hp: 0 }), phase: 'player' }).blocked).toBe('no-hero')
  })

  it('is exactly available at the threshold and unavailable one AP below', () => {
    /* The boundary the old literal `6` encoded, now asserted against the derived total. */
    expect(buildOverwatchView({ hero: hero({ ap: OVERWATCH_TOTAL_AP }), phase: 'player' }).available).toBe(true)
    expect(buildOverwatchView({ hero: hero({ ap: OVERWATCH_TOTAL_AP - 1 }), phase: 'player' }).available).toBe(false)
  })
})

describe('W6-04 the persisted block is validated (the hole this ticket closes)', () => {
  /*
   * Every payload below loaded cleanly before this ticket, because `overwatch` was not validated at all.
   * Listed one per case so a regression names which defect returned.
   */
  it('accepts only a whole reserve within the AP ceiling', () => {
    expect(isOverwatchState({ reservedAp: 0 }, AP_MAX)).toBe(true)
    expect(isOverwatchState({ reservedAp: OVERWATCH_REACTION_AP }, AP_MAX)).toBe(true)
    /* `startTurn` can grant up to `AP_MAX`, so a reserve above the nominal 10 is legitimate. */
    expect(isOverwatchState({ reservedAp: AP_MAX }, AP_MAX)).toBe(true)
    expect(AP_MAX).toBeGreaterThan(10)
  })

  it('rejects a reserve larger than the game can ever grant', () => {
    /* The exploit: a free reaction stronger than any turn could produce. */
    expect(isOverwatchState({ reservedAp: 9999 }, AP_MAX)).toBe(false)
    expect(isOverwatchState({ reservedAp: AP_MAX + 1 }, AP_MAX)).toBe(false)
  })

  it('rejects values that are not whole non-negative numbers', () => {
    expect(isOverwatchState({ reservedAp: -5 }, AP_MAX)).toBe(false)
    expect(isOverwatchState({ reservedAp: 1.5 }, AP_MAX)).toBe(false)
    /* A string would flow into `combatAttack`'s AP comparison and compare as garbage. */
    expect(isOverwatchState({ reservedAp: 'lots' }, AP_MAX)).toBe(false)
    expect(isOverwatchState({ reservedAp: Number.NaN }, AP_MAX)).toBe(false)
    expect(isOverwatchState({ reservedAp: Number.POSITIVE_INFINITY }, AP_MAX)).toBe(false)
  })

  it('rejects a malformed shape rather than reading past it', () => {
    expect(isOverwatchState({}, AP_MAX)).toBe(false)
    expect(isOverwatchState(null, AP_MAX)).toBe(false)
    expect(isOverwatchState(4, AP_MAX)).toBe(false)
    expect(isOverwatchState([4], AP_MAX)).toBe(false)
    /* An extra field means the payload was not written by this game. */
    expect(isOverwatchState({ reservedAp: 4, bonus: 9 }, AP_MAX)).toBe(false)
  })
})
