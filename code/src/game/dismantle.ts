/**
 * W5-04 — the **pure** dismantle half of equipment maintenance (repair already lives in `base.ts`).
 *
 * Dismantling destroys one `EquipmentInstance` and pays back resources into the unlimited stash.
 * Three properties are structural rather than left to the caller:
 *
 *   1. **Atomic.** The return is computed and the whole payout is applied, or the inventory is
 *      returned untouched with an explicit reason. There is no path that removes the instance
 *      without paying, and none that pays without removing it.
 *   2. **No profit.** A craft → dismantle cycle can never be an income source. The ceiling is
 *      `MAX_RETURN_RATE` of the recipe cost of the same item, expressed here as
 *      `dismantleCeiling` and checked at *content load* by `validateCampaignCatalog`, so a table
 *      that would print resources is a load-time error rather than an exploit to be discovered by
 *      the economy simulator later (W5-04 acceptance criterion 4).
 *   3. **No desync.** The instance disappears from `inventory.equipment`, and gear the hero is
 *      actually wearing is **refused outright** (`'equipped'`), which is exactly the failure the
 *      W5-04 API contract names (criterion 5).
 *
 * **Why worn gear is refused rather than merely confirmed.** An earlier revision let a second,
 * explicit press destroy worn gear. That was a soft lock, not a hard choice: arena templates hardcode
 * the hero's loadout (`hero-hornet`, `starter-vest` in all three shipped arenas) and
 * `hydrateArenaUnits` rebuilds `weaponState`/`armor` from the *template* on every mission start. Once
 * the matching instance is gone, hydration re-creates the reference to an instance that no longer
 * exists, `validateSave` rejects the payload (`units[0].weaponState.weaponInstanceId — ссылка на
 * inventory equipment instance`), and the mission can never start again. There is no equip/loadout
 * system to swap in a replacement (that is W7 territory) and no shipped reward grants a second weapon
 * or armour piece, so the destruction is unrecoverable. Refusing is the only honest rule while the
 * hero's loadout is content rather than a player choice; the confirmation flow is kept for *spare*
 * gear, which is irreversible but not load-bearing.
 *
 * The return table is **content**, not code (`public/config/return-tables.json`, kind
 * `return-tables`). Nothing here restates a number.
 *
 * Deliberately *not* implemented: any dependence of the payout on the instance's durability. The
 * historical formula in doc 08 §8.5.1 scales the return by the `Repair` skill, and no skill system
 * exists (`W4-03`). Scaling by durability instead would be an invented rule with two bad effects:
 * a broken weapon — the case doc 08 §8.5.4 says should be dismantled — would return nothing, and
 * repairing before dismantling would become the optimal play, converting `metal` into `metal` at a
 * rate no owner approved. A flat table is the honest version of "потолок возврата".
 */
import type { Unit } from './combat'
import {
  addResource,
  removeItem,
  type EquipmentInstance,
  type Inventory,
  type ResourceCost,
  type ResourceId,
} from './inventory'

/** One content entry: what an item id yields when destroyed. */
export interface ReturnTableDefinition {
  id: string
  name: string
  /** `EquipmentInstance.itemId` (a weapon or armour id), or a craftable item id. */
  itemId: string
  /** Resources paid into the stash. At least one entry must be > 0 (validated). */
  returns: ResourceCost
  description: string
}

/** The whole shipped table set; lookup is by `itemId`, unique across entries (validated). */
export type ReturnTable = readonly ReturnTableDefinition[]

/**
 * Share of a craft cost a dismantle may return, as the ceiling every table is validated against.
 *
 * 0.5 is the *floor* of the historical `50% + Repair × 0.25%` formula (doc 08 §8.5.1). With no
 * `Repair` skill in the game the floor is the whole formula, and taking the floor rather than the
 * 75% maximum is what makes the cycle strictly lossy instead of nearly free.
 */
export const MAX_RETURN_RATE = 0.5

/**
 * The most a dismantle may return for something crafted at `cost`, per resource. Floored, so a
 * one-unit cost returns nothing at all: rounding a dismantle *up* is precisely how a
 * craft → dismantle loop becomes a resource printer.
 */
export const dismantleCeiling = (cost: ResourceCost): ResourceCost =>
  Object.fromEntries(
    (Object.entries(cost) as [ResourceId, number][])
      .map(([id, amount]) => [id, Math.floor(Math.max(0, amount) * MAX_RETURN_RATE)] as const)
      .filter(([, amount]) => amount > 0),
  ) as ResourceCost

/** Resources a return table pays for `itemId`, `{}` when the item has no table. */
export const returnsFor = (returnTable: ReturnTable, itemId: string): ResourceCost =>
  returnTable.find((entry) => entry.itemId === itemId)?.returns ?? {}

/** Total units in a cost/return, so "no profit" can be stated over the whole payout as well. */
export const totalUnits = (cost: ResourceCost) =>
  (Object.values(cost) as number[]).reduce((sum, amount) => sum + Math.max(0, amount), 0)

/**
 * Per-resource violations of the no-profit rule for one crafted item: every returned resource must
 * stay within `dismantleCeiling` of what the recipe charged, and a resource the recipe never charged
 * may not be returned at all (otherwise the cycle would be a converter rather than a loss).
 */
export function noProfitViolations(cost: ResourceCost, returns: ResourceCost): { resource: ResourceId; returned: number; ceiling: number }[] {
  const ceiling = dismantleCeiling(cost)
  return (Object.entries(returns) as [ResourceId, number][])
    .filter(([id, amount]) => amount > (ceiling[id] ?? 0))
    .map(([id, amount]) => ({ resource: id, returned: amount, ceiling: ceiling[id] ?? 0 }))
    .sort((left, right) => left.resource.localeCompare(right.resource))
}

/**
 * Instance ids a live encounter still points at (hero weapon and armour). Read-only over units, so
 * the combat slice owns unit state and this module only observes it.
 */
export function linkedEquipmentInstanceIds(units: readonly Unit[]): Set<string> {
  const linked = new Set<string>()
  for (const unit of units) {
    if (unit.team !== 'player') continue
    if (unit.weaponState?.weaponInstanceId) linked.add(unit.weaponState.weaponInstanceId)
    if (unit.armor?.armorInstanceId) linked.add(unit.armor.armorInstanceId)
  }
  return linked
}

export type DismantleFailure =
  /** No such instance in `inventory.equipment`. */
  | 'unknown-equipment'
  /** The hero is wearing/carrying this instance. Refused outright: see the module note. */
  | 'equipped'
  /** Content gives this item nothing back: destroying it would be a pure loss. */
  | 'no-yield'

export interface DismantleOptions {
  /** Instances the hero's loadout references; see `linkedEquipmentInstanceIds`. */
  linkedInstanceIds?: Iterable<string>
  /**
   * Explicit confirmation for a *spare* instance — one nothing references.
   *
   * Deliberately **not** an override for `'equipped'`: no argument can make destroying worn gear
   * recoverable while the loadout comes from arena templates, so the refusal is unconditional. This
   * flag exists so the shell has to state that the player confirmed an irreversible action
   * (criterion 3) rather than the domain assuming a dialog was shown.
   */
  confirmed?: boolean
}

export interface Dismantled {
  inventory: Inventory
  /** The instance as it was before removal, so the caller can report/undo at its own level. */
  equipment: EquipmentInstance
  /** Exactly what was paid into the stash. */
  gained: ResourceCost
}

export type DismantleResult =
  | { ok: true; value: Dismantled }
  | { ok: false; reason: DismantleFailure | 'unconfirmed'; inventory: Inventory; gained: ResourceCost }

/** Weight recorded on a *newly created* resource stack, matching `awardReward`'s payout. */
const RESOURCE_STACK_WEIGHT = 1

/**
 * Pays a return table into the stash, or reports that there is nothing to pay.
 *
 * Shared by the equipment and the item path so the payout rule exists once: whole units only, at
 * least one of them, and the transaction is abandoned if any add stores less than asked.
 */
function payReturns(inventory: Inventory, returns: ResourceCost): { inventory: Inventory; gained: ResourceCost } | null {
  const payable = (Object.entries(returns) as [ResourceId, number][]).filter(([, amount]) => Number.isInteger(amount) && amount > 0)
  if (!payable.length) return null
  let next = inventory
  const gained: ResourceCost = {}
  for (const [id, amount] of payable) {
    const result = addResource(next, id, amount, RESOURCE_STACK_WEIGHT, 'stash')
    /* The stash is unlimited, so a partial store is impossible; checked rather than trusted, because
       a half-paid dismantle would already have destroyed the source. */
    if (result.stored !== amount) return null
    next = result.inventory
    gained[id] = (gained[id] ?? 0) + amount
  }
  return { inventory: next, gained }
}

/**
 * Destroys `instanceId` and pays its table into the stash.
 *
 * Order matters and is not incidental: the payout is resolved and the refusals are decided **before**
 * the instance leaves `equipment`, so no refusal path can lose gear, and the equipment array is
 * rewritten only after every resource add reported the full amount stored.
 */
export function dismantleEquipment(
  inventory: Inventory,
  instanceId: string,
  returnTable: ReturnTable,
  options: DismantleOptions = {},
): DismantleResult {
  const equipment = inventory.equipment.find((entry) => entry.instanceId === instanceId)
  if (!equipment) return { ok: false, reason: 'unknown-equipment', inventory, gained: {} }
  const linked = new Set(options.linkedInstanceIds ?? [])
  const returns = returnsFor(returnTable, equipment.itemId)
  /* Unconditional: worn gear is load-bearing content, and destroying it cannot be undone or replaced.
     The return is still reported so the UI can explain what the player would have got. */
  if (linked.has(instanceId)) return { ok: false, reason: 'equipped', inventory, gained: returns }
  /* Ahead of the confirmation check on purpose: there is nothing to confirm about a destruction that
     pays nothing, so the player is never asked to approve a pure loss. */
  if (totalUnits(returns) === 0) return { ok: false, reason: 'no-yield', inventory, gained: {} }
  if (!options.confirmed) return { ok: false, reason: 'unconfirmed', inventory, gained: returns }
  const paid = payReturns(inventory, returns)
  if (!paid) return { ok: false, reason: 'no-yield', inventory, gained: {} }
  return {
    ok: true,
    value: {
      inventory: { ...paid.inventory, equipment: paid.inventory.equipment.filter((entry) => entry.instanceId !== instanceId) },
      equipment: { ...equipment },
      gained: paid.gained,
    },
  }
}

export type DismantleItemFailure = 'missing-item' | 'no-yield'

export interface DismantledItem {
  inventory: Inventory
  itemId: string
  gained: ResourceCost
}

export type DismantleItemResult =
  | { ok: true; value: DismantledItem }
  | { ok: false; reason: DismantleItemFailure; inventory: Inventory; gained: ResourceCost }

/**
 * The item-side counterpart: destroys one stashed unit of `itemId` for its table.
 *
 * It exists because **a recipe's output is an item, not an equipment instance**. Without this path
 * the "no craft → dismantle cycle is profitable" invariant could only be asserted about the tables,
 * never about the actual loop the player can run, and the shipped recipe set outputs bandages,
 * ammunition bundles, a repair kit and a plate — none of which is an `EquipmentInstance`.
 *
 * Stash-only and atomic for the same reason `craft` is: the item is removed first, and the payout is
 * applied to the post-removal inventory, so the two never half-happen.
 */
export function dismantleItem(inventory: Inventory, itemId: string, returnTable: ReturnTable): DismantleItemResult {
  const removed = removeItem(inventory, itemId, 1, 'stash')
  if (!removed.ok) return { ok: false, reason: 'missing-item', inventory, gained: {} }
  const paid = payReturns(removed.inventory, returnsFor(returnTable, itemId))
  if (!paid) return { ok: false, reason: 'no-yield', inventory, gained: {} }
  return { ok: true, value: { inventory: paid.inventory, itemId, gained: paid.gained } }
}
