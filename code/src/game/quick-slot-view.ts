/**
 * W5-03 — pure view model for the in-combat quick-slot bar.
 *
 * The combat DOM renders exactly these four descriptors and decides nothing: availability, the AP
 * price, the accessible name and the refusal sentence all come from `quickSlotBlocker`, which is the
 * same predicate `useQuickSlot` checks before it consumes anything. A slot shown as usable and then
 * refused would therefore be a contradiction inside one module rather than a disagreement between
 * the UI and the domain.
 *
 * Why every slot renders, including the empty ones: the bar is also the *state readout* for what the
 * operative is carrying. A bar that only listed filled slots would silently shrink mid-encounter as
 * items ran out, and "I have nothing left" would be indistinguishable from "the bar did not render".
 *
 * Why unavailable slots are `aria-disabled` rather than `disabled`: a `disabled` button leaves the
 * tab order and stops reporting its own label, so a keyboard or screen-reader user could not find
 * out *why* a slot is unusable — which is the one thing they need mid-turn. The same decision the
 * base panel's craft and upgrade buttons already make, for the same reason. The refusal is safe by
 * construction because `useQuickSlot` re-checks the blocker and consumes nothing on failure.
 */
import { AP_PER_TURN } from './combat'
import { effectForItem, type ItemEffect } from './consumables'
import { QUICK_SLOT_COUNT, itemQuantity } from './inventory'
import { quickSlotBlocker, type QuickSlotBlocker, type QuickSlotContext } from './quick-slot'

/** Player-facing sentence for a refusal. Every blocker has one; there is no generic fallback. */
export const describeQuickSlotBlocker = (blocker: QuickSlotBlocker, apCost: number, heroAp: number): string => {
  switch (blocker) {
    case 'index':
      return 'Недопустимый номер слота.'
    case 'empty-slot':
      return 'Слот пуст: назначьте предмет на базе.'
    case 'missing-item':
      return 'Предмет закончился в рюкзаке.'
    case 'no-effect':
      return 'У предмета нет эффекта: использовать нечего.'
    case 'not-player-turn':
      return 'Сейчас не ваш ход.'
    case 'no-hero':
      return 'Оперативник недоступен.'
    case 'insufficient-ap':
      return `Нужно ${apCost} ОЧ, доступно ${heroAp}.`
    case 'not-wounded':
      return 'HP уже полные: бинт был бы потрачен впустую.'
    case 'no-weapon':
      return 'Нет оружия, в которое можно загрузить патроны.'
    case 'wrong-ammo':
      return 'Калибр не подходит к текущему оружию.'
    case 'nothing-to-repair':
      return 'Экипировка не повреждена.'
  }
}

/** What one use would do, phrased from the effect object rather than from the catalog description. */
export const quickSlotEffectSummary = (effect: ItemEffect): string => {
  switch (effect.kind) {
    case 'heal':
      return `+${effect.amount} HP`
    case 'restore-ammo':
      return `запас ${effect.ammoId} +${effect.amount}`
    case 'repair':
      return `+${effect.amount} durability`
  }
}

export interface QuickSlotOption {
  index: number
  /** `1`..`QUICK_SLOT_COUNT`: the number shown and the keyboard shortcut. */
  slotNumber: number
  itemId: string | null
  /** Catalog name, or the empty-slot placeholder. */
  label: string
  /** Units still carried in the backpack. `0` for an empty slot. */
  quantity: number
  /** AP the use costs, `0` when the slot cannot name a price. */
  apCost: number
  /** What the use would do, empty when the slot holds nothing usable. */
  effectSummary: string
  blocked: QuickSlotBlocker | null
  available: boolean
  disabled: boolean
  /** Refusal sentence, empty when the slot is available. */
  reason: string
  /** Full accessible name: what it is, what it does, what it costs, and why not. */
  ariaLabel: string
}

export interface QuickSlotBarView {
  options: QuickSlotOption[]
  /** True when at least one slot can be used right now; drives the group's summary. */
  anyAvailable: boolean
  /** Visible summary, never a hover-only affordance. */
  summary: string
  /** Announcement for the live region, so a keyboard user hears why the bar is inert. */
  liveMessage: string
  /** Visible shortcut hint. Stated here so the DOM cannot invent a different key. */
  shortcutsHint: string
}

/**
 * The keyboard shortcut for slot `index`.
 *
 * Shift+digit, not a bare digit: 1–6 already select a body part (`input-gating.ts`), and stealing
 * those would break aiming to add consumables. Shift+1..4 is free, adjacent to the numbers already
 * shown on the slots, and reachable one-handed.
 */
export const quickSlotShortcutLabel = (index: number) => `Shift+${index + 1}`

export function buildQuickSlotBar(context: QuickSlotContext): QuickSlotBarView {
  const heroAp = context.hero?.ap ?? 0
  const options = Array.from({ length: QUICK_SLOT_COUNT }, (_unused, index): QuickSlotOption => {
    const itemId = context.inventory.quickSlots[index] ?? null
    const definition = itemId ? effectForItem(context.effects, itemId) : null
    const blocked = quickSlotBlocker(context, index)
    const apCost = definition?.apCost ?? 0
    const quantity = itemId ? itemQuantity(context.inventory, itemId, 'backpack') : 0
    const effectSummary = definition ? quickSlotEffectSummary(definition.effect) : ''
    const label = definition?.name ?? itemId ?? 'пусто'
    const reason = blocked ? describeQuickSlotBlocker(blocked, apCost, heroAp) : ''
    const priced = definition ? `${effectSummary} за ${apCost} ОЧ` : 'слот свободен'
    return {
      index,
      slotNumber: index + 1,
      itemId,
      label,
      quantity,
      apCost,
      effectSummary,
      blocked,
      available: blocked === null,
      disabled: blocked !== null,
      reason,
      ariaLabel: `Быстрый слот ${index + 1} (${quickSlotShortcutLabel(index)}): ${label}${
        itemId ? ` ×${quantity}` : ''
      }. ${priced}.${blocked === null ? ' Доступно.' : ` Недоступно: ${reason}`}`,
    }
  })
  const anyAvailable = options.some((option) => option.available)
  const filled = options.filter((option) => option.itemId !== null)
  const summary = filled.length === 0
    ? 'Быстрые слоты пусты: назначьте расходники на базе перед вылазкой.'
    : anyAvailable
      ? `Доступно к применению: ${options.filter((option) => option.available).length} из ${filled.length}. ОЧ: ${heroAp}/${AP_PER_TURN}.`
      : `Ни один расходник сейчас недоступен: ${options.find((option) => option.itemId !== null)!.reason}`
  return {
    options,
    anyAvailable,
    summary,
    liveMessage: summary,
    shortcutsHint: `Shift+1…Shift+${QUICK_SLOT_COUNT} — применить расходник из быстрого слота.`,
  }
}
