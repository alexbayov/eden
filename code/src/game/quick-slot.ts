/**
 * W5-03 — the **combat** half of "use a consumable from a quick slot".
 *
 * `consumables.ts` owns the inventory transition and deliberately refuses to apply the effect or to
 * charge AP, because HP, weapon state and AP live on the `Unit`. This module is the missing other
 * half: it resolves the effect against the *live encounter*, prices it, applies it to the hero and
 * hands back both halves of the new state for one atomic save.
 *
 * Two properties are structural rather than left to the caller:
 *
 *   1. **Nothing is consumed on a refusal.** Every reason a use can fail — the slot, the item, the
 *      AP, and whether the effect would do anything at all — is decided by `quickSlotBlocker`
 *      *before* `useQuickSlotConsumable` is called. A bandage is never spent on a hero at full HP,
 *      and an ammo bundle is never spent on a calibre the equipped weapon cannot chamber. The
 *      domain function is pure, so "check then commit" is exact rather than best-effort.
 *   2. **The UI cannot disagree with the action.** `quickSlotBlocker` is the single predicate; the
 *      button label and the click handler both read it, so a slot rendered as available and then
 *      refused would be a contradiction inside one function rather than between two modules.
 *
 * The AP price comes from content (`item-effects.json`), never from a constant here: a use has to
 * cost something comparable to an attack, and that number is a balance decision.
 *
 * **Equipment durability is written to the unit, not to the inventory.** `persist` runs
 * `syncEquipmentInstances(inventory, units)`, which copies weapon and armour state from the unit
 * into the matching instance, so the unit is the authoritative side for anything a live encounter
 * holds. Repairing the inventory copy directly would create a second writer for the same number and
 * lose the race against that sync.
 */
import { isAlive, type Unit } from './combat'
import {
  effectForItem,
  useQuickSlotConsumable,
  type ItemEffect,
  type ItemEffectDefinition,
} from './consumables'
import { QUICK_SLOT_COUNT, itemQuantity, type Inventory } from './inventory'

/**
 * Why a quick slot cannot be used right now, or `null` when it can.
 *
 * A closed union so the view and the shell can both exhaust it, and so a new refusal has to be
 * given a player-facing sentence in `describeQuickSlotBlocker` instead of surfacing as a silent
 * no-op button.
 */
export type QuickSlotBlocker =
  /** Slot index outside `0..QUICK_SLOT_COUNT - 1`. */
  | 'index'
  /** The encounter is not accepting player actions (enemy phase, or a finished battle). */
  | 'not-player-turn'
  /** No hero in the encounter, or the hero is down. */
  | 'no-hero'
  /** Nothing assigned to the slot. */
  | 'empty-slot'
  /** The slot names an item the backpack no longer carries. */
  | 'missing-item'
  /** Content gives the item no effect, so using it would destroy it for nothing. */
  | 'no-effect'
  /** The hero cannot pay the effect's AP price this turn. */
  | 'insufficient-ap'
  /** A heal on a hero already at full HP: a wasted bandage. */
  | 'not-wounded'
  /** An ammo bundle with no weapon to load it into. */
  | 'no-weapon'
  /** An ammo bundle for a calibre the equipped weapon does not chamber. */
  | 'wrong-ammo'
  /** A repair with no damaged equipment to spend it on. */
  | 'nothing-to-repair'

/** Combat phases in which a quick slot may be used. Mirrors the rest of the combat gating. */
export type QuickSlotPhase = 'player' | 'enemy' | 'victory' | 'defeat'

export interface QuickSlotContext {
  hero: Unit | undefined
  inventory: Inventory
  effects: readonly ItemEffectDefinition[]
  phase: QuickSlotPhase
}

/**
 * Equipment the hero has in play, most damaged first, as the repair effect's candidate list.
 *
 * Only *linked* gear is repairable in the field: the instance ids come off the unit, so a field
 * repair can never touch a spare in the stash, and the durability it writes is the same number
 * `syncEquipmentInstances` will copy back into the inventory. Ties break on the instance id so the
 * choice is deterministic.
 */
export function repairableInField(hero: Unit | undefined): { instanceId: string; kind: 'weapon' | 'armor'; durability: number; maxDurability: number }[] {
  if (!hero) return []
  const candidates: { instanceId: string; kind: 'weapon' | 'armor'; durability: number; maxDurability: number }[] = []
  const weapon = hero.weaponState
  if (weapon && weapon.durability < weapon.maxDurability)
    candidates.push({ instanceId: weapon.weaponInstanceId, kind: 'weapon', durability: weapon.durability, maxDurability: weapon.maxDurability })
  const armor = hero.armor
  if (armor?.armorInstanceId && armor.durability < armor.maxDurability)
    candidates.push({ instanceId: armor.armorInstanceId, kind: 'armor', durability: armor.durability, maxDurability: armor.maxDurability })
  return candidates.sort(
    (left, right) =>
      left.durability / Math.max(1, left.maxDurability) - right.durability / Math.max(1, right.maxDurability) ||
      left.instanceId.localeCompare(right.instanceId),
  )
}

/**
 * Whether an effect would change anything if it were applied now.
 *
 * Split out from the AP and inventory checks because this is the class of refusal that protects
 * *loot* rather than state: every case here would consume the item and produce no observable
 * difference, which is the one outcome a player can neither see nor undo.
 */
const effectBlocker = (effect: ItemEffect, hero: Unit): QuickSlotBlocker | null => {
  switch (effect.kind) {
    case 'heal':
      return hero.hp >= hero.maxHp ? 'not-wounded' : null
    case 'restore-ammo':
      if (!hero.weaponState) return 'no-weapon'
      return hero.weaponState.ammoId === effect.ammoId ? null : 'wrong-ammo'
    case 'repair':
      return repairableInField(hero).length === 0 ? 'nothing-to-repair' : null
  }
}

/**
 * The single availability predicate. Ordered from the cheapest, most structural refusal to the most
 * situational one, so the reason a player is shown is the *first* thing that is actually wrong
 * rather than whichever check happened to run last.
 */
export function quickSlotBlocker(context: QuickSlotContext, slotIndex: number): QuickSlotBlocker | null {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= QUICK_SLOT_COUNT) return 'index'
  const itemId = context.inventory.quickSlots[slotIndex] ?? null
  if (!itemId) return 'empty-slot'
  if (itemQuantity(context.inventory, itemId, 'backpack') < 1) return 'missing-item'
  const definition = effectForItem(context.effects, itemId)
  if (!definition) return 'no-effect'
  if (context.phase !== 'player') return 'not-player-turn'
  const { hero } = context
  if (!hero || !isAlive(hero)) return 'no-hero'
  if (hero.ap < definition.apCost) return 'insufficient-ap'
  return effectBlocker(definition.effect, hero)
}

export interface QuickSlotUsed {
  /** Units with the hero's HP/AP/weapon/armour updated. Every other unit is untouched. */
  units: Unit[]
  /** Inventory with exactly one unit of the item removed and the slot pruned if it was the last. */
  inventory: Inventory
  itemId: string
  effect: ItemEffect
  apCost: number
  /** Units of the item still carried. */
  remaining: number
  slotCleared: boolean
  /** What the effect actually did, for the battle log. Never a restatement of the catalog copy. */
  applied: string
}

export type QuickSlotResult =
  | { ok: true; value: QuickSlotUsed }
  | { ok: false; reason: QuickSlotBlocker }

/** Applies one resolved effect to the hero and reports what it did. */
function applyToHero(hero: Unit, effect: ItemEffect, apCost: number): { hero: Unit; applied: string } {
  const paid = { ...hero, ap: hero.ap - apCost }
  switch (effect.kind) {
    case 'heal': {
      const healed = Math.min(effect.amount, hero.maxHp - hero.hp)
      return { hero: { ...paid, hp: hero.hp + healed }, applied: `+${healed} HP` }
    }
    case 'restore-ammo': {
      const weapon = paid.weaponState!
      return {
        hero: { ...paid, weaponState: { ...weapon, reserveAmmo: weapon.reserveAmmo + effect.amount } },
        applied: `запас ${effect.ammoId} +${effect.amount}`,
      }
    }
    case 'repair': {
      /* The single most damaged linked piece, not a spread: a repair kit is one repair. */
      const [target] = repairableInField(hero)
      const restored = Math.min(effect.amount, target.maxDurability - target.durability)
      if (target.kind === 'weapon')
        return {
          hero: { ...paid, weaponState: { ...paid.weaponState!, durability: target.durability + restored } },
          applied: `durability оружия +${restored}`,
        }
      return {
        hero: { ...paid, armor: { ...paid.armor!, durability: target.durability + restored } },
        applied: `durability брони +${restored}`,
      }
    }
  }
}

/**
 * Spends the consumable in `slotIndex` and applies its effect to the hero.
 *
 * Refusals are total and free: the blocker is decided first, so on every failure path the caller's
 * `units` and `inventory` are simply not replaced — there is no partial state to roll back, and no
 * item has left the backpack.
 */
export function useQuickSlot(
  context: QuickSlotContext,
  units: readonly Unit[],
  slotIndex: number,
): QuickSlotResult {
  const blocked = quickSlotBlocker(context, slotIndex)
  if (blocked) return { ok: false, reason: blocked }
  const spent = useQuickSlotConsumable(context.inventory, slotIndex, context.effects)
  /* Unreachable while the blocker agrees with the domain function; treated as a refusal rather than
     trusted, so a future divergence cannot half-apply a use. */
  if (!spent.ok) return { ok: false, reason: spent.reason }
  const hero = context.hero!
  const applied = applyToHero(hero, spent.value.effect, spent.value.apCost)
  return {
    ok: true,
    value: {
      units: units.map((unit) => (unit.id === hero.id ? applied.hero : unit)),
      inventory: spent.value.inventory,
      itemId: spent.value.itemId,
      effect: spent.value.effect,
      apCost: spent.value.apCost,
      remaining: spent.value.remaining,
      slotCleared: spent.value.slotCleared,
      applied: applied.applied,
    },
  }
}
