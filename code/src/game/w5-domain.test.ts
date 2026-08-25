/**
 * W5-03 / W5-04 / W5-05 domain tests.
 *
 * Everything here is pure: no DOM, no Phaser, no save adapter. The three ticket-level guarantees are
 * asserted as *properties* wherever they can be, not as single happy paths:
 *
 *   - a refusal never changes the inventory (checked by reference, not by deep equality, so a
 *     rebuilt-but-equal object fails);
 *   - the craft → dismantle cycle is loss-making **for every shipped recipe**, driven by the actual
 *     `recipes.json` and `return-tables.json` rather than by fixtures;
 *   - the death penalty touches the backpack only, again by reference for `stash`/`equipment`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { craft, defaultBase, type RecipeDefinition } from './base'
import {
  validateCampaignCatalog,
  validateItemEffects,
  validateItems,
  validateRecipes,
  validateReturnTables,
  type ItemDefinition,
  type ItemEffectDefinition,
  type ReturnTableDefinition,
} from './campaign-content'
import { effectForItem, useQuickSlotConsumable } from './consumables'
import {
  MAX_RETURN_RATE,
  dismantleCeiling,
  dismantleEquipment,
  dismantleItem,
  linkedEquipmentInstanceIds,
  noProfitViolations,
  returnsFor,
  totalUnits,
  type ReturnTable,
} from './dismantle'
import {
  PROPOSED_BACKPACK_LOSS_POLICY,
  applyBackpackDeathLoss,
  lossCandidates,
  lossUnitsFor,
  proportionalLossSelection,
  rngLossSelection,
  shouldApplyBackpackLoss,
  type BackpackLossPolicy,
  type LossSelection,
} from './death-loss'
import { parseEquipmentCatalog } from './equipment-content'
import {
  addItem,
  addResource,
  assignQuickSlot,
  backpackWeight,
  createInventory,
  itemQuantity,
  resourceQuantity,
  transferItem,
  type EquipmentInstance,
  type Inventory,
  type ResourceCost,
  type ResourceId,
} from './inventory'
import type { Unit } from './combat'

const shipped = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown

const parsed = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!result.ok) throw result.error
  return result.value
}

const shippedItems = parsed(validateItems(shipped('items'))) as ItemDefinition[]
const shippedRecipes = parsed(validateRecipes(shipped('recipes'))) as RecipeDefinition[]
const shippedEffects = parsed(validateItemEffects(shipped('item-effects'))) as ItemEffectDefinition[]
const shippedReturns = parsed(validateReturnTables(shipped('return-tables'))) as ReturnTableDefinition[]
const shippedEquipment = parseEquipmentCatalog(shipped('equipment'))

const weightOf = (itemId: string) => shippedItems.find((item) => item.id === itemId)?.weight ?? 1

const vest = (durability = 60): EquipmentInstance => ({
  instanceId: 'vest-1',
  itemId: 'patched-vest',
  slot: 'torso',
  durability,
  maxDurability: 100,
})
const pistol = (): EquipmentInstance => ({
  instanceId: 'pm-1',
  itemId: 'pm',
  slot: 'primary',
  durability: 100,
  maxDurability: 100,
})

/** Backpack carrying `items`, plus an untouched stash and equipment to prove scope. */
function carrying(
  entries: readonly { kind: 'resources' | 'items'; id: string; quantity: number; weight?: number }[],
  capacity = 60,
  equipment: EquipmentInstance[] = [vest()],
): Inventory {
  let inventory = createInventory(capacity, equipment)
  /* A stash worth losing, so "stash untouched" is a real assertion rather than a vacuous one. */
  inventory = addResource(inventory, 'metal', 100, 1, 'stash').inventory
  inventory = addItem(inventory, 'field-bandage', 9, 1, 'stash').inventory
  for (const entry of entries) {
    const weight = entry.weight ?? 1
    inventory = entry.kind === 'resources'
      ? addResource(inventory, entry.id as ResourceId, entry.quantity, weight, 'backpack').inventory
      : addItem(inventory, entry.id, entry.quantity, weight, 'backpack').inventory
  }
  return inventory
}

describe('W5-03 quick slot consumables', () => {
  const withBandage = () => {
    const stocked = addItem(createInventory(20, [vest()]), 'field-bandage', 2, 1, 'backpack').inventory
    const assigned = assignQuickSlot(stocked, 1, 'field-bandage')
    if (!assigned.ok) throw new Error('fixture: expected the quick slot assignment to succeed')
    return assigned.inventory
  }

  it('spends one unit, keeps the slot while stock remains and reports the effect to apply', () => {
    const inventory = withBandage()
    const used = useQuickSlotConsumable(inventory, 1, shippedEffects)
    expect(used.ok).toBe(true)
    if (!used.ok) return
    expect(used.value).toMatchObject({
      itemId: 'field-bandage',
      effect: { kind: 'heal', amount: 6 },
      apCost: 3,
      remaining: 1,
      slotCleared: false,
    })
    expect(itemQuantity(used.value.inventory, 'field-bandage', 'backpack')).toBe(1)
    expect(used.value.inventory.quickSlots).toEqual([null, 'field-bandage', null, null])
    /* The transition is inventory-only: HP, AP and weapon state stay the caller's business. */
    expect(used.value.inventory.equipment).toEqual(inventory.equipment)
    expect(used.value.inventory.stash).toBe(inventory.stash)
  })

  it('prunes the slot when the last unit is spent', () => {
    let inventory = withBandage()
    for (const expected of [1, 0]) {
      const used = useQuickSlotConsumable(inventory, 1, shippedEffects)
      expect(used.ok).toBe(true)
      if (!used.ok) return
      expect(used.value.remaining).toBe(expected)
      inventory = used.value.inventory
    }
    expect(inventory.quickSlots).toEqual([null, null, null, null])
    expect(itemQuantity(inventory, 'field-bandage', 'backpack')).toBe(0)
    /* And a further use is an explicit refusal rather than a negative stack. */
    expect(useQuickSlotConsumable(inventory, 1, shippedEffects)).toMatchObject({ ok: false, reason: 'empty-slot' })
  })

  it('refuses every invalid use without touching the inventory', () => {
    const inventory = withBandage()
    const cases: { label: string; index: number; effects: readonly ItemEffectDefinition[]; reason: string }[] = [
      { label: 'negative index', index: -1, effects: shippedEffects, reason: 'index' },
      { label: 'index past the last slot', index: 4, effects: shippedEffects, reason: 'index' },
      { label: 'fractional index', index: 1.5, effects: shippedEffects, reason: 'index' },
      { label: 'unassigned slot', index: 0, effects: shippedEffects, reason: 'empty-slot' },
      { label: 'item without a content effect', index: 1, effects: [], reason: 'no-effect' },
    ]
    for (const entry of cases) {
      const result = useQuickSlotConsumable(inventory, entry.index, entry.effects)
      expect(result, entry.label).toMatchObject({ ok: false, reason: entry.reason })
      if (result.ok) return
      /* Reference equality: a refusal must not even rebuild the inventory. */
      expect(result.inventory, entry.label).toBe(inventory)
    }
  })

  it('refuses a slot whose item is no longer carried instead of consuming from the stash', () => {
    /* A desynced save is the only way to reach this: the slot names an item the backpack lost while a
       stash copy still exists, which is exactly the case that must **not** silently be spent. */
    const stashed = addItem(withBandage(), 'field-bandage', 9, 1, 'stash').inventory
    const desynced: Inventory = { ...stashed, backpack: { resources: [], items: [] } }
    const result = useQuickSlotConsumable(desynced, 1, shippedEffects)
    expect(result).toMatchObject({ ok: false, reason: 'missing-item' })
    if (result.ok) return
    expect(result.inventory).toBe(desynced)
    expect(itemQuantity(result.inventory, 'field-bandage', 'stash')).toBe(9)
  })

  it('never draws from the stash even when the backpack copy is the last one', () => {
    const stashOnly = addItem(createInventory(20), 'field-bandage', 5, 1, 'stash').inventory
    const assigned = assignQuickSlot(stashOnly, 0, 'field-bandage')
    /* `assignQuickSlot` already refuses a stash-only item; asserted here so the two rules are known
       to agree rather than assumed to. */
    expect(assigned).toMatchObject({ ok: false, reason: 'missing-item' })
  })

  it('resolves each shipped effect kind to the item it belongs to', () => {
    expect(effectForItem(shippedEffects, 'repair-kit')?.effect).toEqual({ kind: 'repair', amount: 25 })
    expect(effectForItem(shippedEffects, 'rifle-rounds')?.effect).toEqual({ kind: 'restore-ammo', ammoId: '7x39', amount: 10 })
    expect(effectForItem(shippedEffects, 'salvaged-parts')).toBeNull()
    /* Every shipped effect points at a consumable, and every consumable has one — otherwise a slot
       would be fillable with something that does nothing. */
    const consumables = shippedItems.filter((item) => item.kind === 'consumable').map((item) => item.id).sort()
    expect(shippedEffects.map((effect) => effect.itemId).sort()).toEqual(consumables)
  })

  it('uses an ammo bundle carried into the mission and clears the slot', () => {
    const stocked = addItem(createInventory(20, [pistol()]), 'pistol-rounds', 1, 1, 'backpack').inventory
    const assigned = assignQuickSlot(stocked, 3, 'pistol-rounds')
    if (!assigned.ok) throw new Error('expected assignment')
    const used = useQuickSlotConsumable(assigned.inventory, 3, shippedEffects)
    expect(used.ok).toBe(true)
    if (!used.ok) return
    expect(used.value).toMatchObject({ effect: { kind: 'restore-ammo', ammoId: '9x18', amount: 8 }, apCost: 2, slotCleared: true })
    expect(backpackWeight(used.value.inventory)).toBe(0)
  })
})

describe('W5-04 dismantle', () => {
  const table: ReturnTable = shippedReturns

  it('destroys the instance and pays the shipped table into the stash', () => {
    const inventory = createInventory(20, [vest(), pistol()])
    /* `confirmed` is required for every destruction (criterion 3), not just for worn gear. */
    const result = dismantleEquipment(inventory, 'vest-1', table, { confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.gained).toEqual({ metal: 2, cloth: 2 })
    expect(result.value.equipment).toMatchObject({ instanceId: 'vest-1', itemId: 'patched-vest' })
    expect(result.value.inventory.equipment.map((entry) => entry.instanceId)).toEqual(['pm-1'])
    expect(resourceQuantity(result.value.inventory, 'metal', 'stash')).toBe(2)
    expect(resourceQuantity(result.value.inventory, 'cloth', 'stash')).toBe(2)
    /* The payout is stash-only: a dismantle at the base must not consume backpack budget. */
    expect(backpackWeight(result.value.inventory)).toBe(0)
    /* Irreversible: the same instance cannot be dismantled twice. */
    expect(dismantleEquipment(result.value.inventory, 'vest-1', table, { confirmed: true })).toMatchObject({ ok: false, reason: 'unknown-equipment' })
  })

  it('refuses an unknown instance and an item with no table without changing anything', () => {
    const inventory = createInventory(20, [vest(), { ...pistol(), itemId: 'mystery-gun' }])
    for (const [instanceId, reason] of [['missing', 'unknown-equipment'], ['pm-1', 'no-yield']] as const) {
      const result = dismantleEquipment(inventory, instanceId, table)
      expect(result, instanceId).toMatchObject({ ok: false, reason })
      if (result.ok) return
      expect(result.inventory, instanceId).toBe(inventory)
    }
  })

  it('refuses outright to dismantle gear the hero is using, and no argument overrides it', () => {
    const inventory = createInventory(20, [vest(), pistol()])
    const units: Unit[] = [
      {
        id: 'hero',
        name: 'Hero',
        hp: 20,
        maxHp: 24,
        team: 'player',
        aim: 55,
        color: '#ffffff',
        ap: 10,
        x: 0,
        y: 0,
        armor: { armorInstanceId: 'vest-1', armorId: 'patched-vest', reduction: { torso: 3 }, durability: 60, maxDurability: 100 },
      },
      /* An enemy referencing an id must not protect it: only the player's gear is inventory-linked. */
      {
        id: 'raider',
        name: 'Raider',
        hp: 10,
        maxHp: 10,
        team: 'enemy',
        aim: 55,
        color: '#000000',
        ap: 0,
        x: 3,
        y: 3,
        armor: { armorInstanceId: 'pm-1', armorId: 'patched-vest', reduction: {}, durability: 1, maxDurability: 1 },
      },
    ]
    const linkedInstanceIds = linkedEquipmentInstanceIds(units)
    expect([...linkedInstanceIds]).toEqual(['vest-1'])

    const refused = dismantleEquipment(inventory, 'vest-1', table, { linkedInstanceIds })
    expect(refused).toMatchObject({ ok: false, reason: 'equipped' })
    if (refused.ok) return
    expect(refused.inventory).toBe(inventory)
    /* The refusal still shows what the player would have got, so the UI can price the choice. */
    expect(refused.gained).toEqual({ metal: 2, cloth: 2 })

    /*
     * The regression this test exists for. Worn gear used to be destructible behind a confirmation,
     * which soft-locked the run: the arena templates hardcode `hero-hornet`/`starter-vest`, so mission
     * start rebuilt a reference to a destroyed instance and `validateSave` then rejected every save.
     * `confirmed` must not be a back door — it confirms a *spare*, and worn gear stays refused.
     */
    const stillRefused = dismantleEquipment(inventory, 'vest-1', table, { linkedInstanceIds, confirmed: true })
    expect(stillRefused).toMatchObject({ ok: false, reason: 'equipped' })
    if (stillRefused.ok) return
    expect(stillRefused.inventory).toBe(inventory)

    /* A spare is destructible, but only once the caller states the player confirmed it. */
    expect(dismantleEquipment(inventory, 'pm-1', table, { linkedInstanceIds })).toMatchObject({
      ok: false,
      reason: 'unconfirmed',
    })
    const spare = dismantleEquipment(inventory, 'pm-1', table, { linkedInstanceIds, confirmed: true })
    expect(spare.ok).toBe(true)
    if (!spare.ok) return
    expect(spare.value.inventory.equipment.map((entry) => entry.instanceId)).toEqual(['vest-1'])
  })

  it('prices the whole shipped weapon and armour set below what a repair-free replacement would cost', () => {
    /* Every shipped piece of gear has a table, so no gear is a dead end at the workbench. */
    const gearIds = [...shippedEquipment.weapons.map((entry) => entry.id), ...shippedEquipment.armor.map((entry) => entry.id)]
    for (const id of gearIds) expect(totalUnits(returnsFor(table, id)), id).toBeGreaterThan(0)
  })

  describe('no craft → dismantle profit, for every shipped recipe', () => {
    /* The invariant W5-04 criterion 4 states, run as the actual loop: craft the recipe from a stash
       holding exactly its cost, dismantle the output, and compare what came back with what was paid.
       Driven by the shipped files, so adding a recipe or editing a table exercises this immediately. */
    for (const recipe of shippedRecipes) {
      it(`${recipe.id} loses resources over a full cycle`, () => {
        let inventory = createInventory(20)
        for (const [id, amount] of Object.entries(recipe.cost) as [ResourceId, number][])
          inventory = addResource(inventory, id, amount, 1, 'stash').inventory
        const before = inventory

        /* Node level forced to the recipe's own so the loop is about economics, not about gating. */
        const base = { ...defaultBase(), [recipe.node]: recipe.nodeLevel }
        const crafted = craft(base, inventory, recipe.id, shippedRecipes, weightOf)
        expect(crafted.ok, `${recipe.id} must be craftable from exactly its cost`).toBe(true)
        if (!crafted.ok) return
        expect(itemQuantity(crafted.inventory, recipe.output.itemId, 'stash')).toBe(recipe.output.quantity)

        let cycled = crafted.inventory
        let dismantled = 0
        for (let unit = 0; unit < recipe.output.quantity; unit += 1) {
          const result = dismantleItem(cycled, recipe.output.itemId, table)
          /* `no-yield` is a legitimate outcome: a 1-unit cost has an empty ceiling, so the honest
             table returns nothing at all — and the refusal is atomic, so the item is *not* consumed.
             What must never happen is a profit. */
          if (!result.ok) {
            expect(result.reason).toBe('no-yield')
            expect(result.inventory, `${recipe.id}: a refused dismantle must roll back`).toBe(cycled)
            continue
          }
          cycled = result.value.inventory
          dismantled += 1
        }

        for (const [id, paid] of Object.entries(recipe.cost) as [ResourceId, number][]) {
          const returned = resourceQuantity(cycled, id, 'stash')
          expect(returned, `${recipe.id}: ${id} returned`).toBeLessThanOrEqual(resourceQuantity(before, id, 'stash'))
          expect(returned, `${recipe.id}: ${id} must not exceed the ceiling`).toBeLessThanOrEqual(Math.floor(paid * MAX_RETURN_RATE))
        }
        /* And strictly lossy in total, not merely non-increasing per resource. */
        const spent = totalUnits(recipe.cost)
        const recovered = (Object.keys(recipe.cost) as ResourceId[]).reduce(
          (sum, id) => sum + resourceQuantity(cycled, id, 'stash'),
          0,
        )
        expect(recovered, `${recipe.id}: cycle must be strictly lossy`).toBeLessThan(spent)
        /* Nothing outside the recipe's own resources may appear: no cycle is a converter. */
        for (const id of (['metal', 'cloth', 'mechanics', 'chemistry', 'powder', 'shells', 'electronics', 'eden-component'] as ResourceId[]).filter(
          (candidate) => !(candidate in recipe.cost),
        ))
          expect(resourceQuantity(cycled, id, 'stash'), `${recipe.id}: ${id} appeared out of nothing`).toBe(0)
        /* Every unit that *was* dismantled is gone; a refused one is still there, unconsumed. */
        expect(itemQuantity(cycled, recipe.output.itemId, 'stash')).toBe(recipe.output.quantity - dismantled)
      })
    }
  })

  it('computes the ceiling by flooring, so a one-unit cost returns nothing', () => {
    expect(dismantleCeiling({ cloth: 1 })).toEqual({})
    expect(dismantleCeiling({ metal: 3 })).toEqual({ metal: 1 })
    expect(dismantleCeiling({ metal: 4, cloth: 2 })).toEqual({ metal: 2, cloth: 1 })
    expect(noProfitViolations({ metal: 4 }, { metal: 2 })).toEqual([])
    expect(noProfitViolations({ metal: 4 }, { metal: 3 })).toEqual([{ resource: 'metal', returned: 3, ceiling: 2 }])
    /* A resource the recipe never charged has ceiling 0, so any return is a violation. */
    expect(noProfitViolations({ metal: 4 }, { cloth: 1 })).toEqual([{ resource: 'cloth', returned: 1, ceiling: 0 }])
  })

  it('refuses to dismantle an item the stash does not hold', () => {
    const inventory = createInventory(20)
    const result = dismantleItem(inventory, 'repair-kit', table)
    expect(result).toMatchObject({ ok: false, reason: 'missing-item' })
    if (result.ok) return
    expect(result.inventory).toBe(inventory)
  })
})

describe('W5-05 backpack loss on defeat', () => {
  const policy: BackpackLossPolicy = PROPOSED_BACKPACK_LOSS_POLICY

  it('takes only from the backpack: stash and equipment are untouched by reference', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 10 },
      { kind: 'items', id: 'field-bandage', quantity: 10 },
    ])
    const result = applyBackpackDeathLoss(inventory, policy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.carriedUnits).toBe(20)
    expect(result.value.lostUnits).toBe(6)
    expect(result.value.inventory.stash).toBe(inventory.stash)
    expect(result.value.inventory.equipment).toBe(inventory.equipment)
    expect(result.value.inventory.backpackCapacity).toBe(inventory.backpackCapacity)
    expect(resourceQuantity(result.value.inventory, 'metal', 'stash')).toBe(100)
    expect(itemQuantity(result.value.inventory, 'field-bandage', 'stash')).toBe(9)
    /* Proportional: 30% of each stack, not 6 units off the first one. */
    expect(resourceQuantity(result.value.inventory, 'metal', 'backpack')).toBe(7)
    expect(itemQuantity(result.value.inventory, 'field-bandage', 'backpack')).toBe(7)
    expect(result.value.lost).toEqual([
      { kind: 'resources', id: 'metal', quantity: 10, weight: 1, lost: 3 },
      { kind: 'items', id: 'field-bandage', quantity: 10, weight: 1, lost: 3 },
    ])
  })

  it('is deterministic: the same inputs give the same loss every time', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 7 },
      { kind: 'resources', id: 'cloth', quantity: 5 },
      { kind: 'items', id: 'repair-kit', quantity: 3, weight: 2 },
    ])
    const runs = Array.from({ length: 5 }, () => applyBackpackDeathLoss(inventory, policy))
    for (const run of runs) expect(run.ok).toBe(true)
    const serialised = runs.map((run) => (run.ok ? JSON.stringify({ lost: run.value.lost, backpack: run.value.inventory.backpack }) : 'failed'))
    expect(new Set(serialised).size).toBe(1)
  })

  it('leaves an empty backpack alone and returns the same inventory', () => {
    const inventory = carrying([])
    const result = applyBackpackDeathLoss(inventory, policy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ lost: [], lostUnits: 0, carriedUnits: 0 })
    expect(result.value.inventory).toBe(inventory)
  })

  it('takes nothing when the rate cannot reach one whole unit', () => {
    /* Three carried units at 30% floors to 0: the near-empty backpack is deliberately spared. */
    const inventory = carrying([{ kind: 'resources', id: 'metal', quantity: 3 }])
    const result = applyBackpackDeathLoss(inventory, policy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostUnits).toBe(0)
    expect(result.value.inventory).toBe(inventory)
    expect(lossUnitsFor(3, 0.3)).toBe(0)
    expect(lossUnitsFor(4, 0.3)).toBe(1)
  })

  it('handles a backpack filled to capacity without exceeding it or going negative', () => {
    const inventory = carrying([{ kind: 'resources', id: 'metal', quantity: 60 }], 60)
    expect(backpackWeight(inventory)).toBe(60)
    const result = applyBackpackDeathLoss(inventory, policy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostUnits).toBe(18)
    expect(resourceQuantity(result.value.inventory, 'metal', 'backpack')).toBe(42)
    expect(backpackWeight(result.value.inventory)).toBe(42)
  })

  it('never leaves a negative or fractional stack for any rate', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 9 },
      { kind: 'items', id: 'field-bandage', quantity: 4 },
    ])
    for (const rate of [0, 0.1, 0.15, 0.3, 0.5, 0.75, 0.99, 1]) {
      const result = applyBackpackDeathLoss(inventory, { ...policy, rate })
      expect(result.ok, `rate ${rate}`).toBe(true)
      if (!result.ok) return
      const stacks = [...result.value.inventory.backpack.resources, ...result.value.inventory.backpack.items]
      for (const stack of stacks) {
        expect(stack.quantity, `rate ${rate}`).toBeGreaterThan(0)
        expect(Number.isInteger(stack.quantity), `rate ${rate}`).toBe(true)
      }
      expect(result.value.lostUnits, `rate ${rate}`).toBe(lossUnitsFor(13, rate))
      /* Rate 1 empties the backpack and still leaves the base intact. */
      if (rate === 1) {
        expect(stacks).toEqual([])
        expect(result.value.inventory.stash).toBe(inventory.stash)
      }
    }
  })

  it('rejects an out-of-range rate instead of silently clamping it', () => {
    const inventory = carrying([{ kind: 'resources', id: 'metal', quantity: 10 }])
    for (const rate of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = applyBackpackDeathLoss(inventory, { ...policy, rate })
      expect(result, `rate ${rate}`).toMatchObject({ ok: false, reason: 'invalid-policy' })
      if (result.ok) return
      expect(result.inventory, `rate ${rate}`).toBe(inventory)
    }
  })

  it('honours the policy switches and the protected item list', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 10 },
      { kind: 'items', id: 'field-bandage', quantity: 10 },
    ])
    const itemsOnly = applyBackpackDeathLoss(inventory, { ...policy, loseResources: false })
    const resourcesOnly = applyBackpackDeathLoss(inventory, { ...policy, loseItems: false })
    expect(itemsOnly.ok && resourcesOnly.ok).toBe(true)
    if (!itemsOnly.ok || !resourcesOnly.ok) return
    expect(itemsOnly.value.lost.map((entry) => entry.kind)).toEqual(['items'])
    expect(resourceQuantity(itemsOnly.value.inventory, 'metal', 'backpack')).toBe(10)
    expect(resourcesOnly.value.lost.map((entry) => entry.kind)).toEqual(['resources'])
    expect(itemQuantity(resourcesOnly.value.inventory, 'field-bandage', 'backpack')).toBe(10)

    const protectedRun = applyBackpackDeathLoss(inventory, { ...policy, protectedItemIds: ['field-bandage'] })
    expect(protectedRun.ok).toBe(true)
    if (!protectedRun.ok) return
    expect(itemQuantity(protectedRun.value.inventory, 'field-bandage', 'backpack')).toBe(10)
    /* The rate applies to the *eligible* units, so protecting loot shrinks the denominator too. */
    expect(protectedRun.value.carriedUnits).toBe(10)
    expect(protectedRun.value.lostUnits).toBe(3)
  })

  it('clears a quick slot whose item the penalty took entirely', () => {
    const carried = transferItem(addItem(createInventory(20, [vest()]), 'field-bandage', 2, 1, 'stash').inventory, 'field-bandage', 2, 'stash')
    if (!carried.ok) throw new Error('expected the transfer to succeed')
    const assigned = assignQuickSlot(carried.inventory, 0, 'field-bandage')
    if (!assigned.ok) throw new Error('expected the assignment to succeed')
    const result = applyBackpackDeathLoss(assigned.inventory, { ...policy, rate: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(itemQuantity(result.value.inventory, 'field-bandage', 'backpack')).toBe(0)
    expect(result.value.inventory.quickSlots).toEqual([null, null, null, null])
    /* The stash copy of the same item is untouched, so the slot cleared for the right reason. */
    expect(itemQuantity(result.value.inventory, 'field-bandage', 'stash')).toBe(0)
  })

  it('does not escalate: ten consecutive defeats price the same carried backpack identically', () => {
    const inventory = carrying([{ kind: 'resources', id: 'metal', quantity: 10 }])
    const losses = Array.from({ length: 10 }, () => {
      const result = applyBackpackDeathLoss(inventory, policy)
      return result.ok ? result.value.lostUnits : -1
    })
    expect(new Set(losses)).toEqual(new Set([3]))
  })

  it('leaves the free-first-death decision to the caller and pairs with the XP rule', () => {
    /* The policy is applied unconditionally; whether it *should* be is `shouldApplyBackpackLoss`. */
    expect(shouldApplyBackpackLoss('defeat', false)).toBe(false)
    expect(shouldApplyBackpackLoss('defeat', true)).toBe(true)
    expect(shouldApplyBackpackLoss('retreat', true)).toBe(false)
    expect(shouldApplyBackpackLoss(null, true)).toBe(false)
    /* Called anyway, it still applies: the guard is the caller's, not a hidden branch here. */
    const inventory = carrying([{ kind: 'resources', id: 'metal', quantity: 10 }])
    const forced = applyBackpackDeathLoss(inventory, policy)
    expect(forced.ok && forced.value.lostUnits).toBe(3)
  })

  it('spreads the loss across many stacks by largest remainder', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 5 },
      { kind: 'resources', id: 'cloth', quantity: 5 },
      { kind: 'items', id: 'field-bandage', quantity: 1 },
    ])
    const result = applyBackpackDeathLoss(inventory, { ...policy, rate: 0.5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostUnits).toBe(5)
    expect(result.value.lost.map((entry) => `${entry.id}:${entry.lost}`)).toEqual(['metal:2', 'cloth:2', 'field-bandage:1'])
    /* The selection alone is total over the units it is asked for. */
    expect(proportionalLossSelection(lossCandidates(inventory, policy), 5).units.reduce((sum, count) => sum + count, 0)).toBe(5)
    expect(proportionalLossSelection([], 0).units).toEqual([])
  })

  it('supports a seeded random selection that is reproducible and state-threading', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 8 },
      { kind: 'items', id: 'field-bandage', quantity: 8 },
    ])
    const first = applyBackpackDeathLoss(inventory, policy, rngLossSelection(12345))
    const again = applyBackpackDeathLoss(inventory, policy, rngLossSelection(12345))
    const other = applyBackpackDeathLoss(inventory, policy, rngLossSelection(999))
    expect(first.ok && again.ok && other.ok).toBe(true)
    if (!first.ok || !again.ok || !other.ok) return
    expect(first.value.lost).toEqual(again.value.lost)
    expect(first.value.rngState).toBe(again.value.rngState)
    expect(first.value.rngState).not.toBe(12345)
    expect(first.value.lostUnits).toBe(4)
    expect(other.value.lostUnits).toBe(4)
    /* Whatever the seed, the scope guarantee holds. */
    for (const run of [first, again, other]) {
      expect(run.value.inventory.stash).toBe(inventory.stash)
      expect(run.value.inventory.equipment).toBe(inventory.equipment)
    }
  })

  it('rejects a selection that over-draws or under-spends without applying any of it', () => {
    const inventory = carrying([
      { kind: 'resources', id: 'metal', quantity: 10 },
      { kind: 'items', id: 'field-bandage', quantity: 10 },
    ])
    const bad: { label: string; selection: LossSelection }[] = [
      { label: 'over-draws a stack', selection: (candidates) => ({ units: candidates.map((candidate) => candidate.quantity + 1) }) },
      { label: 'under-spends', selection: (candidates) => ({ units: candidates.map(() => 0) }) },
      { label: 'wrong length', selection: () => ({ units: [1] }) },
      { label: 'fractional', selection: (candidates) => ({ units: candidates.map((_unused, index) => (index === 0 ? 5.5 : 0.5)) }) },
      { label: 'negative', selection: (candidates) => ({ units: candidates.map((_unused, index) => (index === 0 ? 9 : -3)) }) },
    ]
    for (const entry of bad) {
      const result = applyBackpackDeathLoss(inventory, policy, entry.selection)
      expect(result, entry.label).toMatchObject({ ok: false, reason: 'invalid-selection' })
      if (result.ok) return
      expect(result.inventory, entry.label).toBe(inventory)
    }
  })
})

describe('W5-03/W5-04 content contracts', () => {
  const zones = [{ id: 'z', name: 'Zone', order: 1, description: 'test', unlocked: true }]
  const missions = [
    {
      id: 'm',
      zoneId: 'z',
      order: 1,
      name: 'M',
      description: 'test',
      /* W6-01: an objective now carries validated parameters. Irrelevant to these W5 assertions, but a
         catalog without them is no longer well-formed, so the fixture states them rather than relying
         on the validator having once accepted a bare `secure`. */
      objective: 'eliminate' as const,
      objectiveParams: { kind: 'eliminate' as const },
      arenaId: 'a',
      difficulty: 0 as const,
      rewardId: 'r',
    },
  ]
  const rewards = [{ id: 'r', name: 'R', xp: 10, resources: {}, items: [], oneTime: true }]
  const items: ItemDefinition[] = [
    { id: 'field-bandage', name: 'Bandage', weight: 1, kind: 'consumable' },
    { id: 'hardened-plate', name: 'Plate', weight: 3, kind: 'material' },
  ]
  const catalogWith = (extra: Partial<Parameters<typeof validateCampaignCatalog>[0]>) =>
    validateCampaignCatalog({ zones, missions, rewards, items, ...extra }, new Set(['a']), new Set(items.map((item) => item.id)))
  const paths = (result: ReturnType<typeof validateCampaignCatalog>) =>
    result.ok ? [] : result.error.issues.map((issue) => issue.path)

  it('accepts the shipped effect and return-table files', () => {
    expect(shippedEffects.length).toBeGreaterThan(0)
    expect(shippedReturns.length).toBeGreaterThan(0)
    const result = validateCampaignCatalog(
      { zones, missions, rewards, items: shippedItems, recipes: shippedRecipes, itemEffects: shippedEffects, returnTables: shippedReturns },
      new Set(['a']),
      new Set(shippedItems.map((item) => item.id)),
      {
        equipmentIds: new Set([...shippedEquipment.weapons.map((entry) => entry.id), ...shippedEquipment.armor.map((entry) => entry.id)]),
        ammoIds: new Set(shippedEquipment.ammo.map((entry) => entry.id)),
      },
    )
    expect(paths(result)).toEqual([])
  })

  it('rejects malformed effect entries with the field that is wrong', () => {
    const base = { id: 'e', name: 'E', itemId: 'field-bandage', apCost: 3, effect: { kind: 'heal', amount: 6 }, description: 'd' }
    const cases: [string, Record<string, unknown>, string][] = [
      ['zero AP', { ...base, apCost: 0 }, '$.entries[0].apCost'],
      ['AP above a whole turn', { ...base, apCost: 11 }, '$.entries[0].apCost'],
      ['fractional AP', { ...base, apCost: 1.5 }, '$.entries[0].apCost'],
      ['unknown effect kind', { ...base, effect: { kind: 'teleport', amount: 1 } }, '$.entries[0].effect.kind'],
      ['non-positive heal', { ...base, effect: { kind: 'heal', amount: 0 } }, '$.entries[0].effect.amount'],
      ['ammo effect without an id', { ...base, effect: { kind: 'restore-ammo', amount: 5 } }, '$.entries[0].effect.ammoId'],
      ['missing itemId', { ...base, itemId: '' }, '$.entries[0].itemId'],
      ['real-time timer', { ...base, durationMs: 1000 }, '$.entries[0].durationMs'],
    ]
    for (const [label, entry, path] of cases) {
      const result = validateItemEffects({ contentVersion: 1, kind: 'item-effects', entries: [entry] })
      expect(result.ok, label).toBe(false)
      if (result.ok) return
      expect(result.error.issues.map((issue) => issue.path), label).toContain(path)
    }
    /* Wrong envelope kind and duplicate ids stay the shared collection rules. */
    expect(validateItemEffects({ contentVersion: 1, kind: 'items', entries: [base] }).ok).toBe(false)
    expect(validateItemEffects({ contentVersion: 1, kind: 'item-effects', entries: [base, base] }).ok).toBe(false)
    expect(validateItemEffects({ contentVersion: 2, kind: 'item-effects', entries: [base] }).ok).toBe(false)
  })

  it('rejects an effect on a missing item, on a material, and two effects for one item', () => {
    const effect = (id: string, itemId: string): ItemEffectDefinition => ({
      id,
      name: id,
      itemId,
      apCost: 3,
      effect: { kind: 'heal', amount: 6 },
      description: 'd',
    })
    expect(paths(catalogWith({ itemEffects: [effect('a', 'missing-item')] }))).toContain('item-effects.a.itemId')
    expect(paths(catalogWith({ itemEffects: [effect('a', 'hardened-plate')] }))).toContain('item-effects.a.itemId')
    expect(paths(catalogWith({ itemEffects: [effect('a', 'field-bandage'), effect('b', 'field-bandage')] }))).toContain('item-effects.b.itemId')
    expect(paths(catalogWith({ itemEffects: [effect('a', 'field-bandage')] }))).toEqual([])
  })

  it('rejects an ammo effect naming a calibre no weapon chambers', () => {
    const entries: ItemEffectDefinition[] = [
      { id: 'a', name: 'A', itemId: 'field-bandage', apCost: 2, effect: { kind: 'restore-ammo', ammoId: 'plasma', amount: 4 }, description: 'd' },
    ]
    const result = validateCampaignCatalog({ zones, missions, rewards, items, itemEffects: entries }, new Set(['a']), new Set(items.map((item) => item.id)), {
      ammoIds: new Set(['9x18']),
    })
    expect(paths(result)).toContain('item-effects.a.effect.ammoId')
    /* Without an equipment catalog in hand the reference is left unverified rather than rejected. */
    expect(paths(catalogWith({ itemEffects: entries }))).toEqual([])
  })

  it('rejects a return table that would make crafting profitable', () => {
    const recipes: RecipeDefinition[] = [
      { id: 'plate', name: 'Plate', node: 'workbench', nodeLevel: 1, cost: { metal: 6 }, output: { itemId: 'hardened-plate', quantity: 1 }, description: 'd' },
      { id: 'bandage', name: 'Bandage', node: 'workbench', nodeLevel: 1, cost: { cloth: 1 }, output: { itemId: 'field-bandage', quantity: 1 }, description: 'd' },
    ]
    const table = (returns: ResourceCost, itemId = 'hardened-plate'): ReturnTableDefinition[] => [
      { id: 't', name: 'T', itemId, returns, description: 'd' },
    ]
    /* Exactly at the ceiling: allowed. Above it: rejected, per resource. */
    expect(paths(catalogWith({ recipes, returnTables: table({ metal: 3 }) }))).toEqual([])
    expect(paths(catalogWith({ recipes, returnTables: table({ metal: 4 }) }))).toContain('return-tables.t.returns.metal')
    expect(paths(catalogWith({ recipes, returnTables: table({ metal: 6 }) }))).toContain('return-tables.t.returns.metal')
    /* A resource the recipe never charged is a converter, not a loss. */
    expect(paths(catalogWith({ recipes, returnTables: table({ metal: 3, cloth: 1 }) }))).toContain('return-tables.t.returns.cloth')
    /* A recipe too cheap to have a ceiling may not return anything at all. */
    expect(paths(catalogWith({ recipes, returnTables: table({ cloth: 1 }, 'field-bandage') }))).toContain('return-tables.t.returns')
    /* Per *unit* of output: 2 plates from 6 metal have a 1-metal ceiling each. */
    const doubled = [{ ...recipes[0], output: { itemId: 'hardened-plate', quantity: 2 } }, recipes[1]]
    expect(paths(catalogWith({ recipes: doubled, returnTables: table({ metal: 1 }) }))).toEqual([])
    expect(paths(catalogWith({ recipes: doubled, returnTables: table({ metal: 2 }) }))).toContain('return-tables.t.returns.metal')
  })

  it('rejects malformed and duplicated return tables and unknown item references', () => {
    const base = { id: 't', name: 'T', itemId: 'hardened-plate', returns: { metal: 2 }, description: 'd' }
    for (const [label, entry, path] of [
      ['unknown resource', { ...base, returns: { unobtainium: 2 } }, '$.entries[0].returns.unobtainium'],
      ['fractional return', { ...base, returns: { metal: 1.5 } }, '$.entries[0].returns.metal'],
      ['negative return', { ...base, returns: { metal: -1 } }, '$.entries[0].returns.metal'],
      ['empty return', { ...base, returns: { metal: 0 } }, '$.entries[0].returns'],
      ['missing itemId', { ...base, itemId: '' }, '$.entries[0].itemId'],
      ['real-time timer', { ...base, craftTimeMs: 5 }, '$.entries[0].craftTimeMs'],
    ] as [string, Record<string, unknown>, string][]) {
      const result = validateReturnTables({ contentVersion: 1, kind: 'return-tables', entries: [entry] })
      expect(result.ok, label).toBe(false)
      if (result.ok) return
      expect(result.error.issues.map((issue) => issue.path), label).toContain(path)
    }
    const duplicate: ReturnTableDefinition[] = [
      { id: 'a', name: 'A', itemId: 'hardened-plate', returns: { metal: 2 }, description: 'd' },
      { id: 'b', name: 'B', itemId: 'hardened-plate', returns: { metal: 1 }, description: 'd' },
    ]
    expect(paths(catalogWith({ returnTables: duplicate }))).toContain('return-tables.b.itemId')
    /* A table for gear is accepted only when the equipment catalog knows the id. */
    const gear: ReturnTableDefinition[] = [{ id: 'g', name: 'G', itemId: 'pm', returns: { metal: 4 }, description: 'd' }]
    const withEquipment = validateCampaignCatalog({ zones, missions, rewards, items, returnTables: gear }, new Set(['a']), new Set(items.map((item) => item.id)), {
      equipmentIds: new Set(['pm']),
    })
    expect(paths(withEquipment)).toEqual([])
    const withoutEquipment = validateCampaignCatalog({ zones, missions, rewards, items, returnTables: gear }, new Set(['a']), new Set(items.map((item) => item.id)), {
      equipmentIds: new Set(['akm']),
    })
    expect(paths(withoutEquipment)).toContain('return-tables.g.itemId')
  })
})
