/**
 * W5-03 — the **pure** half of "use a consumable from a quick slot".
 *
 * What this module owns and what it deliberately does not:
 *
 *   - it owns the *inventory* transition: one unit leaves the backpack, the quick slot is pruned
 *     when that was the last unit, and nothing else in the inventory moves;
 *   - it owns the *lookup* of what the item does, from content (`ItemEffectDefinition`), and hands
 *     the effect and its AP price back to the caller;
 *   - it does **not** apply the effect and does **not** spend AP. HP, weapon state and AP live on
 *     the unit (`game/combat.ts`), and the combat/app slice that owns the turn is the only place
 *     that may charge AP. A domain function that guessed either would create a second source of
 *     truth for the hero's state, which is exactly what `syncEquipmentInstances` exists to avoid.
 *
 * The consequence is that `useQuickSlotConsumable` is total and side-effect free: every refusal is
 * an explicit reason with the **unchanged** inventory attached, and the successful case reports the
 * effect the caller must still apply. Nothing is consumed on any refusal path.
 *
 * Effects are content (`public/config/item-effects.json`, kind `item-effects`), validated by
 * `validateItemEffects`/`validateCampaignCatalog` before anything reads them, so an effect pointing
 * at a missing item or at a non-consumable is a load-time error rather than a slot that silently
 * does nothing.
 */
import { QUICK_SLOT_COUNT, itemQuantity, removeItem, type Inventory } from './inventory'

/**
 * What one use of a consumable does. A closed union rather than a bag of optional numbers: the
 * combat slice must be able to `switch` exhaustively, and a new kind has to be added here (and to
 * the validator) instead of appearing as an unread field on a shipped item.
 *
 *   - `heal` restores hero HP (never equipment durability);
 *   - `restore-ammo` refills *reserve* ammo of one ammo id (the magazine is filled by `reloadWeapon`);
 *   - `repair` restores equipment durability (never HP).
 *
 * The HP/durability split mirrors the base rules: `treatHero` may not repair gear and `repairGear`
 * may not heal.
 */
export type ItemEffect =
  | { kind: 'heal'; amount: number }
  | { kind: 'restore-ammo'; ammoId: string; amount: number }
  | { kind: 'repair'; amount: number }

export const ITEM_EFFECT_KINDS: readonly ItemEffect['kind'][] = ['heal', 'restore-ammo', 'repair']

/** One content entry: which item, what it costs in AP, and what it does. */
export interface ItemEffectDefinition {
  id: string
  name: string
  itemId: string
  /** AP the *caller* spends. Surfaced so the UI can price the action before committing to it. */
  apCost: number
  effect: ItemEffect
  description: string
}

/** At most one effect per item id (enforced by `validateCampaignCatalog`), so `find` is total. */
export const effectForItem = (effects: readonly ItemEffectDefinition[], itemId: string): ItemEffectDefinition | null =>
  effects.find((entry) => entry.itemId === itemId) ?? null

export type QuickSlotUseFailure =
  /** Slot index outside `0..QUICK_SLOT_COUNT - 1`. */
  | 'index'
  /** Nothing is assigned to the slot. */
  | 'empty-slot'
  /** The slot names an item the backpack no longer carries: a desync, not a spend. */
  | 'missing-item'
  /** The item exists but content gives it no effect, so using it would consume it for nothing. */
  | 'no-effect'

export interface QuickSlotUse {
  inventory: Inventory
  itemId: string
  /** The effect the caller must now apply to the unit. Not applied here. */
  effect: ItemEffect
  /** AP the caller must now charge. Not charged here. */
  apCost: number
  /** Units of the item still in the backpack after this use. */
  remaining: number
  /** True when the last unit was spent and the slot is now empty (`pruneQuickSlots`). */
  slotCleared: boolean
}

export type QuickSlotUseResult =
  | { ok: true; value: QuickSlotUse }
  | { ok: false; reason: QuickSlotUseFailure; inventory: Inventory }

/**
 * Spends one unit of the consumable in `slotIndex`.
 *
 * Atomic in both directions: the effect is resolved from content **before** anything is removed, so
 * an item with no effect is never consumed, and the removal itself goes through `removeItem` on the
 * `backpack` pool, which prunes the quick slots in the same step — a slot can never outlive its
 * item's last unit (W5-03 acceptance criterion 3, and the save validator's rule that every slotted
 * item is present in the backpack).
 *
 * The stash is never read or written: a quick slot is a *mission* affordance, and pulling from base
 * storage mid-encounter would make the weight budget decorative.
 */
export function useQuickSlotConsumable(
  inventory: Inventory,
  slotIndex: number,
  effects: readonly ItemEffectDefinition[],
): QuickSlotUseResult {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= QUICK_SLOT_COUNT)
    return { ok: false, reason: 'index', inventory }
  const itemId = inventory.quickSlots[slotIndex] ?? null
  if (!itemId) return { ok: false, reason: 'empty-slot', inventory }
  const definition = effectForItem(effects, itemId)
  /* Refused before the removal: consuming an item that does nothing is a silent loss of loot. */
  if (!definition) return { ok: false, reason: 'no-effect', inventory }
  const removed = removeItem(inventory, itemId, 1, 'backpack')
  if (!removed.ok) return { ok: false, reason: 'missing-item', inventory }
  const next = removed.inventory
  return {
    ok: true,
    value: {
      inventory: next,
      itemId,
      effect: definition.effect,
      apCost: definition.apCost,
      remaining: itemQuantity(next, itemId, 'backpack'),
      slotCleared: next.quickSlots[slotIndex] === null,
    },
  }
}
