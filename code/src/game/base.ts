/** Pure base rules: node levels, persistent equipment repair, medbay healing and atomic crafting. */
import { addItem, hasResources, mostDamagedEquipment, removeItem, resourceQuantity, setBackpackCapacity, spendResources, type EquipmentInstance, type Inventory, type ResourceCost, type ResourceId } from './inventory'
export interface BaseState { workbench: number; medbay: number; stash: number }
export type BaseNode = keyof BaseState
export const BASE_NODES: BaseNode[] = ['workbench', 'medbay', 'stash']
export const NODE_LABELS: Record<BaseNode, string> = { workbench: 'Верстак', medbay: 'Медотсек', stash: 'Склад' }
export const MIN_NODE_LEVEL = 1; export const MAX_NODE_LEVEL = 3; export const BASE_BACKPACK_CAPACITY = 20
export const REPAIR_MATERIAL_RATE = 2; export const REPAIR_MATERIAL: ResourceId = 'metal'; export const MEDBAY_HEAL_PER_LEVEL = 6
export interface BaseUpgradeDefinition { id: string; name: string; node: BaseNode; targetLevel: number; cost: ResourceCost; capacityBonus: number; description: string }
export interface RecipeDefinition { id: string; name: string; node: BaseNode; nodeLevel: number; cost: ResourceCost; output: { itemId: string; quantity: number }; description: string }
export const defaultBase = (): BaseState => ({ workbench: 1, medbay: 1, stash: 1 })
export const isValidLevel = (level: unknown) => typeof level === 'number' && Number.isInteger(level) && level >= MIN_NODE_LEVEL && level <= MAX_NODE_LEVEL
export const isValidBase = (base: BaseState) => BASE_NODES.every((node) => isValidLevel(base[node]))
export const normalizeBase = (base: Partial<BaseState> | undefined): BaseState => ({ workbench: isValidLevel(base?.workbench) ? base!.workbench! : 1, medbay: isValidLevel(base?.medbay) ? base!.medbay! : 1, stash: isValidLevel(base?.stash) ? base!.stash! : 1 })
/** Stash itself is unlimited; its upgrade grows the mission backpack budget in this M2 slice. */
export const storageCapacity = (base: BaseState, upgrades: BaseUpgradeDefinition[] = []) => BASE_BACKPACK_CAPACITY + upgrades.filter((entry) => entry.node === 'stash' && entry.targetLevel <= base.stash).reduce((sum, entry) => sum + entry.capacityBonus, 0)
export const isNodeUnlocked = (base: BaseState, node: BaseNode, level: number) => base[node] >= level
export const repairCost = (integrity: number, maxIntegrity: number): ResourceCost => { const missing = Math.max(0, maxIntegrity - integrity); return missing === 0 ? {} : { [REPAIR_MATERIAL]: Math.ceil(missing / 10) * REPAIR_MATERIAL_RATE } }
export type RepairFailure = 'not-damaged' | 'insufficient-resources' | 'unknown-equipment'
export type RepairResult = { ok: true; inventory: Inventory; equipment: EquipmentInstance; cost: ResourceCost } | { ok: false; reason: RepairFailure; cost: ResourceCost }
/** Repair changes only an equipment instance's durability and spends stash material. Hero HP is never read or modified here. */
export function repairGear(inventory: Inventory, instanceId?: string): RepairResult {
 const equipment = instanceId ? inventory.equipment.find((entry) => entry.instanceId === instanceId) : mostDamagedEquipment(inventory)
 if (!equipment) return { ok: false, reason: instanceId ? 'unknown-equipment' : 'not-damaged', cost: {} }
 const cost = repairCost(equipment.durability, equipment.maxDurability)
 if (equipment.durability >= equipment.maxDurability) return { ok: false, reason: 'not-damaged', cost }
 const spent = spendResources(inventory, cost, 'stash'); if (!spent) return { ok: false, reason: 'insufficient-resources', cost }
 const repaired = { ...equipment, durability: equipment.maxDurability }
 return { ok: true, inventory: { ...spent, equipment: spent.equipment.map((entry) => entry.instanceId === equipment.instanceId ? repaired : entry) }, equipment: repaired, cost }
}
export const healAmount = (base: BaseState) => base.medbay * MEDBAY_HEAL_PER_LEVEL
export const MEDBAY_ITEM = 'field-bandage'
export type HealFailure = 'not-wounded' | 'no-bandage'
export type HealResult = { ok: true; inventory: Inventory; health: number; healed: number } | { ok: false; reason: HealFailure }
/** Medbay changes only HP and consumes a stash bandage; it cannot repair equipment. */
export function treatHero(base: BaseState, inventory: Inventory, health: number, maxHealth: number): HealResult { if (health >= maxHealth) return { ok: false, reason: 'not-wounded' }; const spent = removeItem(inventory, MEDBAY_ITEM, 1, 'stash'); if (!spent.ok) return { ok: false, reason: 'no-bandage' }; const healed = Math.min(maxHealth - health, healAmount(base)); return { ok: true, inventory: spent.inventory, health: health + healed, healed } }
export type CraftFailure = 'unknown-recipe' | 'node-locked' | 'insufficient-resources'
export type CraftResult = { ok: true; inventory: Inventory; recipe: RecipeDefinition } | { ok: false; reason: CraftFailure }
/** One atomic stash transaction: preflight resources, spend, then add output to unlimited stash. */
export function craft(base: BaseState, inventory: Inventory, recipeId: string, recipes: RecipeDefinition[], itemWeight: (itemId: string) => number): CraftResult { const recipe = recipes.find((entry) => entry.id === recipeId); if (!recipe) return { ok: false, reason: 'unknown-recipe' }; if (!isNodeUnlocked(base, recipe.node, recipe.nodeLevel)) return { ok: false, reason: 'node-locked' }; if (!hasResources(inventory, recipe.cost, 'stash')) return { ok: false, reason: 'insufficient-resources' }; const spent = spendResources(inventory, recipe.cost, 'stash'); if (!spent) return { ok: false, reason: 'insufficient-resources' }; return { ok: true, inventory: addItem(spent, recipe.output.itemId, recipe.output.quantity, itemWeight(recipe.output.itemId), 'stash').inventory, recipe } }
export type UpgradeFailure = 'unknown-upgrade' | 'wrong-level' | 'max-level' | 'insufficient-resources'
export type UpgradeResult = { ok: true; base: BaseState; inventory: Inventory; upgrade: BaseUpgradeDefinition } | { ok: false; reason: UpgradeFailure }
export function upgradeBlocker(base: BaseState, upgrade: BaseUpgradeDefinition): UpgradeFailure | null { if (base[upgrade.node] >= MAX_NODE_LEVEL) return 'max-level'; return upgrade.targetLevel !== base[upgrade.node] + 1 ? 'wrong-level' : null }
export const canUpgrade = (base: BaseState, inventory: Inventory, upgrade: BaseUpgradeDefinition) => upgradeBlocker(base, upgrade) === null && hasResources(inventory, upgrade.cost, 'stash')
export const missingResources = (inventory: Inventory, cost: ResourceCost): ResourceCost => Object.fromEntries((Object.entries(cost) as [ResourceId, number][]).map(([id, amount]) => [id, Math.max(0, amount - resourceQuantity(inventory, id, 'stash'))]).filter(([, amount]) => (amount as number) > 0))
export function applyUpgrade(base: BaseState, inventory: Inventory, upgradeId: string, catalog: BaseUpgradeDefinition[]): UpgradeResult { const upgrade = catalog.find((entry) => entry.id === upgradeId); if (!upgrade) return { ok: false, reason: 'unknown-upgrade' }; const blocked = upgradeBlocker(base, upgrade); if (blocked) return { ok: false, reason: blocked }; const spent = spendResources(inventory, upgrade.cost, 'stash'); if (!spent) return { ok: false, reason: 'insufficient-resources' }; const nextBase = { ...base, [upgrade.node]: upgrade.targetLevel }; return { ok: true, base: nextBase, inventory: setBackpackCapacity(spent, storageCapacity(nextBase, catalog)), upgrade } }
