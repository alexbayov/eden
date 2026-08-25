/**
 * Гейтинг глобального клавиатурного ввода боя (M3-D P0).
 *
 * Единственное место, где решается, принимает ли приложение боевую горячую клавишу.
 * Клавиши E / O / 1–6 обязаны быть no-op вне активного боя: на экранах `home`,
 * `mission-select`, `reward`, `return` и в любой фазе кроме `player` резолвер возвращает
 * `null`, поэтому нажатие не может ни запустить enemy-фазу, ни нанести урон герою.
 */
import { ATTACKS, type BodyPart } from './combat'
import type { CampaignScreen } from './campaign'
import { QUICK_SLOT_COUNT } from './inventory'
import type { BattlePhase } from './save'

export type CombatShortcut =
  | { action: 'end-turn' }
  | { action: 'overwatch' }
  | { action: 'select-body-part'; part: BodyPart; index: number }
  /** W5-03: применить расходник из быстрого слота (Shift+1…Shift+4). */
  | { action: 'use-quick-slot'; index: number }

/** Порядок частей тела для клавиш 1–6; берётся из боевого каталога, а не дублируется. */
export const SHORTCUT_BODY_PARTS = Object.keys(ATTACKS) as BodyPart[]

/** Пары screen/phase, в которых бой вообще существует. */
export const acceptsCombatInput = (screen: CampaignScreen, phase: BattlePhase): boolean =>
  screen === 'mission' && phase === 'player'

/** Ввод текста никогда не перехватывается боевыми клавишами (duck-typed для node-тестов). */
export const isTextEntryTarget = (target: unknown): boolean => {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null
  const tag = typeof element?.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true
}

export interface ShortcutEventLike {
  key: string
  target?: unknown
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /**
   * W5-03: Shift разделяет «выбрать часть тела» и «применить расходник».
   *
   * Обязательно `shiftKey`, а не свободная цифра: клавиши 1–6 уже заняты частями тела, и отдать их
   * расходникам значило бы сломать прицеливание ради быстрых слотов. `event.key` при Shift+1 в
   * разных раскладках приходит как `!`, `1` или национальный символ, поэтому распознавание идёт по
   * `code` (`Digit1`), а `key` остаётся резервным вариантом для событий без `code` — таких, какие
   * создают node-тесты.
   */
  shiftKey?: boolean
  /** Физическая клавиша (`Digit1`…`Digit4`); независима от раскладки и от Shift. */
  code?: string
}

/**
 * Индекс быстрого слота для нажатия с Shift, или `null`.
 *
 * `code` предпочтительнее `key`, потому что при зажатом Shift браузер отдаёт в `key` символ верхнего
 * регистра (`!` для Shift+1 на US-раскладке), и сопоставление по `key` работало бы только на одной
 * раскладке.
 */
const quickSlotIndexOf = (event: ShortcutEventLike): number | null => {
  const fromCode = /^Digit([1-9])$/.exec(event.code ?? '')
  const digit = fromCode ? Number(fromCode[1]) : Number(event.key)
  const index = digit - 1
  return Number.isInteger(index) && index >= 0 && index < QUICK_SLOT_COUNT ? index : null
}

/**
 * Возвращает боевое действие для нажатия или `null`, если ввод недопустим.
 * Проверка гейта идёт первой: вне миссии/фазы игрока не распознаётся ни одна клавиша.
 */
export function resolveCombatShortcut(
  event: ShortcutEventLike,
  screen: CampaignScreen,
  phase: BattlePhase,
): CombatShortcut | null {
  if (!acceptsCombatInput(screen, phase)) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (isTextEntryTarget(event.target)) return null
  /* Проверяется до цифр без Shift: Shift+1 не должен одновременно менять часть тела. */
  if (event.shiftKey) {
    const slot = quickSlotIndexOf(event)
    return slot === null ? null : { action: 'use-quick-slot', index: slot }
  }
  const key = event.key.toLowerCase()
  if (key === 'e') return { action: 'end-turn' }
  if (key === 'o') return { action: 'overwatch' }
  const index = Number(key) - 1
  if (Number.isInteger(index) && index >= 0 && index < SHORTCUT_BODY_PARTS.length)
    return { action: 'select-body-part', part: SHORTCUT_BODY_PARTS[index], index }
  return null
}
