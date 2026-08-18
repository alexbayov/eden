/** Pure inventory rules for M2: weight-limited mission backpack, unlimited base stash, persistent equipment instances and four quick slots. No DOM/Phaser dependency. */
export type ResourceId = 'metal' | 'mechanics' | 'cloth' | 'chemistry' | 'powder' | 'shells' | 'electronics' | 'eden-component'
export type ResourceCost = Partial<Record<ResourceId, number>>
export type PoolId = 'backpack' | 'stash'
export type EquipmentSlot = 'head' | 'torso' | 'primary' | 'secondary'

export const RESOURCE_IDS: ResourceId[] = ['metal', 'mechanics', 'cloth', 'chemistry', 'powder', 'shells', 'electronics', 'eden-component']
export const RESOURCE_LABELS: Record<ResourceId, string> = { metal: 'Металл', mechanics: 'Механика', cloth: 'Ткань', chemistry: 'Химия', powder: 'Порох', shells: 'Гильзы', electronics: 'Электрика', 'eden-component': 'Компонент Эдема' }
export const EQUIPMENT_SLOTS: EquipmentSlot[] = ['head', 'torso', 'primary', 'secondary']
export const EQUIPMENT_SLOT_LABELS: Record<EquipmentSlot, string> = { head: 'Голова', torso: 'Торс', primary: 'Основное оружие', secondary: 'Доп. оружие' }
export const QUICK_SLOT_COUNT = 4
export const isResourceId = (value: unknown): value is ResourceId => typeof value === 'string' && (RESOURCE_IDS as string[]).includes(value)
export const isEquipmentSlot = (value: unknown): value is EquipmentSlot => typeof value === 'string' && (EQUIPMENT_SLOTS as string[]).includes(value)

export interface Stack { id: string; quantity: number; weight: number }
export interface ResourceStack extends Stack { id: ResourceId }
export interface Container { resources: ResourceStack[]; items: Stack[] }
/** Equipment lives outside the backpack weight budget (docs/07 §7.2) and carries its own durability, never the hero HP. */
export interface EquipmentInstance {
  instanceId: string
  itemId: string
  slot: EquipmentSlot
  durability: number
  maxDurability: number
  magazine?: number
  magazineSize?: number
  reserveAmmo?: number
  malfunctioned?: boolean
  ammoId?: string
  name?: string
  baseDamage?: number
  accuracyModifier?: number
  critModifier?: number
  penetration?: number
  ammoDamageModifier?: number
  ammoPenetrationModifier?: number
  damageModifier?: number
  penetrationModifier?: number
  durabilityPerShot?: number
  reloadAp?: number
  makeshift?: boolean
}
export type QuickSlots = (string | null)[]
/** `backpack` is weight-limited and travels into the mission; `stash` is the unlimited base storage (docs/07 §7.5.1). */
export interface Inventory { backpackCapacity: number; backpack: Container; stash: Container; equipment: EquipmentInstance[]; quickSlots: QuickSlots }

export const emptyQuickSlots = (): QuickSlots => Array.from({ length: QUICK_SLOT_COUNT }, () => null)
export const emptyContainer = (): Container => ({ resources: [], items: [] })
export const createInventory = (backpackCapacity: number, equipment: EquipmentInstance[] = []): Inventory => ({ backpackCapacity: Math.max(0, backpackCapacity), backpack: emptyContainer(), stash: emptyContainer(), equipment: equipment.map((entry) => ({ ...entry })), quickSlots: emptyQuickSlots() })

export const stackWeight = (stack: Stack) => stack.quantity * stack.weight
export const containerWeight = (container: Container) => [...container.resources, ...container.items].reduce((sum, stack) => sum + stackWeight(stack), 0)
export const backpackWeight = (inventory: Inventory) => containerWeight(inventory.backpack)
export const totalWeight = backpackWeight
export const stashWeight = (inventory: Inventory) => containerWeight(inventory.stash)
export const freeCapacity = (inventory: Inventory) => Math.max(0, inventory.backpackCapacity - backpackWeight(inventory))
export const resourceQuantity = (inventory: Inventory, id: ResourceId, pool: PoolId = 'stash') => inventory[pool].resources.find((stack) => stack.id === id)?.quantity ?? 0
export const itemQuantity = (inventory: Inventory, id: string, pool: PoolId = 'stash') => inventory[pool].items.find((stack) => stack.id === id)?.quantity ?? 0
export const cloneContainer = (container: Container): Container => ({ resources: container.resources.map((stack) => ({ ...stack })), items: container.items.map((stack) => ({ ...stack })) })
export const cloneInventory = (inventory: Inventory): Inventory => ({ backpackCapacity: inventory.backpackCapacity, backpack: cloneContainer(inventory.backpack), stash: cloneContainer(inventory.stash), equipment: inventory.equipment.map((entry) => ({ ...entry })), quickSlots: [...inventory.quickSlots] })

/** Only the backpack is weight-checked: weightless entries always fit, otherwise whole units inside the remaining budget. */
export const fittingQuantity = (inventory: Inventory, weight: number, quantity: number) => weight <= 0 ? Math.max(0, quantity) : Math.max(0, Math.min(quantity, Math.floor(freeCapacity(inventory) / weight)))

export interface AddResult { inventory: Inventory; stored: number; overflow: number }
export type RemoveFailure = 'invalid-quantity' | 'missing'
export type RemoveResult = { ok: true; inventory: Inventory } | { ok: false; reason: RemoveFailure; inventory: Inventory }
export type TransferFailure = RemoveFailure | 'no-capacity'
export type TransferResult = { ok: true; inventory: Inventory; moved: number } | { ok: false; reason: TransferFailure; inventory: Inventory }
export type QuickSlotFailure = 'index' | 'missing-item'
export type QuickSlotResult = { ok: true; inventory: Inventory } | { ok: false; reason: QuickSlotFailure; inventory: Inventory }
export type EquipmentFailure = 'unknown-instance' | 'not-damaged'

const isValidQuantity = (quantity: number) => Number.isInteger(quantity) && quantity >= 0
/** One stack per id inside a pool: merge on add, partial fill instead of silent loss. */
function addStack(stacks: Stack[], id: string, quantity: number, weight: number): Stack[] {
  const merged = stacks.map((stack) => stack.id === id ? { ...stack, quantity: stack.quantity + quantity } : { ...stack })
  return merged.some((stack) => stack.id === id) ? merged : [...merged, { id, quantity, weight }]
}
const removeStack = (stacks: Stack[], id: string, quantity: number): Stack[] => stacks.map((stack) => stack.id === id ? { ...stack, quantity: stack.quantity - quantity } : { ...stack }).filter((stack) => stack.quantity > 0)
const withPool = (inventory: Inventory, pool: PoolId, container: Container): Inventory => ({ ...inventory, [pool]: container }) as Inventory
const stackWeightOf = (inventory: Inventory, pool: PoolId, kind: 'resources' | 'items', id: string) => inventory[pool][kind].find((stack) => stack.id === id)?.weight ?? 0

export function addResource(inventory: Inventory, id: ResourceId, quantity: number, weight: number, pool: PoolId = 'stash'): AddResult {
  if (!isValidQuantity(quantity) || weight < 0) return { inventory, stored: 0, overflow: Math.max(0, quantity) }
  const stored = pool === 'stash' ? quantity : fittingQuantity(inventory, weight, quantity)
  if (stored === 0) return { inventory, stored: 0, overflow: quantity }
  const container: Container = { ...inventory[pool], resources: addStack(inventory[pool].resources, id, stored, weight) as ResourceStack[] }
  return { inventory: withPool(inventory, pool, container), stored, overflow: quantity - stored }
}
export function addItem(inventory: Inventory, id: string, quantity: number, weight: number, pool: PoolId = 'stash'): AddResult {
  if (!isValidQuantity(quantity) || weight < 0) return { inventory, stored: 0, overflow: Math.max(0, quantity) }
  const stored = pool === 'stash' ? quantity : fittingQuantity(inventory, weight, quantity)
  if (stored === 0) return { inventory, stored: 0, overflow: quantity }
  const container: Container = { ...inventory[pool], items: addStack(inventory[pool].items, id, stored, weight) }
  return { inventory: withPool(inventory, pool, container), stored, overflow: quantity - stored }
}
export function removeResource(inventory: Inventory, id: ResourceId, quantity: number, pool: PoolId = 'stash'): RemoveResult {
  if (!isValidQuantity(quantity)) return { ok: false, reason: 'invalid-quantity', inventory }
  if (resourceQuantity(inventory, id, pool) < quantity) return { ok: false, reason: 'missing', inventory }
  return { ok: true, inventory: withPool(inventory, pool, { ...inventory[pool], resources: removeStack(inventory[pool].resources, id, quantity) as ResourceStack[] }) }
}
export function removeItem(inventory: Inventory, id: string, quantity: number, pool: PoolId = 'stash'): RemoveResult {
  if (!isValidQuantity(quantity)) return { ok: false, reason: 'invalid-quantity', inventory }
  if (itemQuantity(inventory, id, pool) < quantity) return { ok: false, reason: 'missing', inventory }
  const next = withPool(inventory, pool, { ...inventory[pool], items: removeStack(inventory[pool].items, id, quantity) })
  return { ok: true, inventory: pool === 'backpack' ? pruneQuickSlots(next) : next }
}

/** Backpack ↔ stash transfer is atomic: either the whole requested amount moves or the inventory is untouched. */
export function transferResource(inventory: Inventory, id: ResourceId, quantity: number, from: PoolId): TransferResult {
  const to: PoolId = from === 'backpack' ? 'stash' : 'backpack'
  const weight = stackWeightOf(inventory, from, 'resources', id)
  if (to === 'backpack' && fittingQuantity(inventory, weight, quantity) < quantity) return { ok: false, reason: 'no-capacity', inventory }
  const removed = removeResource(inventory, id, quantity, from)
  if (!removed.ok) return { ok: false, reason: removed.reason, inventory }
  const added = addResource(removed.inventory, id, quantity, weight, to)
  return added.stored === quantity ? { ok: true, inventory: added.inventory, moved: quantity } : { ok: false, reason: 'no-capacity', inventory }
}
export function transferItem(inventory: Inventory, id: string, quantity: number, from: PoolId): TransferResult {
  const to: PoolId = from === 'backpack' ? 'stash' : 'backpack'
  const weight = stackWeightOf(inventory, from, 'items', id)
  if (to === 'backpack' && fittingQuantity(inventory, weight, quantity) < quantity) return { ok: false, reason: 'no-capacity', inventory }
  const removed = removeItem(inventory, id, quantity, from)
  if (!removed.ok) return { ok: false, reason: removed.reason, inventory }
  const added = addItem(removed.inventory, id, quantity, weight, to)
  return added.stored === quantity ? { ok: true, inventory: added.inventory, moved: quantity } : { ok: false, reason: 'no-capacity', inventory }
}
/** Post-mission deposit: everything carried moves into the unlimited stash, so the next run starts from a clean backpack. */
export function depositBackpack(inventory: Inventory): Inventory {
  let next = inventory
  for (const stack of inventory.backpack.resources) { const moved = transferResource(next, stack.id, stack.quantity, 'backpack'); if (moved.ok) next = moved.inventory }
  for (const stack of inventory.backpack.items) { const moved = transferItem(next, stack.id, stack.quantity, 'backpack'); if (moved.ok) next = moved.inventory }
  return pruneQuickSlots(next)
}

export const hasResources = (inventory: Inventory, cost: ResourceCost, pool: PoolId = 'stash') => (Object.entries(cost) as [ResourceId, number][]).every(([id, amount]) => resourceQuantity(inventory, id, pool) >= amount)
/** All-or-nothing spend so a partially paid base action can never happen. */
export function spendResources(inventory: Inventory, cost: ResourceCost, pool: PoolId = 'stash'): Inventory | null {
  if (!hasResources(inventory, cost, pool)) return null
  let next = inventory
  for (const [id, amount] of Object.entries(cost) as [ResourceId, number][]) {
    const result = removeResource(next, id, amount, pool)
    if (!result.ok) return null
    next = result.inventory
  }
  return next
}
export const missingResources = (inventory: Inventory, cost: ResourceCost, pool: PoolId = 'stash'): ResourceCost =>
  Object.fromEntries((Object.entries(cost) as [ResourceId, number][]).map(([id, amount]) => [id, Math.max(0, amount - resourceQuantity(inventory, id, pool))]).filter(([, missing]) => (missing as number) > 0))

export const setBackpackCapacity = (inventory: Inventory, capacity: number): Inventory => ({ ...inventory, backpackCapacity: Math.max(0, capacity) })
/** A quick slot may only hold an item carried in the backpack and the same item cannot occupy two slots. */
export function assignQuickSlot(inventory: Inventory, index: number, itemId: string | null): QuickSlotResult {
  if (!Number.isInteger(index) || index < 0 || index >= QUICK_SLOT_COUNT) return { ok: false, reason: 'index', inventory }
  if (itemId !== null && itemQuantity(inventory, itemId, 'backpack') === 0) return { ok: false, reason: 'missing-item', inventory }
  return { ok: true, inventory: { ...inventory, quickSlots: inventory.quickSlots.map((slot, slotIndex) => slotIndex === index ? itemId : slot === itemId ? null : slot) } }
}
export const pruneQuickSlots = (inventory: Inventory): Inventory => ({ ...inventory, quickSlots: inventory.quickSlots.map((slot) => slot && itemQuantity(inventory, slot, 'backpack') > 0 ? slot : null) })

export const equipmentInstance = (inventory: Inventory, instanceId: string) => inventory.equipment.find((entry) => entry.instanceId === instanceId) ?? null
export const equipmentBySlot = (inventory: Inventory, slot: EquipmentSlot) => inventory.equipment.find((entry) => entry.slot === slot) ?? null
export const equipmentDurabilityPercent = (entry: EquipmentInstance) => entry.maxDurability > 0 ? Math.round(entry.durability / entry.maxDurability * 100) : 0
export const mostDamagedEquipment = (inventory: Inventory) => inventory.equipment.filter((entry) => entry.durability < entry.maxDurability).sort((a, b) => equipmentDurabilityPercent(a) - equipmentDurabilityPercent(b))[0] ?? null
/** Combat wear only touches durability; hero HP is stored on the unit and is never derived from gear. */
export function damageEquipment(inventory: Inventory, instanceId: string, amount: number): Inventory {
  if (!Number.isFinite(amount) || amount <= 0) return inventory
  return { ...inventory, equipment: inventory.equipment.map((entry) => entry.instanceId === instanceId ? { ...entry, durability: Math.max(0, entry.durability - Math.floor(amount)) } : entry) }
}
export function setEquipmentDurability(inventory: Inventory, instanceId: string, durability: number): Inventory {
  return { ...inventory, equipment: inventory.equipment.map((entry) => entry.instanceId === instanceId ? { ...entry, durability: Math.max(0, Math.min(entry.maxDurability, Math.floor(durability))) } : entry) }
}
