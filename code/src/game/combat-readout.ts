/**
 * W6-03 — pure view models for the three things the combat screen computed but never showed.
 *
 * Everything here already existed in `combat.ts` and was thrown away at the UI boundary:
 *
 *   - `HitBreakdown` carries **eleven** fields; the screen rendered `final` and `damage`, so a player
 *     could see a 38% chance and had no way to learn that 50 of the missing points were the target's
 *     cover and 25 were the head-shot penalty;
 *   - `CritBreakdown` was never surfaced **at all** — `calculateCritBreakdown` and `calculateCritChance`
 *     had no call sites outside `combat.ts`, so the crit chance was invisible while affecting damage;
 *   - `statusLabels` existed and was called from nowhere. Statuses appeared only on the Phaser canvas as
 *     raw English keys (`arm, blind`) at 9px, and their turn counters — which `advanceStatuses` decrements
 *     every turn — were never shown;
 *   - `postureChangeCost` knows that standing→prone is illegal and that prone→standing costs 3 AP. The UI
 *     showed neither, so both the price and the impossibility were discovered by clicking.
 *
 * **Why a separate module rather than JSX.** Criterion 2 asks that the total shown in the UI equals the
 * model's `final` *checked by a test, not by eye*. That is only possible if the rows are data: a test can
 * sum labelled addends and compare, but it cannot sum a JSX tree. So the arithmetic relationship is
 * asserted once, here, and the shell only renders.
 *
 * **No formula changes.** W6-03 is display only — explicitly out of scope in the ticket. Every number
 * below is read from `calculateHitBreakdown` / `calculateCritBreakdown` / `postureChangeCost`; nothing is
 * recomputed, and `breakdownRows` deliberately reports the *model's* `final` rather than the sum of its
 * own rows, so a divergence surfaces as a failing test instead of a UI that quietly disagrees with the
 * dice.
 */
import {
  ATTACKS,
  POSTURES,
  calculateCritBreakdown,
  postureChangeCost,
  type BodyPart,
  type CritBreakdown,
  type HitBreakdown,
  type Posture,
  type Statuses,
  type Unit,
} from './combat'

/** One labelled term of a breakdown, as the player reads it. */
export interface BreakdownRow {
  /** Stable key for the DOM and for tests; matches the `HitBreakdown` field name. */
  id: string
  label: string
  /**
   * The signed contribution **as displayed**, i.e. rounded to a whole number.
   *
   * Rounded rather than raw so that the column a player can add up is the column that was shown to them.
   * `skillModifier` is the one fractional term in both breakdowns (`skill × 0.4` for hit, `× 0.15` for crit),
   * and exposing 6.375 here would produce a table whose visible digits sum to one number while the attribute
   * behind them sums to another — the exact discrepancy criterion 2 exists to rule out.
   *
   * This is exact rather than approximately right because **at most one term is ever fractional**: every
   * other addend comes from an integer catalog field, and `round(a + n) === round(a) + n` for integer `n`.
   * `combat-readout.test.ts` asserts that precondition over a matrix, so a future second fractional term
   * fails the test instead of quietly introducing a rounding drift.
   */
  value: number
  /** `+12` / `−50` / `55`, with a real minus sign rather than a hyphen. */
  display: string
  /** True for the unmodified starting chance, which is a base rather than a modifier. */
  base?: boolean
}

/** Formats a signed contribution. The base term carries no sign: it is not a modifier. */
const signed = (value: number, base = false): string => {
  const rounded = Math.round(value)
  if (base) return `${rounded}`
  if (rounded === 0) return '0'
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`
}

/**
 * Where each `HitBreakdown` field comes from, in the order the formula applies it.
 *
 * Ordered to match `doc 04`'s formula rather than the interface declaration, so a player reading top to
 * bottom follows the same sequence the model computes. Penalties are stored positive in `HitBreakdown`
 * and negated here, which is why the rows can be summed at all.
 */
const HIT_TERMS: { id: keyof HitBreakdown; label: string; negate?: boolean; base?: boolean }[] = [
  { id: 'base', label: 'База', base: true },
  { id: 'skillModifier', label: 'Навык' },
  { id: 'weaponModifier', label: 'Оружие' },
  { id: 'rangePenalty', label: 'Дистанция', negate: true },
  { id: 'coverPenalty', label: 'Укрытие цели', negate: true },
  { id: 'postureModifier', label: 'Поза' },
  { id: 'statusModifier', label: 'Статусы' },
  { id: 'partModifier', label: 'Часть тела' },
]

const CRIT_TERMS: { id: keyof CritBreakdown; label: string; base?: boolean }[] = [
  { id: 'base', label: 'База', base: true },
  { id: 'skillModifier', label: 'Навык' },
  { id: 'agilityModifier', label: 'Ловкость' },
  { id: 'luckModifier', label: 'Удача' },
  { id: 'weaponModifier', label: 'Оружие' },
  { id: 'statusModifier', label: 'Статусы' },
  { id: 'partModifier', label: 'Часть тела' },
]

/**
 * Every term of a hit breakdown as labelled rows (criterion 1).
 *
 * All eight addends are returned including zeroes: "cover contributes nothing here" is information, and
 * hiding it would make the list change shape between shots, so a player could not learn what the terms
 * are. `final` is **not** derived from these rows — see the module note.
 */
export const breakdownRows = (breakdown: HitBreakdown): BreakdownRow[] =>
  HIT_TERMS.map(({ id, label, negate, base }) => {
    const raw = breakdown[id] as number
    const value = Math.round(negate ? -raw : raw)
    return { id: String(id), label, value, display: signed(value, base), ...(base ? { base: true } : {}) }
  })

export const critBreakdownRows = (breakdown: CritBreakdown): BreakdownRow[] =>
  CRIT_TERMS.map(({ id, label, base }) => {
    const value = Math.round(breakdown[id] as number)
    return { id: String(id), label, value, display: signed(value, base), ...(base ? { base: true } : {}) }
  })

/** Sum of a row list, for the test that ties the displayed terms to the model's total. */
export const rowsTotal = (rows: readonly BreakdownRow[]) => rows.reduce((sum, row) => sum + row.value, 0)

export interface BreakdownView {
  rows: BreakdownRow[]
  /** The model's own `final`, clamped to 5..95. Never the sum of `rows`. */
  final: number
  /**
   * Raw sum of the terms before clamping.
   *
   * Exposed because the clamp is otherwise invisible and reads as an arithmetic error: at 5% or 95% the
   * rows genuinely do not add up to the total, and the player deserves to be told it is a floor or a
   * ceiling rather than left to think the numbers are wrong.
   */
  rawTotal: number
  /** Set when the clamp is active, naming which bound applied. */
  clamp: 'min' | 'max' | null
  damage: number
  apCost: number
  /** `getAttack(part).effect` — what a critical hit inflicts beyond damage. */
  effect: string
  partLabel: string
}

export const HIT_CHANCE_MIN = 5
export const HIT_CHANCE_MAX = 95

/** The full hit readout: labelled terms, the model total, and whether a clamp is hiding the difference. */
export function buildBreakdownView(breakdown: HitBreakdown, part: BodyPart): BreakdownView {
  const rows = breakdownRows(breakdown)
  const rawTotal = Math.round(rowsTotal(rows))
  return {
    rows,
    final: breakdown.final,
    rawTotal,
    clamp: rawTotal < HIT_CHANCE_MIN ? 'min' : rawTotal > HIT_CHANCE_MAX ? 'max' : null,
    damage: breakdown.damage,
    apCost: breakdown.apCost,
    effect: ATTACKS[part].effect,
    partLabel: ATTACKS[part].label,
  }
}

export interface CritView {
  rows: BreakdownRow[]
  final: number
  rawTotal: number
  clamp: 'min' | 'max' | null
  /** Damage multiplier a critical applies, from the shipped formula. */
  multiplier: number
}

export const CRIT_CHANCE_MIN = 1
export const CRIT_CHANCE_MAX = 90
/** `calculateDamage` multiplies by 1.5 on a critical. Mirrored for display only. */
export const CRIT_DAMAGE_MULTIPLIER = 1.5

/**
 * The crit readout, which had no UI at all before W6-03.
 *
 * Built from `calculateCritBreakdown` so the displayed chance is the one `resolveCombatAttack` rolls
 * against, rather than a second implementation of the same formula.
 */
export function buildCritView(attacker: Unit, part: BodyPart, statusCrit = 0): CritView {
  const breakdown = calculateCritBreakdown(attacker, part, statusCrit)
  const rows = critBreakdownRows(breakdown)
  const rawTotal = Math.round(rowsTotal(rows))
  return {
    rows,
    final: breakdown.final,
    rawTotal,
    clamp: rawTotal < CRIT_CHANCE_MIN ? 'min' : rawTotal > CRIT_CHANCE_MAX ? 'max' : null,
    multiplier: CRIT_DAMAGE_MULTIPLIER,
  }
}

/** One active status with its remaining duration. */
export interface StatusView {
  id: keyof Statuses
  label: string
  /** What it does, in the player's terms. */
  effect: string
  /** Turns left, as `advanceStatuses` counts them down. Always `>= 1` for a listed status. */
  turnsLeft: number
  /** `Ранение руки: −30% точности · осталось ходов: 2` */
  text: string
}

/**
 * Status descriptions, keyed by the field they read.
 *
 * Replaces `statusLabels`, which returned pre-joined strings and **discarded the turn counter** — so even
 * if it had been called, the remaining duration could not have been shown. Splitting name from effect also
 * lets the UI show a compact list without losing the explanation.
 */
const STATUS_TEXT: Record<keyof Statuses, { label: string; effect: string }> = {
  head: { label: 'Ранение головы', effect: '−2 ОЧ' },
  arm: { label: 'Ранение руки', effect: '−30% точности' },
  leg: { label: 'Ранение ноги', effect: '−3 ОЧ' },
  immobilized: { label: 'Обездвижен', effect: 'перемещение недоступно' },
  blind: { label: 'Слепота', effect: '−50% точности' },
  shocked: { label: 'Шок', effect: 'ход пропущен' },
}

/** Stable display order, so the list does not reshuffle as statuses expire. */
const STATUS_ORDER: (keyof Statuses)[] = ['shocked', 'immobilized', 'blind', 'head', 'arm', 'leg']

/**
 * Active statuses with their remaining turns (criterion 3).
 *
 * A status is active while its counter is `>= 1`; `advanceStatuses` drops entries at 1 rather than storing
 * a zero, so anything present and positive is live. Non-positive values are filtered rather than trusted,
 * because a hand-edited save could carry one and a `0` displayed as "1 turn left" would be a lie.
 */
export const statusViews = (statuses: Statuses = {}): StatusView[] =>
  STATUS_ORDER.flatMap((id) => {
    const turnsLeft = statuses[id]
    if (typeof turnsLeft !== 'number' || turnsLeft < 1) return []
    const { label, effect } = STATUS_TEXT[id]
    return [{ id, label, effect, turnsLeft, text: `${label}: ${effect} · осталось ходов: ${turnsLeft}` }]
  })

export interface PostureOption {
  id: Posture
  label: string
  /** AP the change costs, or `null` when the transition is illegal. */
  cost: number | null
  /** Aim bonus this posture grants, from `POSTURES`. */
  aimModifier: number
  current: boolean
  available: boolean
  /** Why it cannot be chosen, in the player's terms. Empty when available. */
  reason: string
  /** `Присед · 1 ОЧ · точность +5` — everything needed before committing. */
  summary: string
  ariaLabel: string
}

/**
 * Posture options with their price stated **before** the click (criterion 4).
 *
 * The two refusals are deliberately different sentences. Previously both produced
 * «Смена позы сейчас недоступна.», so a player could not tell "this move is forbidden" from "you are two
 * AP short" — and standing→prone is *permanently* forbidden, which is a rule worth knowing rather than a
 * temporary shortage. `postureChangeCost` returning `null` is the rule; `hero.ap < cost` is the shortage.
 */
export function postureOptions(hero: Unit | undefined, phase: string): PostureOption[] {
  return (Object.keys(POSTURES) as Posture[]).map((id) => {
    const definition = POSTURES[id]
    const current = hero?.posture === id || (!hero?.posture && id === 'stand')
    const cost = hero ? postureChangeCost(hero.posture, id) : null
    const affordable = cost !== null && hero !== undefined && hero.ap >= cost
    const playable = phase === 'player'
    const available = Boolean(hero) && playable && !current && cost !== null && affordable
    const reason = !hero
      ? 'Нет оперативника.'
      : !playable
        ? 'Не ваш ход.'
        : current
          ? 'Текущая поза.'
          : cost === null
            ? 'Из положения стоя нельзя лечь напрямую: сначала присед.'
            : !affordable
              ? `Не хватает ОЧ: нужно ${cost}, есть ${hero.ap}.`
              : ''
    const price = cost === null ? 'недоступно' : `${cost} ОЧ`
    const aim = definition.aimModifier === 0 ? 'без бонуса' : `точность +${definition.aimModifier}`
    return {
      id,
      label: definition.label,
      cost,
      aimModifier: definition.aimModifier,
      current,
      available,
      reason,
      summary: `${price} · ${aim}`,
      ariaLabel: `Поза ${definition.label}, ${price}, ${aim}.${
        current ? ' Текущая поза.' : available ? '' : ` Недоступно: ${reason}`
      }`,
    }
  })
}
