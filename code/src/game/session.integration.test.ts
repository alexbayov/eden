import { describe, expect, it } from 'vitest'
import { createEnemyPhaseCoordinator, persistTransition, resumePersistedEnemyPhase } from './session'
import { createLocalStorageAdapter, createMemoryStorage, defaultSave, type SaveAdapter, type SaveData } from './save'
import { createWeaponState, type EquipmentCatalog } from './equipment-content'
import type { ArenaConfig } from './content'
import type { Unit } from './combat'
import { startMission } from './campaign'

const hero = (overrides: Partial<Unit> = {}): Unit => ({ id: 'hero', name: 'Hero', team: 'player', x: 0, y: 0, hp: 24, maxHp: 24, aim: 55, color: '#fff', ap: 10, statuses: {}, ...overrides })
const enemy = (): Unit => ({ id: 'enemy', name: 'Enemy', team: 'enemy', x: 3, y: 0, hp: 15, maxHp: 15, aim: 55, color: '#f00', ap: 0, statuses: {} })
const arena: ArenaConfig = { contentVersion: 1, id: 'arena', name: 'Arena', width: 5, height: 2, tile: { width: 1, height: 1 }, units: [hero(), enemy()], cover: [] }
const missions = [{ id: 'encounter', zoneId: 'zone', order: 1, rewardId: 'reward', arenaId: arena.id }]
const activeSave = (): SaveData => { const base = defaultSave(arena.id, [hero(), enemy()], undefined, missions); return { ...base, campaign: startMission(base.campaign, undefined, missions) } }
const reactionArena: ArenaConfig = { ...arena, cover: [{ x: 2, y: 1, type: 'full' }] }

const reactionWeapon = { id: 'hornet', name: 'Hornet', role: 'makeshift' as const, ammoId: 'ammo', baseDamage: 20, accuracyModifier: -15, critModifier: 0, penetration: 0, magazineSize: 1, reloadAp: 2, durabilityPerShot: 2, makeshift: true }
const reactionEquipment: EquipmentCatalog = { weapons: [reactionWeapon], ammo: [{ id: 'ammo', name: 'Ammo', damageModifier: 0, penetrationModifier: 0 }], armor: [], enemies: [] }
const reactionCatalog = {
 catalogId: 'reaction-catalog',
 missions,
 missionIds: new Set(missions.map((mission) => mission.id)),
 rewardIds: new Set(missions.map((mission) => mission.rewardId)),
 arenaIds: new Set(missions.map((mission) => mission.arenaId)),
 zoneIds: new Set(['zone']),
 weaponIds: new Set(['hornet']),
 weaponForId: (id: string) => reactionEquipment.weapons.find((weapon) => weapon.id === id),
 armorIds: new Set<string>(),
 armorSlotForId: () => undefined,
 armorForId: () => undefined,
 ammoIds: new Set(['ammo']),
 ammoForId: () => ({ damageModifier: 0, penetrationModifier: 0 }),
 rewardIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.rewardId,
 arenaIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.arenaId,
}

describe('enemy phase persistence coordinator', () => {
 it('persists the exact enemy snapshot before scheduling and resumes it only once after boot', () => {
  const adapter = createLocalStorageAdapter(createMemoryStorage(), { campaignMissions: missions })
  const scheduled: (() => void)[] = []
  const resolved: SaveData[] = []
  const coordinator = createEnemyPhaseCoordinator(activeSave(), adapter, (callback) => scheduled.push(callback), arena, (save) => resolved.push(save))
  expect(coordinator.begin()).toBe(true)
  expect(coordinator.begin()).toBe(false)
  const persisted = adapter.load()
  expect(persisted).toMatchObject({ ok: true, value: { phase: 'enemy', turn: 1, units: [{ id: 'hero' }, { id: 'enemy' }] } })
  expect(scheduled).toHaveLength(1)
  const boot = adapter.load()
  expect(boot?.ok && boot.value.phase).toBe('enemy')
  if (!boot?.ok) throw new Error('expected enemy save')
  const resumed = resumePersistedEnemyPhase(adapter, boot.value, arena)
  expect(resumed).toMatchObject({ phase: 'player', turn: 2 })
  expect(resumePersistedEnemyPhase(adapter, resumed!, arena)).toBe(resumed)
  expect(adapter.load()).toMatchObject({ ok: true, value: { phase: 'player', turn: 2 } })
  expect(resolved).toEqual([])
 })

 it('persists Overwatch weapon mutations and reloads the synchronized equipment link', () => {
  const weaponState = createWeaponState(reactionWeapon, 'hero-hornet', reactionEquipment.ammo[0])
  const active = defaultSave(arena.id, [
   hero({ x: 0, y: 0, ap: 0, overwatch: { reservedAp: 4 }, weaponState: { ...weaponState, magazine: 1, reserveAmmo: 3, durability: 20 } }),
   { ...enemy(), x: 4, y: 1, behavior: 'rusher' },
  ], reactionCatalog, missions, reactionEquipment)
  const pending: SaveData = { ...active, phase: 'enemy', activeEncounterId: active.campaign.mission.id, rngState: 28, campaign: startMission(active.campaign, undefined, missions) }
  const adapter = createLocalStorageAdapter(createMemoryStorage(), reactionCatalog)
  expect(adapter.save(pending)).toBe(true)
  const loaded = adapter.load()
  if (!loaded?.ok) throw new Error('expected persisted enemy snapshot')

  const resumed = resumePersistedEnemyPhase(adapter, loaded.value, reactionArena)
  expect(resumed).toMatchObject({ phase: 'player', turn: 2 })
  const resolvedHero = resumed?.units.find((unit) => unit.id === 'hero')
  const linked = resumed?.inventory.equipment.find((entry) => entry.instanceId === 'hero-hornet')
  expect(resolvedHero?.weaponState).toMatchObject({ weaponInstanceId: 'hero-hornet', ammoId: 'ammo', magazine: 0, magazineSize: 1, reserveAmmo: 3, durability: 18, maxDurability: 100, malfunctioned: true, makeshift: true })
  expect(linked).toMatchObject({ instanceId: 'hero-hornet', itemId: 'hornet', ammoId: 'ammo', magazine: 0, magazineSize: 1, reserveAmmo: 3, durability: 18, maxDurability: 100, malfunctioned: true, makeshift: true, baseDamage: 20, accuracyModifier: -15 })
  const reloaded = adapter.load()
  if (!reloaded?.ok) throw new Error('expected reload validation to succeed')
  expect(reloaded.value.inventory.equipment.find((entry) => entry.instanceId === 'hero-hornet')).toMatchObject({ magazine: 0, reserveAmmo: 3, durability: 18, malfunctioned: true })
  expect(reloaded.value.units.find((unit) => unit.id === 'hero')?.weaponState).toMatchObject({ magazine: 0, reserveAmmo: 3, durability: 18, malfunctioned: true })
 })

 it('retains the enemy snapshot and lock when the resolved save fails', () => {
  let writes = 0
  const backing = createLocalStorageAdapter(createMemoryStorage(), { campaignMissions: missions })
  const adapter = { ...backing, saveDetailed: (save: SaveData) => { writes += 1; return writes === 2 ? { ok: false, error: 'quota' } : backing.saveDetailed(save) } } as SaveAdapter
  const scheduled: (() => void)[] = []
  const resolved: SaveData[] = []
  const coordinator = createEnemyPhaseCoordinator(activeSave(), adapter, (callback) => scheduled.push(callback), arena, (save) => resolved.push(save))
  expect(coordinator.begin()).toBe(true)
  expect(scheduled[0]()).toBeNull()
  expect(resolved).toEqual([])
  expect(coordinator.begin()).toBe(false)
  expect(scheduled[0]()).toMatchObject({ phase: 'player', turn: 2 })
  expect(resolved).toHaveLength(1)
 })

 it('keeps the previous reward state when a home transition cannot be persisted', () => {
  const backing = createLocalStorageAdapter(createMemoryStorage(), { campaignMissions: missions })
  const failing = { ...backing, saveDetailed: () => ({ ok: false, error: 'quota' }) } as SaveAdapter
  const active = activeSave()
  const victory = { ...active, phase: 'victory' as const, campaign: { ...active.campaign, screen: 'reward' as const, mission: { ...active.campaign.mission, status: 'completed' as const, victories: 1 }, encounters: active.campaign.encounters.map((entry) => entry.id === active.campaign.mission.id ? { ...entry, status: 'completed' as const, victories: 1 } : entry) } }
  expect(persistTransition(failing, victory).ok).toBe(false)
  expect(active.campaign.claimedRewards).toEqual([])
 })

 it('does not schedule when synchronous enemy save fails', () => {
  const failing = { ...createLocalStorageAdapter(null), saveDetailed: () => ({ ok: false, error: 'quota' }) } as SaveAdapter
  const coordinator = createEnemyPhaseCoordinator(activeSave(), failing, () => { throw new Error('must not schedule') }, arena, () => {})
  expect(coordinator.begin()).toBe(false)
 })
})
