import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArenaContent } from './content'
import { parseEquipmentCatalog, applyEnemyArchetype } from './equipment-content'
import { calculateDamage, performCombatAttack } from './combat'
import { createMemoryStorage, createLocalStorageAdapter, defaultSave, validateSave } from './save'
import { repairGear } from './base'

const shipped = (name: string) => JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown

describe('shipped M3-A runtime content and persistence', () => {
 it('loads arena and equipment with their runtime parsers and exercises authoritative combat state', () => {
  const arena = parseArenaContent(shipped('arena'))
  const catalog = parseEquipmentCatalog(shipped('equipment'))
  const units = arena.units.map((unit) => applyEnemyArchetype({ ...unit, ap: unit.team === 'player' ? 10 : 0 }, catalog))
  const hero = units.find((unit) => unit.id === 'hero')!
  const enemy = units.find((unit) => unit.id === 'raider-2')!
  expect(hero.weaponState?.weaponId).toBe('hornet')
  expect(enemy.weaponState?.weaponId).toBe('akm')
   expect(catalog.ammo.some((ammo) => ammo.damageModifier !== 0)).toBe(true)
   expect(new Set(catalog.ammo.map((ammo) => `${ammo.damageModifier}:${ammo.penetrationModifier}`)).size).toBeGreaterThan(1)


  const armed = { ...hero, weaponState: { ...hero.weaponState!, ammoDamageModifier: 0.5, ammoPenetrationModifier: 0.5 } }
  const armored = { ...enemy, armor: { ...enemy.armor!, reduction: { torso: 8 }, durability: 100 } }
  expect(calculateDamage(armed, armored, 'torso', false)).toBe(26)
  const shot = performCombatAttack(armed, armored, 'torso', 'none', { malfunction: 100, hit: 1, crit: 100 })
  expect(shot).toMatchObject({ ok: true, resolution: { hit: true }, attacker: { weaponState: { magazine: 0, durability: 68 } } })

  const jam = performCombatAttack({ ...armed, weaponState: { ...armed.weaponState!, durability: 20 } }, enemy, 'torso', 'none', { malfunction: 1, hit: 1, crit: 1 })
  expect(jam).toMatchObject({ ok: true, malfunctioned: true, attacker: { ap: 6, weaponState: { magazine: 0, durability: 18, malfunctioned: true } } })
 })

  it('validates a complete shipped runtime save with player and enemy equipment', () => {
    const arena = parseArenaContent(shipped('arena'))
    const equipment = parseEquipmentCatalog(shipped('equipment'))
    const units = arena.units.map((unit) => applyEnemyArchetype({ ...unit, ap: unit.team === 'player' ? 10 : 0 }, equipment))
    const missions = [{ id: 'perimeter-checkpoint', zoneId: 'near-perimeter', order: 1, rewardId: 'perimeter-checkpoint-clear', arenaId: 'perimeter-checkpoint' }]
    const catalog = { campaignCatalog: {
      catalogId: 'shipped-catalog',
      missions,
      missionIds: new Set(missions.map((mission) => mission.id)),
      rewardIds: new Set(missions.map((mission) => mission.rewardId)),
      arenaIds: new Set(missions.map((mission) => mission.arenaId)),
      zoneIds: new Set(['near-perimeter']),
      weaponIds: new Set(equipment.weapons.map((weapon) => weapon.id)),
      weaponForId: (id: string) => equipment.weapons.find((weapon) => weapon.id === id),
      armorIds: new Set(equipment.armor.map((armor) => armor.id)),
      armorSlotForId: (id: string) => equipment.armor.find((armor) => armor.id === id)?.slot,
      armorForId: (id: string) => equipment.armor.find((armor) => armor.id === id),
      ammoIds: new Set(equipment.ammo.map((ammo) => ammo.id)),
      rewardIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.rewardId,
      arenaIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.arenaId,
    } }
    const save = defaultSave('perimeter-checkpoint', units, catalog.campaignCatalog, missions)
    expect(validateSave(save, catalog).ok).toBe(true)
  })

  it('repairs the equipped shipped weapon and retains the result after save reload', () => {
    const arena = parseArenaContent(shipped('arena'))
    const catalog = parseEquipmentCatalog(shipped('equipment'))
    const units = arena.units.map((unit) => applyEnemyArchetype({ ...unit, ap: unit.team === 'player' ? 10 : 0 }, catalog))
    const missions = [{ id: arena.id, zoneId: 'default', order: 1, rewardId: `${arena.id}-clear`, arenaId: arena.id }]
    const base = defaultSave(arena.id, units, undefined, missions)
    const damagedInventory = { ...base.inventory, stash: { ...base.inventory.stash, resources: [{ id: 'metal' as const, quantity: 10, weight: 1 }] }, equipment: base.inventory.equipment.map((entry) => entry.instanceId === 'hero-hornet' ? { ...entry, durability: 68 } : entry) }
    const repaired = repairGear(damagedInventory, 'hero-hornet')
    expect(repaired).toMatchObject({ ok: true, equipment: { instanceId: 'hero-hornet', durability: 100 } })
    if (!repaired.ok) return
    const repairedUnits = base.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: { ...unit.weaponState!, durability: repaired.equipment.durability } } : unit)
    const save = { ...base, units: repairedUnits, inventory: repaired.inventory }
    const adapter = createLocalStorageAdapter(createMemoryStorage(), { campaignMissions: missions })
    expect(adapter.save(save)).toBe(true)
    const reloaded = adapter.load()
    if (!reloaded?.ok) throw new Error('expected reloaded save')
    expect(reloaded.value.inventory.equipment.find((entry) => entry.instanceId === 'hero-hornet')).toMatchObject({ durability: 100 })
    expect(reloaded.value.units.find((unit) => unit.id === 'hero')?.weaponState).toMatchObject({ weaponInstanceId: 'hero-hornet', durability: 100 })
  })
})
