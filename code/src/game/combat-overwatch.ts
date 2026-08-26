/**
 * W6-04 — the Overwatch readout, and the numbers that were only ever literals.
 *
 * The mechanic itself worked and was covered by tests before this ticket. What did not exist was any way for
 * a player to see it: `grep reservedAp src/app.tsx` found **one** hit, the write at activation, and the −15
 * reaction penalty appeared nowhere outside `combat.ts`. The only feedback was a yellow ring on the canvas
 * and the word `OVERWATCH`, with no numbers at all.
 *
 * Three things this module fixes, none of which changes the mechanic:
 *
 *   1. **The AP requirement is derived, not typed twice.** `app.tsx` hardcoded `hero.ap < 6` to gate
 *      activation and `unit.ap - 2` to compute the reserve, while `OVERWATCH_ACTIVATION_AP = 2` sat in
 *      `combat.ts` with no consumers. Those are the same rule written in three places, and the `6` is really
 *      `2 + torso.apCost` — a coincidence that would break silently if a torso shot were repriced.
 *   2. **The button's `disabled` matches its actual requirement.** It was gated on `phase` alone, so at 5 AP
 *      it looked available and refused on click.
 *   3. **The reaction is priced before committing.** The reserve, the −15 modifier and the resulting hit
 *      chance are all knowable in advance, and Overwatch is a decision made a whole enemy turn ahead — which
 *      is exactly when a player needs the numbers rather than after the fact.
 *
 * **No rule changes.** Every value is read from `combat.ts`. The one thing deliberately made explicit is the
 * total AP requirement, and `combat-overwatch.test.ts` asserts it equals activation plus the reaction's own
 * cost rather than the literal it used to be.
 */
import {
  ATTACKS,
  OVERWATCH_ACTIVATION_AP,
  OVERWATCH_HIT_MODIFIER,
  calculateHitBreakdown,
  isAlive,
  type BodyPart,
  type CoverType,
  type Unit,
} from './combat'

/**
 * Re-exported so every Overwatch number has one import site.
 *
 * `OVERWATCH_ACTIVATION_AP` had **no consumers** before this ticket: `app.tsx` wrote the literal `2` in the
 * reserve calculation and `6` in the activation gate, while the constant sat unused in `combat.ts`. Pulling it
 * through here means the screen reads the same value the rules module declares.
 */
export { OVERWATCH_ACTIVATION_AP, OVERWATCH_HIT_MODIFIER } from './combat'

/**
 * The body part an Overwatch reaction always fires at.
 *
 * Fixed by `enemy-ai.ts`, which resolves the reaction as a torso shot. Named here so the AP arithmetic below
 * reads off the same attack the reaction actually uses.
 */
export const OVERWATCH_REACTION_PART: BodyPart = 'torso'

/** AP the reaction itself spends when it fires. */
export const OVERWATCH_REACTION_AP = ATTACKS[OVERWATCH_REACTION_PART].apCost

/**
 * Total AP needed to activate Overwatch usefully: the activation cost plus one reaction.
 *
 * Derived rather than written as `6`. Reserving less than a torso shot costs would produce an Overwatch that
 * can never fire — `enemy-ai.ts` refuses the reaction when `reservedAp < torso.apCost` — so the gate and the
 * reaction's own price are the same number by construction.
 */
export const OVERWATCH_TOTAL_AP = OVERWATCH_ACTIVATION_AP + OVERWATCH_REACTION_AP

/** AP that would be reserved if Overwatch were activated right now. */
export const reservedApFor = (ap: number) => Math.max(0, ap - OVERWATCH_ACTIVATION_AP)

/** Whether a reserve of this size can actually pay for a reaction. */
export const reserveCanReact = (reservedAp: number) => reservedAp >= OVERWATCH_REACTION_AP

export type OverwatchBlocker =
  /** No operative on the board. */
  | 'no-hero'
  /** Not the player's turn. */
  | 'not-player-turn'
  /** Already watching: the reaction is one per enemy phase. */
  | 'already-active'
  /** Not enough AP to reserve a shot after paying the activation. */
  | 'insufficient-ap'

export interface OverwatchView {
  /** True while Overwatch is armed and waiting for the enemy phase. */
  active: boolean
  /** AP reserved right now when active, or what would be reserved if activated. */
  reservedAp: number
  /** Whether that reserve can pay for a reaction. */
  canReact: boolean
  /** The accuracy penalty a reaction takes, as a signed number. Always negative. */
  hitModifier: number
  /** Hit chance of the reaction, if a target is known. `null` when nothing is selected. */
  reactionChance: number | null
  /** Activation cost, reaction cost and their total, so no screen restates them. */
  activationAp: number
  reactionAp: number
  totalAp: number
  blocked: OverwatchBlocker | null
  available: boolean
  /** Why it cannot be activated, in the player's terms. Empty when available. */
  reason: string
  /** What the control says under its label. */
  summary: string
  ariaLabel: string
}

export interface OverwatchInput {
  hero: Unit | undefined
  phase: string
  /**
   * The currently selected enemy, used only to price the reaction.
   *
   * Optional because Overwatch is activated without choosing a target — the reaction picks whoever walks into
   * the firing line. When a target *is* selected the chance is shown as a representative example, which is
   * the honest framing: the actual reaction may face someone else.
   */
  target?: Unit | undefined
  /** Cover the selected target benefits from, for the same pricing. */
  targetCover?: CoverType
}

const reasonFor = (blocked: OverwatchBlocker | null, hero: Unit | undefined): string => {
  switch (blocked) {
    case null:
      return ''
    case 'no-hero':
      return 'Нет оперативника.'
    case 'not-player-turn':
      return 'Не ваш ход.'
    case 'already-active':
      return 'Overwatch уже активен: реакция одна за ход противника.'
    case 'insufficient-ap':
      return `Нужно ${OVERWATCH_TOTAL_AP} ОЧ: ${OVERWATCH_ACTIVATION_AP} на активацию и ${OVERWATCH_REACTION_AP} в резерв на выстрел. Есть ${hero?.ap ?? 0}.`
  }
}

/**
 * The whole Overwatch control as data (criterion 1).
 *
 * Reports both halves the player needs before committing an entire turn: how much AP will be held back, and
 * how much worse the reaction shoots. The chance is computed through `calculateHitBreakdown` with the same
 * `OVERWATCH_HIT_MODIFIER` the reaction passes, so the number shown is the number rolled against rather than
 * a second implementation of the same formula.
 */
export function buildOverwatchView(input: OverwatchInput): OverwatchView {
  const { hero, phase, target, targetCover = 'none' } = input
  const active = Boolean(hero?.overwatch)
  const currentReserve = hero?.overwatch?.reservedAp ?? 0
  const reservedAp = active ? currentReserve : reservedApFor(hero?.ap ?? 0)

  const blocked: OverwatchBlocker | null = !hero || !isAlive(hero)
    ? 'no-hero'
    : phase !== 'player'
      ? 'not-player-turn'
      : active
        ? 'already-active'
        : (hero.ap ?? 0) < OVERWATCH_TOTAL_AP
          ? 'insufficient-ap'
          : null

  /*
   * Priced with the reaction's own AP, not the hero's current AP: the reaction fires during the enemy phase
   * from the reserve, so pricing it against a hero who is about to end the turn at 0 AP would describe a shot
   * that never happens.
   */
  const reactionChance =
    hero && target
      ? calculateHitBreakdown(
          { ...hero, ap: Math.max(reservedAp, OVERWATCH_REACTION_AP) },
          target,
          OVERWATCH_REACTION_PART,
          targetCover,
          OVERWATCH_HIT_MODIFIER,
        ).final
      : null

  const reason = reasonFor(blocked, hero)
  /*
   * The chance is appended in **both** states, not only while active.
   *
   * The first version showed it only after activation, which is precisely backwards: Overwatch is committed a
   * whole turn in advance, so the moment a player needs to know how well the reaction shoots is *before*
   * pressing the button, not after the turn is already spent.
   */
  const chanceSuffix = reactionChance === null ? '' : ` · шанс реакции ${reactionChance}%`
  const summary = active
    ? `Резерв ${reservedAp} ОЧ · точность ${OVERWATCH_HIT_MODIFIER}${chanceSuffix}`
    : `${OVERWATCH_ACTIVATION_AP} ОЧ + резерв ${OVERWATCH_REACTION_AP} ОЧ · точность реакции ${OVERWATCH_HIT_MODIFIER}${chanceSuffix}`

  return {
    active,
    reservedAp,
    canReact: reserveCanReact(reservedAp),
    hitModifier: OVERWATCH_HIT_MODIFIER,
    reactionChance,
    activationAp: OVERWATCH_ACTIVATION_AP,
    reactionAp: OVERWATCH_REACTION_AP,
    totalAp: OVERWATCH_TOTAL_AP,
    blocked,
    available: blocked === null,
    reason,
    summary,
    ariaLabel: active
      ? `Overwatch активен. Зарезервировано ${reservedAp} ОЧ, точность реакции ${OVERWATCH_HIT_MODIFIER}.${
          reactionChance === null ? '' : ` Шанс реакции ${reactionChance}%.`
        }`
      : `Активировать Overwatch: ${OVERWATCH_ACTIVATION_AP} ОЧ и ${OVERWATCH_REACTION_AP} ОЧ в резерв, точность реакции ${OVERWATCH_HIT_MODIFIER}.${
          blocked === null ? '' : ` Недоступно: ${reason}`
        }`,
  }
}

/**
 * Whether a persisted `overwatch` block is structurally sound, for the save validator.
 *
 * Needed because `overwatch` was **not validated at all**: `grep overwatch src/game/save.ts` returned nothing,
 * and every one of these was accepted — `reservedAp: 9999`, `-5`, `1.5`, `'lots'`, `{}`, a block on an enemy
 * unit, and a block on the home screen with no mission running. The first is a free extra-powerful reaction,
 * the string would flow into `combatAttack`'s AP comparison, and the last would fire a reaction on a screen
 * where Overwatch cannot be activated.
 *
 * The upper bound is `AP_MAX` rather than `AP_PER_TURN`: `startTurn` can grant up to 15 AP, so a legitimate
 * reserve can exceed the nominal 10.
 */
export const isOverwatchState = (value: unknown, maxAp: number): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  /* Exactly one field: an extra key means the payload was not written by this game. */
  if (Object.keys(state).length !== 1) return false
  const reserved = state.reservedAp
  return typeof reserved === 'number' && Number.isInteger(reserved) && reserved >= 0 && reserved <= maxAp
}
