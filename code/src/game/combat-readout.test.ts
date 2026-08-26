/**
 * W6-03 — readout tests.
 *
 * The criterion that shapes this file is 2: «итог breakdown в UI совпадает с `final` из модели
 * (**проверяется тестом, а не глазом**)». That is why the readout is data rather than JSX — a test can sum
 * labelled terms and compare against the model, and it cannot sum a rendered tree.
 *
 * Asserted as properties wherever possible. In particular the sum-equals-total check runs across a matrix
 * of postures, statuses, body parts, ranges and cover levels rather than on one happy path, because the
 * interesting cases are the ones where the 5..95 clamp makes the arithmetic *legitimately* disagree — and a
 * single-case test would have picked one side of that and proved nothing.
 *
 * Nothing here restates a formula. Every expectation is either read from `combat.ts` (`ATTACKS`, `POSTURES`,
 * `postureChangeCost`) or derived from the model's own output, so a balance change updates both sides of an
 * assertion at once instead of silently invalidating the spec.
 */
import { describe, expect, it } from 'vitest'
import {
  CRIT_CHANCE_MAX,
  CRIT_CHANCE_MIN,
  CRIT_DAMAGE_MULTIPLIER,
  HIT_CHANCE_MAX,
  HIT_CHANCE_MIN,
  breakdownRows,
  buildBreakdownView,
  buildCritView,
  critBreakdownRows,
  postureOptions,
  rowsTotal,
  statusViews,
} from './combat-readout'
import {
  ATTACKS,
  POSTURES,
  calculateCritBreakdown,
  calculateHitBreakdown,
  postureChangeCost,
  type BodyPart,
  type CoverType,
  type Posture,
  type Statuses,
  type Unit,
} from './combat'

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

const PARTS = Object.keys(ATTACKS) as BodyPart[]
const COVERS: CoverType[] = ['none', 'partial', 'full']

describe('W6-03 hit breakdown: every term, and a total that matches the model', () => {
  it('lists all eight addends with a label and a sign (criterion 1)', () => {
    /* The screen previously rendered 2 of 11 fields, so a player saw a 38% chance with no way to learn that
       50 of the missing points were the target's cover. Compared against the model's own field set rather
       than a hardcoded list, so a new addend in `HitBreakdown` fails this test instead of being dropped. */
    const breakdown = calculateHitBreakdown(hero(), { x: 5, y: 0 }, 'head', 'partial')
    const rows = breakdownRows(breakdown)
    /* `final`, `damage` and `apCost` are outputs, not addends. */
    const addends = Object.keys(breakdown).filter((key) => !['final', 'damage', 'apCost'].includes(key))
    expect(rows.map((row) => row.id).sort()).toEqual(addends.sort())
    for (const row of rows) {
      expect(row.label.length, row.id).toBeGreaterThan(0)
      expect(row.display, row.id).toMatch(/^(\+|−)?\d+$/)
    }
    /* Zero rows are kept: a list that changed shape between shots could never be learned. */
    const withZeroes = breakdownRows(calculateHitBreakdown(hero(), { x: 1, y: 0 }, 'torso', 'none'))
    expect(withZeroes.some((row) => row.value === 0)).toBe(true)
    expect(withZeroes).toHaveLength(rows.length)
  })

  it('signs penalties negative, so the displayed terms can be summed at all', () => {
    /* `HitBreakdown` stores `rangePenalty` and `coverPenalty` as positive magnitudes that the formula
       subtracts. Displaying them unchanged would make the column add up to the wrong number. */
    const breakdown = calculateHitBreakdown(hero(), { x: 9, y: 0 }, 'torso', 'full')
    const rows = breakdownRows(breakdown)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(breakdown.rangePenalty).toBeGreaterThan(0)
    expect(byId.get('rangePenalty')!.value).toBe(-breakdown.rangePenalty)
    expect(byId.get('coverPenalty')!.value).toBe(-breakdown.coverPenalty)
    expect(byId.get('rangePenalty')!.display.startsWith('−')).toBe(true)
    /* The base is a starting value, not a modifier, so it carries no sign. */
    expect(byId.get('base')!.display).toBe(String(breakdown.base))
  })

  it('sums to the model total whenever the clamp is not active (criterion 2)', () => {
    /*
     * The whole point of the ticket, checked as a property over a matrix rather than on one shot. The clamp
     * cases are the reason: at 5% or 95% the rows genuinely do not add up, and a test that ignored that
     * would either fail on legitimate output or pass while hiding a real mismatch.
     */
    const heroes: [string, Unit][] = [
      ['plain', hero()],
      ['prone', hero({ posture: 'prone' })],
      ['crouched', hero({ posture: 'crouch' })],
      ['wounded arm', hero({ statuses: { arm: 2 } })],
      ['blinded', hero({ statuses: { blind: 3 } })],
      ['skilled', hero({ skill: 80 })],
    ]
    let clampedSeen = 0
    let exactSeen = 0
    for (const [label, attacker] of heroes)
      for (const part of PARTS)
        for (const cover of COVERS)
          for (const distance of [1, 4, 9]) {
            const breakdown = calculateHitBreakdown(attacker, { x: distance, y: 0 }, part, cover)
            const view = buildBreakdownView(breakdown, part)
            const context = `${label}/${part}/${cover}/${distance}`
            if (view.clamp === null) {
              expect(Math.round(rowsTotal(view.rows)), context).toBe(view.final)
              exactSeen += 1
            } else {
              /* Clamped: the total is the bound, and the raw sum is on the far side of it. */
              expect(view.final, context).toBe(view.clamp === 'min' ? HIT_CHANCE_MIN : HIT_CHANCE_MAX)
              if (view.clamp === 'min') expect(view.rawTotal, context).toBeLessThan(HIT_CHANCE_MIN)
              else expect(view.rawTotal, context).toBeGreaterThan(HIT_CHANCE_MAX)
              clampedSeen += 1
            }
          }
    /* Both branches must actually be exercised, or this test proves half of what it claims. */
    expect(exactSeen).toBeGreaterThan(0)
    expect(clampedSeen).toBeGreaterThan(0)
  })

  it('rounds at most one term, which is what makes the displayed column add up exactly', () => {
    /*
     * The precondition `breakdownRows` relies on, asserted rather than assumed.
     *
     * Rows carry the *displayed* (rounded) value so the visible digits sum to the visible total. That is only
     * exact while at most one addend is fractional — `round(a + n) === round(a) + n` holds for integer `n`.
     * `skillModifier` is that one term in both breakdowns (`skill × 0.4` and `× 0.15`); every other addend
     * comes from an integer catalog field. A future second fractional term would introduce a silent
     * off-by-one in the column and must fail here instead.
     */
    const fractional = (values: number[]) => values.filter((value) => !Number.isInteger(value)).length
    for (const attacker of [hero(), hero({ skill: 37 }), hero({ skill: 3, agility: 7, luck: 9 })])
      for (const part of PARTS)
        for (const cover of COVERS) {
          const hit = calculateHitBreakdown(attacker, { x: 5, y: 0 }, part, cover)
          const hitAddends = Object.entries(hit)
            .filter(([key]) => !['final', 'damage', 'apCost'].includes(key))
            .map(([, value]) => value as number)
          expect(fractional(hitAddends), `hit ${part}/${cover}`).toBeLessThanOrEqual(1)

          const crit = calculateCritBreakdown(attacker, part)
          const critAddends = Object.entries(crit)
            .filter(([key]) => key !== 'final')
            .map(([, value]) => value as number)
          expect(fractional(critAddends), `crit ${part}`).toBeLessThanOrEqual(1)
        }
  })

  it('sums the displayed crit terms to the displayed crit total', () => {
    /* The DOM test adds up what it reads from the table, so the rounded rows must reconcile with the model's
       rounded total. Checked here across skill values that make `skill × 0.15` fractional. */
    for (const skill of [0, 3, 17, 42, 85, 100])
      for (const part of PARTS) {
        const view = buildCritView(hero({ skill }), part)
        if (view.clamp === null)
          expect(Math.round(rowsTotal(view.rows)), `skill ${skill}/${part}`).toBe(view.final)
      }
  })

  it('reports the model final rather than its own arithmetic', () => {
    /* Deliberate: if the two ever diverge the test above fails, instead of the UI quietly showing a number
       the dice do not roll against. */
    const breakdown = calculateHitBreakdown(hero(), { x: 20, y: 0 }, 'eye', 'full')
    const view = buildBreakdownView(breakdown, 'eye')
    expect(view.final).toBe(breakdown.final)
    expect(view.final).not.toBe(Math.round(rowsTotal(view.rows)))
    expect(view.clamp).toBe('min')
  })

  it('carries the part label, damage, AP cost and critical effect from the catalog', () => {
    for (const part of PARTS) {
      const view = buildBreakdownView(calculateHitBreakdown(hero(), { x: 2, y: 0 }, part, 'none'), part)
      expect(view.partLabel, part).toBe(ATTACKS[part].label)
      expect(view.apCost, part).toBe(ATTACKS[part].apCost)
      expect(view.damage, part).toBe(ATTACKS[part].damage)
      expect(view.effect, part).toBe(ATTACKS[part].effect)
    }
  })
})

describe('W6-03 crit breakdown, which had no UI at all', () => {
  it('surfaces every term and the model total', () => {
    /* `calculateCritBreakdown` and `calculateCritChance` had no call sites outside `combat.ts`: the crit
       chance affected damage and was invisible to the player. */
    const attacker = hero()
    for (const part of PARTS) {
      const model = calculateCritBreakdown(attacker, part)
      const view = buildCritView(attacker, part)
      expect(view.final, part).toBe(model.final)
      const rows = critBreakdownRows(model)
      expect(view.rows.map((row) => row.id)).toEqual(rows.map((row) => row.id))
      const addends = Object.keys(model).filter((key) => key !== 'final')
      expect(view.rows.map((row) => row.id).sort()).toEqual(addends.sort())
      if (view.clamp === null) expect(Math.round(rowsTotal(view.rows)), part).toBe(view.final)
    }
  })

  it('states the damage multiplier a critical applies', () => {
    /* Read from the constant that mirrors `calculateDamage`, so the display and the formula move together. */
    expect(buildCritView(hero(), 'torso').multiplier).toBe(CRIT_DAMAGE_MULTIPLIER)
    expect(CRIT_DAMAGE_MULTIPLIER).toBe(1.5)
  })

  it('marks the clamp on an extreme crit chance', () => {
    const high = buildCritView(hero({ skill: 100, agility: 10, luck: 10 }), 'eye')
    expect(high.final).toBeLessThanOrEqual(CRIT_CHANCE_MAX)
    if (high.rawTotal > CRIT_CHANCE_MAX) {
      expect(high.clamp).toBe('max')
      expect(high.final).toBe(CRIT_CHANCE_MAX)
    }
    expect(CRIT_CHANCE_MIN).toBe(1)
  })
})

describe('W6-03 statuses with their remaining duration (criterion 3)', () => {
  it('describes every status and its turns left', () => {
    /* `statusLabels` existed, was called from nowhere, and discarded the counter — so even if it had been
       wired up the duration could not have been shown. */
    const views = statusViews({ arm: 2, blind: 3, shocked: 1 })
    expect(views.map((view) => view.id)).toEqual(['shocked', 'blind', 'arm'])
    for (const view of views) {
      expect(view.label.length, view.id).toBeGreaterThan(0)
      expect(view.effect.length, view.id).toBeGreaterThan(0)
      expect(view.text).toContain(view.label)
      expect(view.text).toContain(String(view.turnsLeft))
      expect(view.text).toContain('осталось ходов')
    }
  })

  it('covers every status the model can set', () => {
    /* Driven from the `Statuses` keys `applyBodyPartHit` actually writes, so a new status cannot ship
       without a description. */
    const all: Statuses = { head: 1, arm: 2, leg: 2, immobilized: 1, blind: 3, shocked: 1 }
    const views = statusViews(all)
    expect(views).toHaveLength(Object.keys(all).length)
    expect(new Set(views.map((view) => view.label)).size).toBe(views.length)
  })

  it('lists nothing when there are no statuses, and ignores non-positive counters', () => {
    expect(statusViews()).toEqual([])
    expect(statusViews({})).toEqual([])
    /* A hand-edited save could carry a zero; showing it as "1 turn left" would be a lie. */
    expect(statusViews({ arm: 0 })).toEqual([])
    expect(statusViews({ arm: -1 })).toEqual([])
  })

  it('keeps a stable order, so the list does not reshuffle as statuses expire', () => {
    const full = statusViews({ head: 1, arm: 2, leg: 2, immobilized: 1, blind: 3, shocked: 1 }).map((v) => v.id)
    const partial = statusViews({ arm: 2, shocked: 1 }).map((v) => v.id)
    /* The surviving subset appears in the same relative order as in the full list. */
    expect(partial).toEqual(full.filter((id) => partial.includes(id)))
  })
})

describe('W6-03 posture price before the press (criterion 4)', () => {
  const PARTS_OF_POSTURE = Object.keys(POSTURES) as Posture[]

  it('states the AP cost and the aim bonus for every posture', () => {
    const options = postureOptions(hero({ posture: 'crouch' }), 'player')
    expect(options.map((option) => option.id)).toEqual(PARTS_OF_POSTURE)
    for (const option of options) {
      expect(option.aimModifier).toBe(POSTURES[option.id].aimModifier)
      expect(option.cost).toBe(postureChangeCost('crouch', option.id))
      /* The summary is what the button shows before it is pressed. */
      expect(option.summary.length).toBeGreaterThan(0)
      expect(option.ariaLabel).toContain(POSTURES[option.id].label)
    }
  })

  it('explains the forbidden transition differently from a shortage of AP', () => {
    /*
     * The defect this closes: both refusals produced «Смена позы сейчас недоступна.», so a permanent rule
     * (standing→prone requires crouching first) was indistinguishable from being two AP short.
     */
    const standing = postureOptions(hero({ posture: 'stand', ap: 10 }), 'player')
    const prone = standing.find((option) => option.id === 'prone')!
    expect(postureChangeCost('stand', 'prone')).toBeNull()
    expect(prone.cost).toBeNull()
    expect(prone.available).toBe(false)
    expect(prone.reason).toContain('присед')

    const broke = postureOptions(hero({ posture: 'prone', ap: 1 }), 'player')
    const stand = broke.find((option) => option.id === 'stand')!
    expect(stand.cost).toBe(postureChangeCost('prone', 'stand'))
    expect(stand.available).toBe(false)
    expect(stand.reason).toContain('Не хватает ОЧ')
    /* Two different sentences, which is the whole point. */
    expect(stand.reason).not.toBe(prone.reason)
  })

  it('marks the current posture and never offers it as a change', () => {
    const options = postureOptions(hero({ posture: 'crouch' }), 'player')
    const current = options.find((option) => option.current)!
    expect(current.id).toBe('crouch')
    expect(current.available).toBe(false)
    expect(current.reason).toContain('Текущая')
    /* A unit with no explicit posture is standing, per `postureAimModifier`'s default. */
    expect(postureOptions(hero(), 'player').find((option) => option.current)?.id).toBe('stand')
  })

  it('offers nothing outside the player phase or without a hero', () => {
    for (const option of postureOptions(hero({ posture: 'crouch' }), 'enemy')) {
      expect(option.available).toBe(false)
      expect(option.reason).toContain('Не ваш ход')
    }
    for (const option of postureOptions(undefined, 'player')) {
      expect(option.available).toBe(false)
      expect(option.cost).toBeNull()
    }
  })

  it('allows the legal, affordable transitions', () => {
    const options = postureOptions(hero({ posture: 'stand', ap: 10 }), 'player')
    const crouch = options.find((option) => option.id === 'crouch')!
    expect(crouch.available).toBe(true)
    expect(crouch.reason).toBe('')
    expect(crouch.cost).toBe(1)
    /* And from crouch, lying down is legal. */
    const fromCrouch = postureOptions(hero({ posture: 'crouch', ap: 10 }), 'player')
    expect(fromCrouch.find((option) => option.id === 'prone')?.available).toBe(true)
  })
})
