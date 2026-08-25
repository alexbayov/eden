import type { Inventory } from './inventory'
import type { ArmorState, BodyPart, Unit, WeaponState } from './combat'
import { checkEnvelope, fetchContent, isInt, isNonEmptyString, isRecord, type ContentIssue, type ContentResult, ContentValidationError } from './content-format'
export type WeaponRole = 'pistol' | 'rifle' | 'shotgun' | 'makeshift'; export type ArmorSlot = 'head' | 'torso' | 'arms' | 'legs'; export type AiBehavior = 'shooter' | 'rusher' | 'defender'
export interface WeaponDefinition { id: string; name: string; role: WeaponRole; ammoId: string; baseDamage: number; accuracyModifier: number; critModifier: number; penetration: number; magazineSize: number; reloadAp: number; durabilityPerShot: number; makeshift: boolean }
export interface AmmoDefinition { id: string; name: string; damageModifier: number; penetrationModifier: number }
export interface ArmorDefinition { id: string; name: string; slot: ArmorSlot; reduction: Partial<Record<BodyPart, number>>; maxDurability?: number }
export interface EnemyArchetype { id: string; name: string; behavior: AiBehavior; intent: string; weaponId: string; armorIds: string[] }
export interface EquipmentCatalog { weapons: WeaponDefinition[]; ammo: AmmoDefinition[]; armor: ArmorDefinition[]; enemies: EnemyArchetype[] }
const roles = new Set<WeaponRole>(['pistol', 'rifle', 'shotgun', 'makeshift']), slots = new Set<ArmorSlot>(['head', 'torso', 'arms', 'legs']), behaviors = new Set<AiBehavior>(['shooter', 'rusher', 'defender']), parts = new Set<BodyPart>(['head', 'torso', 'arm', 'leg', 'eye', 'groin']); const finite = (v: unknown, p: string, issues: ContentIssue[], min = 0, max = Number.MAX_SAFE_INTEGER) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) issues.push({ path: p, message: `конечное число ${min}..${max}` }) }
function validate(input: unknown): ContentResult<EquipmentCatalog> { const envelope = checkEnvelope(input); if (!envelope.ok) return envelope; const v = envelope.value, issues: ContentIssue[] = []; const entries = (k: keyof EquipmentCatalog) => Array.isArray(v[k]) && v[k].length ? v[k] as unknown[] : (issues.push({ path: `$.${k}`, message: 'непустой массив' }), []); const weapons = entries('weapons').flatMap((e, i) => { const p = `$.weapons[${i}]`; if (!isRecord(e)) { issues.push({ path: p, message: 'объект' }); return [] }; for (const k of ['id', 'name', 'ammoId'] as const) if (!isNonEmptyString(e[k])) issues.push({ path: `${p}.${k}`, message: 'непустая строка' }); if (!roles.has(e.role as WeaponRole)) issues.push({ path: `${p}.role`, message: 'роль оружия' }); for (const k of ['baseDamage', 'accuracyModifier', 'critModifier'] as const) finite(e[k], `${p}.${k}`, issues, -100, 1000); finite(e.penetration, `${p}.penetration`, issues, 0, 1); for (const k of ['magazineSize', 'reloadAp', 'durabilityPerShot'] as const) finite(e[k], `${p}.${k}`, issues, 1, 100); if (!isInt(e.magazineSize) || !isInt(e.reloadAp) || !isInt(e.durabilityPerShot)) issues.push({ path: p, message: 'weapon integer fields' }); if (typeof e.makeshift !== 'boolean') issues.push({ path: `${p}.makeshift`, message: 'boolean' }); return isNonEmptyString(e.id) ? [e as unknown as WeaponDefinition] : [] }); const ammo = entries('ammo').flatMap((e, i) => { const p = `$.ammo[${i}]`; if (!isRecord(e)) { issues.push({ path: p, message: 'объект' }); return [] }; for (const k of ['id', 'name'] as const) if (!isNonEmptyString(e[k])) issues.push({ path: `${p}.${k}`, message: 'непустая строка' }); finite(e.damageModifier, `${p}.damageModifier`, issues, -1, 10); finite(e.penetrationModifier, `${p}.penetrationModifier`, issues, -1, 1); return isNonEmptyString(e.id) ? [e as unknown as AmmoDefinition] : [] }); const armor = entries('armor').flatMap((e, i) => { const p = `$.armor[${i}]`; if (!isRecord(e)) { issues.push({ path: p, message: 'объект' }); return [] }; if (!isNonEmptyString(e.id) || !isNonEmptyString(e.name)) issues.push({ path: p, message: 'id/name' }); if (!slots.has(e.slot as ArmorSlot)) issues.push({ path: `${p}.slot`, message: 'armor slot' }); if (!isRecord(e.reduction)) issues.push({ path: `${p}.reduction`, message: 'объект частей тела' }); else Object.entries(e.reduction).forEach(([part, amount]) => { if (!parts.has(part as BodyPart)) issues.push({ path: `${p}.reduction.${part}`, message: 'известная часть' }); else finite(amount, `${p}.reduction.${part}`, issues, 0, 1000) }); return isNonEmptyString(e.id) ? [e as unknown as ArmorDefinition] : [] }); const enemies = entries('enemies').flatMap((e, i) => { const p = `$.enemies[${i}]`; if (!isRecord(e)) { issues.push({ path: p, message: 'объект' }); return [] }; for (const k of ['id', 'name', 'intent', 'weaponId'] as const) if (!isNonEmptyString(e[k])) issues.push({ path: `${p}.${k}`, message: 'непустая строка' }); if (!behaviors.has(e.behavior as AiBehavior)) issues.push({ path: `${p}.behavior`, message: 'AI behavior' }); if (!Array.isArray(e.armorIds) || e.armorIds.some((id) => !isNonEmptyString(id))) issues.push({ path: `${p}.armorIds`, message: 'массив id' }); return isNonEmptyString(e.id) ? [e as unknown as EnemyArchetype] : [] }); for (const [name, list] of Object.entries({ weapons, ammo, armor, enemies })) list.forEach((x, i) => { if (list.findIndex((y) => y.id === x.id) !== i) issues.push({ path: `$.${name}[${i}].id`, message: 'дублирующийся id' }) }); for (const w of weapons) if (!ammo.some((a) => a.id === w.ammoId)) issues.push({ path: `$.weapons[${w.id}].ammoId`, message: 'ссылка на ammo' }); for (const e of enemies) { if (!weapons.some((w) => w.id === e.weaponId)) issues.push({ path: `$.enemies[${e.id}].weaponId`, message: 'ссылка на weapon' }); if (e.armorIds.some((id) => !armor.some((a) => a.id === id))) issues.push({ path: `$.enemies[${e.id}].armorIds`, message: 'ссылки на armor' }) }; return issues.length ? { ok: false, error: new ContentValidationError('shape', issues) } : { ok: true, value: { weapons, ammo, armor, enemies } } }
export const validateEquipmentCatalog = validate; export function parseEquipmentCatalog(input: unknown) { const r = validate(input); if (!r.ok) throw r.error; return r.value }; export const loadEquipmentCatalog = (url = '/config/equipment.json') => fetchContent(url).then(parseEquipmentCatalog); export const weaponById = (c: EquipmentCatalog, id: string) => c.weapons.find((x) => x.id === id) ?? null; export const enemyById = (c: EquipmentCatalog, id: string) => c.enemies.find((x) => x.id === id) ?? null
export const createWeaponState = (w: WeaponDefinition, instanceId: string, ammo?: AmmoDefinition): WeaponState => ({ weaponInstanceId: instanceId, weaponId: w.id, name: w.name, ammoId: w.ammoId, baseDamage: w.baseDamage, accuracyModifier: w.accuracyModifier, critModifier: w.critModifier, penetration: w.penetration, ammoDamageModifier: ammo?.damageModifier ?? 0, ammoPenetrationModifier: ammo?.penetrationModifier ?? 0, magazine: w.magazineSize, magazineSize: w.magazineSize, reserveAmmo: w.magazineSize * 2, durability: 100, maxDurability: 100, durabilityPerShot: w.durabilityPerShot, reloadAp: w.reloadAp, makeshift: w.makeshift })
export const armorFor = (c: EquipmentCatalog, ids: string[], instanceId?: string): ArmorState => { const definitions = ids.map((id) => c.armor.find((armor) => armor.id === id)).filter((armor): armor is ArmorDefinition => Boolean(armor)); const maxDurability = definitions.length === ids.length && definitions.every((armor) => armor.maxDurability !== undefined) ? definitions.reduce((sum, armor) => sum + armor.maxDurability!, 0) : 100; return { armorInstanceId: instanceId ?? ids.join('+'), armorId: ids.join('+'), durability: maxDurability, maxDurability, reduction: definitions.reduce<Partial<Record<BodyPart, number>>>((all, a) => { for (const [p, value] of Object.entries(a.reduction) as [BodyPart, number][]) all[p] = (all[p] ?? 0) + value; return all }, {}) } }
export const applyEnemyArchetype = (u: Unit, c: EquipmentCatalog): Unit => { const a = u.archetypeId ? enemyById(c, u.archetypeId) : null; const w = a && weaponById(c, a.weaponId); return a && w ? { ...u, behavior: a.behavior, intent: a.intent, weaponState: createWeaponState(w, `${u.id}-${w.id}`, c.ammo.find((x) => x.id === w.ammoId)), armor: armorFor(c, a.armorIds, `${u.id}-armor`) } : u }

const equipmentInstanceFor = (inventory: Inventory, instanceId: string | undefined, itemId: string | undefined, slots: readonly string[]) => inventory.equipment.find((entry) => (instanceId && entry.instanceId === instanceId) || (itemId && entry.itemId === itemId && slots.includes(entry.slot)))

/**
 * W5-04 — drops every unit reference to equipment instances that no longer exist in the inventory.
 *
 * Needed because `syncEquipmentInstances` only copies state in one direction: from the unit onto a
 * *matching* instance. It has no opinion about a unit pointing at an instance that has been
 * destroyed, so after a dismantle the hero would still carry a `weaponState`/`armor` whose
 * `instanceId` resolves to nothing — and the save validator rejects exactly that
 * (`$.units[n].armor.armorInstanceId — ссылка на inventory equipment instance`). Without this the
 * dismantle would either be refused by the save layer or, worse, persist a save that the *next*
 * boot cannot load.
 *
 * It is a separate function from `syncEquipmentInstances` rather than a branch inside it because the
 * two run at different moments and must not be confused: sync runs on **every** persist and would
 * silently strip gear during any intermediate state, while unlinking is the deliberate consequence
 * of one destructive action.
 *
 * Only the player's units are touched: enemy gear is generated from archetypes and has no inventory
 * instance to lose.
 */
export function unlinkDestroyedEquipment(inventory: Inventory, units: readonly Unit[]): Unit[] {
  const live = new Set(inventory.equipment.map((entry) => entry.instanceId))
  return units.map((unit) => {
    if (unit.team !== 'player') return unit
    const dropWeapon = unit.weaponState !== undefined && !live.has(unit.weaponState.weaponInstanceId)
    const dropArmor = unit.armor?.armorInstanceId !== undefined && !live.has(unit.armor.armorInstanceId)
    if (!dropWeapon && !dropArmor) return unit
    const next = { ...unit }
    if (dropWeapon) delete next.weaponState
    if (dropArmor) delete next.armor
    return next
  })
}

export function syncEquipmentInstances(inventory: Inventory, units: readonly Unit[]): Inventory {
  const weapons = new Map<string, WeaponState>()
  const armor = new Map<string, ArmorState>()
  for (const unit of units) {
    if (unit.team !== 'player') continue
    if (unit.weaponState) weapons.set(unit.weaponState.weaponInstanceId, unit.weaponState)
    if (unit.armor?.armorInstanceId) armor.set(unit.armor.armorInstanceId, unit.armor)
  }
  return {
    ...inventory,
    equipment: inventory.equipment.map((entry) => {
      const weapon = weapons.get(entry.instanceId)
      if (weapon) return {
        ...entry,
        instanceId: weapon.weaponInstanceId,
        itemId: weapon.weaponId,
        ammoId: weapon.ammoId,
        name: weapon.name,
        baseDamage: weapon.baseDamage,
        accuracyModifier: weapon.accuracyModifier,
        critModifier: weapon.critModifier,
        penetration: weapon.penetration,
        damageModifier: weapon.damageModifier,
        penetrationModifier: weapon.penetrationModifier,
        ammoDamageModifier: weapon.ammoDamageModifier,
        ammoPenetrationModifier: weapon.ammoPenetrationModifier,
        magazine: weapon.magazine,
        magazineSize: weapon.magazineSize,
        reserveAmmo: weapon.reserveAmmo,
        durability: weapon.durability,
        maxDurability: weapon.maxDurability,
        durabilityPerShot: weapon.durabilityPerShot,
        reloadAp: weapon.reloadAp,
        makeshift: weapon.makeshift,
        malfunctioned: weapon.malfunctioned,
      }
      const wornArmor = armor.get(entry.instanceId)
      return wornArmor ? { ...entry, durability: wornArmor.durability, maxDurability: wornArmor.maxDurability } : entry
    }),
  }
}
export function hydrateArenaUnits(arena: { units: Array<Omit<Unit, 'ap'> | Unit> }, equipment: EquipmentCatalog, inventory: Inventory, previousUnits: readonly Unit[] = []): Unit[] {
  return arena.units.map((rawTemplate) => {
    const template: Unit = { ...rawTemplate, ap: 'ap' in rawTemplate && typeof rawTemplate.ap === 'number' ? rawTemplate.ap : 0 }
    const previous = previousUnits.find((unit) => unit.id === template.id)
    if (template.team === 'enemy') return applyEnemyArchetype({ ...template }, equipment)
    let unit = { ...template, statuses: { ...(template.statuses ?? {}) } }
    if (previous && previous.hp > 0) {
      // Encounter templates own positions/equipment; the surviving hero owns HP and statuses.
      unit = { ...unit, hp: Math.min(unit.maxHp, previous.hp), statuses: { ...(previous.statuses ?? {}) } }
    }
    if (template.weaponState) {
      const definition = weaponById(equipment, template.weaponState.weaponId)
      const ammo = definition && equipment.ammo.find((entry) => entry.id === definition.ammoId) || undefined
      const instance = equipmentInstanceFor(inventory, template.weaponState.weaponInstanceId, template.weaponState.weaponId, ['primary', 'secondary'])
      if (definition) {
        const created = createWeaponState(definition, instance?.instanceId ?? template.weaponState.weaponInstanceId, ammo)
        const live = previous?.weaponState ?? template.weaponState
        unit = { ...unit, weaponState: { ...created, magazine: instance?.magazine ?? live.magazine, reserveAmmo: instance?.reserveAmmo ?? live.reserveAmmo, malfunctioned: instance?.malfunctioned ?? live.malfunctioned, durability: instance?.durability ?? live.durability, maxDurability: instance?.maxDurability ?? live.maxDurability } }
      }
    }
    if (template.armor) {
      const ids = typeof template.armor?.armorId === 'string' ? template.armor.armorId.split('+') : []
      const instance = equipmentInstanceFor(inventory, template.armor.armorInstanceId, template.armor.armorId, ['head', 'torso'])
      const live = previous?.armor ?? template.armor
      unit = { ...unit, armor: armorFor(equipment, ids, instance?.instanceId ?? template.armor.armorInstanceId) }
      unit.armor = { ...unit.armor!, durability: instance?.durability ?? live.durability, maxDurability: instance?.maxDurability ?? live.maxDurability }
    }
    return unit
  })
}
