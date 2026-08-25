/** Pure base rules: node levels, persistent equipment repair, medbay healing and atomic crafting. */
import { addItem, hasResources, mostDamagedEquipment, removeItem, resourceQuantity, setBackpackCapacity, spendResources, type EquipmentInstance, type Inventory, type ResourceCost, type ResourceId } from './inventory'
export interface BaseState { workbench: number; medbay: number; stash: number }
export type BaseNode = keyof BaseState
export const BASE_NODES: BaseNode[] = ['workbench', 'medbay', 'stash']
export const NODE_LABELS: Record<BaseNode, string> = { workbench: 'Верстак', medbay: 'Медотсек', stash: 'Склад' }
export const MIN_NODE_LEVEL = 1; export const MAX_NODE_LEVEL = 3; export const BASE_BACKPACK_CAPACITY = 20
export const REPAIR_MATERIAL_RATE = 2; export const REPAIR_MATERIAL: ResourceId = 'metal'
/** Healing one bandage restores at medbay L1. Higher levels add `medbay-heal` bonuses from the catalog. */
export const MEDBAY_HEAL_PER_LEVEL = 6
/**
 * W5-01 — every node level states its effect in an explicit, node-specific field.
 *
 * `capacityBonus` used to be the only effect field, which forced a non-stash upgrade either to
 * abuse it or to have no machine-readable effect at all. One discriminated union instead: the kind
 * is fixed by the node (`EFFECT_KIND_BY_NODE`), so a medbay entry cannot silently grant backpack
 * capacity and a validator can reject the mismatch instead of the game applying nothing.
 */
export type BaseUpgradeEffect =
  | { kind: 'stash-capacity'; capacityBonus: number }
  | { kind: 'medbay-heal'; healBonus: number }
  | { kind: 'workbench-recipe-tier'; recipeLevel: number }
export const EFFECT_KIND_BY_NODE: Record<BaseNode, BaseUpgradeEffect['kind']> = { workbench: 'workbench-recipe-tier', medbay: 'medbay-heal', stash: 'stash-capacity' }
export interface BaseUpgradeDefinition { id: string; name: string; node: BaseNode; targetLevel: number; cost: ResourceCost; effect: BaseUpgradeEffect; description: string }
export interface RecipeDefinition { id: string; name: string; node: BaseNode; nodeLevel: number; cost: ResourceCost; output: { itemId: string; quantity: number }; description: string }
export const defaultBase = (): BaseState => ({ workbench: 1, medbay: 1, stash: 1 })
export const isValidLevel = (level: unknown) => typeof level === 'number' && Number.isInteger(level) && level >= MIN_NODE_LEVEL && level <= MAX_NODE_LEVEL
export const isValidBase = (base: BaseState) => BASE_NODES.every((node) => isValidLevel(base[node]))
export const normalizeBase = (base: Partial<BaseState> | undefined): BaseState => ({ workbench: isValidLevel(base?.workbench) ? base!.workbench! : 1, medbay: isValidLevel(base?.medbay) ? base!.medbay! : 1, stash: isValidLevel(base?.stash) ? base!.stash! : 1 })
/** Level transitions already paid for: an effect applies only once its node has reached that level. */
export const appliedUpgrades = (base: BaseState, upgrades: readonly BaseUpgradeDefinition[] = []) => upgrades.filter((entry) => entry.targetLevel <= base[entry.node])
export const capacityBonusOf = (upgrade: BaseUpgradeDefinition) => upgrade.effect.kind === 'stash-capacity' ? upgrade.effect.capacityBonus : 0
export const healBonusOf = (upgrade: BaseUpgradeDefinition) => upgrade.effect.kind === 'medbay-heal' ? upgrade.effect.healBonus : 0
export const recipeTierOf = (upgrade: BaseUpgradeDefinition) => upgrade.effect.kind === 'workbench-recipe-tier' ? upgrade.effect.recipeLevel : 0
/** Stash itself is unlimited; its upgrades grow the mission backpack budget in this slice. */
export const storageCapacity = (base: BaseState, upgrades: readonly BaseUpgradeDefinition[] = []) => BASE_BACKPACK_CAPACITY + appliedUpgrades(base, upgrades).reduce((sum, entry) => sum + capacityBonusOf(entry), 0)
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
/**
 * HP one bandage restores. Data-driven since W5-01: the L1 amount is the shipped constant and every
 * further level adds the `healBonus` of the catalog entry that unlocked it, so the number a player
 * is shown before buying medbay L2/L3 is the number `treatHero` then applies.
 */
export const healAmount = (base: BaseState, upgrades: readonly BaseUpgradeDefinition[] = []) =>
  MEDBAY_HEAL_PER_LEVEL + appliedUpgrades(base, upgrades).filter((entry) => entry.node === 'medbay').reduce((sum, entry) => sum + healBonusOf(entry), 0)
export const MEDBAY_ITEM = 'field-bandage'
export type HealFailure = 'not-wounded' | 'no-bandage'
export type HealResult = { ok: true; inventory: Inventory; health: number; healed: number } | { ok: false; reason: HealFailure }
/** Medbay changes only HP and consumes a stash bandage; it cannot repair equipment. */
export function treatHero(base: BaseState, inventory: Inventory, health: number, maxHealth: number, upgrades: readonly BaseUpgradeDefinition[] = []): HealResult { if (health >= maxHealth) return { ok: false, reason: 'not-wounded' }; const spent = removeItem(inventory, MEDBAY_ITEM, 1, 'stash'); if (!spent.ok) return { ok: false, reason: 'no-bandage' }; const healed = Math.min(maxHealth - health, healAmount(base, upgrades)); return { ok: true, inventory: spent.inventory, health: health + healed, healed } }
export type CraftFailure = 'unknown-recipe' | 'node-locked' | 'insufficient-resources'
export type CraftResult = { ok: true; inventory: Inventory; recipe: RecipeDefinition } | { ok: false; reason: CraftFailure }
/** Why a recipe cannot be crafted right now, or null when it can. Shared by `craft` and the base UI. */
export const craftBlocker = (base: BaseState, inventory: Inventory, recipe: RecipeDefinition): CraftFailure | null =>
  !isNodeUnlocked(base, recipe.node, recipe.nodeLevel) ? 'node-locked' : !hasResources(inventory, recipe.cost, 'stash') ? 'insufficient-resources' : null
/** One atomic stash transaction: preflight resources, spend, then add output to unlimited stash. */
export function craft(base: BaseState, inventory: Inventory, recipeId: string, recipes: readonly RecipeDefinition[], itemWeight: (itemId: string) => number): CraftResult { const recipe = recipes.find((entry) => entry.id === recipeId); if (!recipe) return { ok: false, reason: 'unknown-recipe' }; const blocked = craftBlocker(base, inventory, recipe); if (blocked) return { ok: false, reason: blocked }; const spent = spendResources(inventory, recipe.cost, 'stash'); if (!spent) return { ok: false, reason: 'insufficient-resources' }; return { ok: true, inventory: addItem(spent, recipe.output.itemId, recipe.output.quantity, itemWeight(recipe.output.itemId), 'stash').inventory, recipe } }
export type UpgradeFailure = 'unknown-upgrade' | 'wrong-level' | 'max-level' | 'insufficient-resources'
export type UpgradeResult = { ok: true; base: BaseState; inventory: Inventory; upgrade: BaseUpgradeDefinition } | { ok: false; reason: UpgradeFailure }
export function upgradeBlocker(base: BaseState, upgrade: BaseUpgradeDefinition): UpgradeFailure | null { if (base[upgrade.node] >= MAX_NODE_LEVEL) return 'max-level'; return upgrade.targetLevel !== base[upgrade.node] + 1 ? 'wrong-level' : null }
export const canUpgrade = (base: BaseState, inventory: Inventory, upgrade: BaseUpgradeDefinition) => upgradeBlocker(base, upgrade) === null && hasResources(inventory, upgrade.cost, 'stash')
export const missingResources = (inventory: Inventory, cost: ResourceCost): ResourceCost => Object.fromEntries((Object.entries(cost) as [ResourceId, number][]).map(([id, amount]) => [id, Math.max(0, amount - resourceQuantity(inventory, id, 'stash'))]).filter(([, amount]) => (amount as number) > 0))
export function applyUpgrade(base: BaseState, inventory: Inventory, upgradeId: string, catalog: readonly BaseUpgradeDefinition[]): UpgradeResult { const upgrade = catalog.find((entry) => entry.id === upgradeId); if (!upgrade) return { ok: false, reason: 'unknown-upgrade' }; const blocked = upgradeBlocker(base, upgrade); if (blocked) return { ok: false, reason: blocked }; const spent = spendResources(inventory, upgrade.cost, 'stash'); if (!spent) return { ok: false, reason: 'insufficient-resources' }; const nextBase = { ...base, [upgrade.node]: upgrade.targetLevel }; return { ok: true, base: nextBase, inventory: setBackpackCapacity(spent, storageCapacity(nextBase, catalog)), upgrade } }
/** The single catalog entry that takes `node` from its current level to the next one, if any. */
export const nextUpgradeFor = (base: BaseState, node: BaseNode, catalog: readonly BaseUpgradeDefinition[]) =>
  catalog.find((entry) => entry.node === node && entry.targetLevel === base[node] + 1) ?? null
