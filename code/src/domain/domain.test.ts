import { describe, expect, it } from 'vitest'
import { applyUpgrade, craft, defaultBase, repairGear, treatHero, type BaseUpgradeDefinition, type RecipeDefinition } from './base'
import { claimReward, createCampaign, firstDeathReturn, missionDefeat, missionVictory, retreatFromMission, retryMission, returnFromMission, startMission } from './campaign'
import { addItem, addResource, assignQuickSlot, backpackWeight, createInventory, depositBackpack, equipmentDurabilityPercent, damageEquipment, itemQuantity, resourceQuantity, transferItem, transferResource, type EquipmentInstance } from './inventory'
import { awardReward } from './rewards'

const vest = (): EquipmentInstance => ({ instanceId: 'vest-1', itemId: 'patched-vest', slot: 'torso', durability: 60, maxDurability: 100 })
const stocked = (metal = 10) => addItem(addResource(createInventory(20, [vest()]), 'metal', metal, 1, 'stash').inventory, 'field-bandage', 2, 1, 'stash').inventory
const upgrades: BaseUpgradeDefinition[] = [{ id: 'stash-2', name: 'Склад L2', node: 'stash', targetLevel: 2, cost: { metal: 5 }, effect: { kind: 'stash-capacity', capacityBonus: 10 }, description: 'Вместимость рюкзака +10' }]
const recipes: RecipeDefinition[] = [{ id: 'bandage', name: 'Бинт', node: 'workbench', nodeLevel: 1, cost: { cloth: 1 }, output: { itemId: 'field-bandage', quantity: 1 }, description: '1 ткань → 1 бинт' }]

describe('M2 pure domain', () => {
  it('separates the weight-limited backpack from the unlimited stash', () => {
    const inventory = addResource(createInventory(3), 'metal', 50, 1, 'stash').inventory
    expect(resourceQuantity(inventory, 'metal', 'stash')).toBe(50)
    expect(backpackWeight(inventory)).toBe(0)
    const moved = transferResource(inventory, 'metal', 3, 'stash')
    expect(moved).toMatchObject({ ok: true, moved: 3 })
    if (moved.ok) expect(backpackWeight(moved.inventory)).toBe(3)
    if (moved.ok) expect(transferResource(moved.inventory, 'metal', 1, 'stash')).toMatchObject({ ok: false, reason: 'no-capacity' })
    if (moved.ok) expect(resourceQuantity(moved.inventory, 'metal', 'stash')).toBe(47)
  })
  it('keeps quick slots bound to backpack items only and deposits the backpack on return', () => {
    const carried = transferItem(addItem(createInventory(10), 'field-bandage', 2, 1, 'stash').inventory, 'field-bandage', 1, 'stash')
    expect(carried.ok).toBe(true)
    if (!carried.ok) return
    expect(assignQuickSlot(carried.inventory, 0, 'field-bandage')).toMatchObject({ ok: true })
    expect(assignQuickSlot(carried.inventory, 4, 'field-bandage')).toMatchObject({ ok: false, reason: 'index' })
    expect(assignQuickSlot(createInventory(10), 0, 'field-bandage')).toMatchObject({ ok: false, reason: 'missing-item' })
    const assigned = assignQuickSlot(carried.inventory, 0, 'field-bandage')
    if (!assigned.ok) return
    const home = depositBackpack(assigned.inventory)
    expect(itemQuantity(home, 'field-bandage', 'backpack')).toBe(0)
    expect(itemQuantity(home, 'field-bandage', 'stash')).toBe(2)
    expect(home.quickSlots).toEqual([null, null, null, null])
  })
  it('awards mission content once into the stash without silent capacity loss', () => {
    const reward = { id: 'reward', xp: 80, resources: { metal: 40 }, items: [{ id: 'field-bandage', quantity: 1, weight: 1 }], oneTime: true }
    const result = awardReward(createInventory(2), reward, [])
    expect(result.awarded).toEqual(['40 metal', '1 field-bandage'])
    expect(result.overflow).toEqual([])
    expect(resourceQuantity(result.inventory, 'metal', 'stash')).toBe(40)
    expect(awardReward(createInventory(2), reward, ['reward']).alreadyClaimed).toBe(true)
  })
  it('repairs equipment durability while the medbay only changes HP', () => {
    const inventory = stocked()
    const repaired = repairGear(inventory)
    expect(repaired).toMatchObject({ ok: true, cost: { metal: 8 } })
    if (!repaired.ok) return
    expect(equipmentDurabilityPercent(repaired.equipment)).toBe(100)
    expect(resourceQuantity(repaired.inventory, 'metal', 'stash')).toBe(2)
    expect(repairGear(repaired.inventory)).toMatchObject({ ok: false, reason: 'not-damaged' })
    const treated = treatHero(defaultBase(), inventory, 12, 24)
    expect(treated).toMatchObject({ ok: true, health: 18, healed: 6 })
    if (!treated.ok) return
    expect(treated.inventory.equipment[0].durability).toBe(60)
    expect(itemQuantity(treated.inventory, 'field-bandage', 'stash')).toBe(1)
    expect(treatHero(defaultBase(), createInventory(20, [vest()]), 12, 24)).toMatchObject({ ok: false, reason: 'no-bandage' })
    expect(repairGear(damageEquipment(createInventory(20, [vest()]), 'vest-1', 10))).toMatchObject({ ok: false, reason: 'insufficient-resources' })
  })
  it('crafts atomically from the stash and rolls back when resources are missing', () => {
    const withCloth = addResource(createInventory(20), 'cloth', 1, 1, 'stash').inventory
    const crafted = craft(defaultBase(), withCloth, 'bandage', recipes, () => 1)
    expect(crafted).toMatchObject({ ok: true })
    if (!crafted.ok) return
    expect(itemQuantity(crafted.inventory, 'field-bandage', 'stash')).toBe(1)
    expect(resourceQuantity(crafted.inventory, 'cloth', 'stash')).toBe(0)
    const failed = craft(defaultBase(), crafted.inventory, 'bandage', recipes, () => 1)
    expect(failed).toMatchObject({ ok: false, reason: 'insufficient-resources' })
    expect(craft(defaultBase(), withCloth, 'unknown', recipes, () => 1)).toMatchObject({ ok: false, reason: 'unknown-recipe' })
    expect(craft(defaultBase(), withCloth, 'bandage', [{ ...recipes[0], nodeLevel: 3 }], () => 1)).toMatchObject({ ok: false, reason: 'node-locked' })
  })
  it('validates a single data-driven storage upgrade and grows backpack capacity', () => {
    const upgraded = applyUpgrade(defaultBase(), stocked(), 'stash-2', upgrades)
    expect(upgraded).toMatchObject({ ok: true, base: { stash: 2 } })
    if (!upgraded.ok) return
    expect(upgraded.inventory.backpackCapacity).toBe(30)
    expect(resourceQuantity(upgraded.inventory, 'metal', 'stash')).toBe(5)
    expect(applyUpgrade(upgraded.base, upgraded.inventory, 'stash-2', upgrades)).toMatchObject({ ok: false, reason: 'wrong-level' })
    expect(applyUpgrade(defaultBase(), createInventory(20), 'stash-2', upgrades)).toMatchObject({ ok: false, reason: 'insufficient-resources' })
  })
  it('moves the mission only through campaign transitions and rejects duplicates', () => {
     const missions = [{ id: 'mission', zoneId: 'zone', order: 1, rewardId: 'r', arenaId: 'arena' }]
     const active = startMission(createCampaign(missions, 'test-catalog'), undefined, missions)
    expect(active.screen).toBe('mission')
    expect(startMission(active)).toBe(active)
     const won = missionVictory(active, missions)
    expect(won.screen).toBe('reward')
     expect(missionVictory(won, missions)).toBe(won)
    expect(missionDefeat(won)).toBe(won)
    const claimed = claimReward(won, 'r', 80)
    expect(claimed).toMatchObject({ screen: 'home', xp: 80, activeMissionId: null })
    expect(claimReward(claimed, 'r', 80)).toBe(claimed)
    const defeated = missionDefeat(active)
    expect(defeated.screen).toBe('return')
    expect(firstDeathReturn(defeated)).toMatchObject({ screen: 'home', firstDeathReturnUsed: true, returnReason: null })
    expect(firstDeathReturn({ ...defeated, firstDeathReturnUsed: true })).toMatchObject({ screen: 'home', firstDeathReturnUsed: true })
     expect(retryMission(defeated, missions).screen).toBe('mission')
    expect(returnFromMission(claimed)).toBe(claimed)
  })
  it('separates a retreat from a defeat, so only a defeat can cost XP', () => {
    /* W4-02 criterion 5: the two exits share the encounter bookkeeping and nothing else. */
    const missions = [{ id: 'mission', zoneId: 'zone', order: 1, rewardId: 'r', arenaId: 'arena' }]
    const active = startMission(createCampaign(missions, 'test-catalog'), undefined, missions)
    const defeated = missionDefeat(active)
    const retreated = retreatFromMission(active)
    expect(defeated).toMatchObject({ screen: 'return', returnReason: 'defeat', mission: { status: 'failed' } })
    expect(retreated).toMatchObject({ screen: 'return', returnReason: 'retreat', mission: { status: 'failed' } })
    /* Neither grants a reward, and both stay retryable. */
    for (const state of [defeated, retreated]) {
      expect(claimReward(state, 'r', 80)).toBe(state)
      expect(retryMission(state, missions)).toMatchObject({ screen: 'mission', returnReason: null })
    }
    /* Only the defeat consumes the free-death allowance. */
    expect(firstDeathReturn(defeated).firstDeathReturnUsed).toBe(true)
    expect(firstDeathReturn(retreated).firstDeathReturnUsed).toBe(false)
    /* And neither leaves a stale reason behind on the base screen. */
    expect(firstDeathReturn(retreated)).toMatchObject({ screen: 'home', returnReason: null })
  })
})
