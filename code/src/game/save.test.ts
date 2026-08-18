import { describe, expect, it } from 'vitest'
import { SAVE_BACKUP_KEY, SAVE_SCHEMA_VERSION, SAVE_STORAGE_KEY, createLocalStorageAdapter, createMemoryStorage, defaultSave, deserializeSave, migrateSave, serializeSave, validateSave } from './save'
import { claimReward, missionDefeat, missionVictory, retryMission, startMission, type CampaignMission } from './campaign'
import type { Unit } from './combat'
import type { EquipmentCatalog } from './equipment-content'

const DEFAULT_CAMPAIGN_MISSIONS: CampaignMission[] = [
  { id: 'perimeter-checkpoint', zoneId: 'near-perimeter', order: 1, rewardId: 'perimeter-checkpoint-clear', arenaId: 'perimeter-checkpoint' },
  { id: 'collapsed-yard', zoneId: 'near-perimeter', order: 2, rewardId: 'collapsed-yard-clear', arenaId: 'collapsed-yard' },
  { id: 'relay-station', zoneId: 'near-perimeter', order: 3, rewardId: 'relay-station-clear', arenaId: 'relay-station' },
]

const hero = (overrides: Partial<Unit> = {}): Unit => ({ id: 'hero', name: 'Оперативник', team: 'player', x: 1, y: 2, hp: 24, maxHp: 24, aim: 72, color: '#65d7ff', ap: 10, posture: 'stand', statuses: {}, ...overrides })
const catalog = { campaignCatalog: { catalogId: 'test-catalog', missions: DEFAULT_CAMPAIGN_MISSIONS, missionIds: new Set(DEFAULT_CAMPAIGN_MISSIONS.map((entry) => entry.id)), rewardIds: new Set(DEFAULT_CAMPAIGN_MISSIONS.map((entry) => entry.rewardId)), arenaIds: new Set(DEFAULT_CAMPAIGN_MISSIONS.map((entry) => entry.arenaId!)), rewardIdForMission: (id: string) => DEFAULT_CAMPAIGN_MISSIONS.find((entry) => entry.id === id)?.rewardId, arenaIdForMission: (id: string) => DEFAULT_CAMPAIGN_MISSIONS.find((entry) => entry.id === id)?.arenaId } }
const runtimeCatalog = { campaignCatalog: { ...catalog.campaignCatalog, zoneIds: new Set(['near-perimeter']), itemIds: new Set(['field-bandage']), itemWeightForId: (id: string) => id === 'field-bandage' ? 1 : undefined, weaponIds: new Set(['hornet', 'pm']), weaponForId: (id: string) => id === 'hornet' ? { id: 'hornet', name: 'Шершень', role: 'makeshift' as const, ammoId: '9x18', baseDamage: 20, accuracyModifier: -15, critModifier: 0, penetration: 0, magazineSize: 1, reloadAp: 2, durabilityPerShot: 2, makeshift: true } : id === 'pm' ? { id: 'pm', name: 'ПМ', role: 'pistol' as const, ammoId: '9x18', baseDamage: 20, accuracyModifier: 5, critModifier: 5, penetration: 0, magazineSize: 8, reloadAp: 3, durabilityPerShot: 1, makeshift: false } : undefined, armorIds: new Set(['patched-vest']), armorSlotForId: (id: string) => id === 'patched-vest' ? 'torso' : undefined, armorForId: (id: string) => id === 'patched-vest' ? { id: 'patched-vest', name: 'Латаный жилет', slot: 'torso' as const, reduction: { torso: 3, arm: 1 } } : undefined, ammoIds: new Set(['9x18']), ammoForId: (id: string) => id === '9x18' ? { damageModifier: 0, penetrationModifier: 0 } : undefined } }
const runtimeWeapon = { weaponInstanceId: 'hero-hornet', weaponId: 'hornet', name: 'Шершень', ammoId: '9x18', baseDamage: 20, accuracyModifier: -15, critModifier: 0, penetration: 0, ammoDamageModifier: 0, ammoPenetrationModifier: 0, magazine: 1, magazineSize: 1, reserveAmmo: 8, durability: 70, maxDurability: 100, durabilityPerShot: 2, reloadAp: 2, makeshift: true }
const runtimeArmor = { armorInstanceId: 'starter-vest', armorId: 'patched-vest', durability: 100, maxDurability: 100, reduction: { torso: 3, arm: 1 } }
const freshEquipmentCatalog: EquipmentCatalog = {
  weapons: [{ id: 'pm', name: 'ПМ', role: 'pistol', ammoId: '9x18', baseDamage: 20, accuracyModifier: 5, critModifier: 5, penetration: 0, magazineSize: 8, reloadAp: 3, durabilityPerShot: 1, makeshift: false }],
  ammo: [{ id: '9x18', name: '9×18', damageModifier: 0.1, penetrationModifier: 0.2 }],
  armor: [{ id: 'patched-helmet', name: 'Шлем', slot: 'head', reduction: { head: 4 } }],
  enemies: [{ id: 'guard', name: 'Охранник', behavior: 'shooter', intent: 'держит линию огня', weaponId: 'pm', armorIds: ['patched-helmet'] }],
}
const freshCatalog = { campaignCatalog: { ...runtimeCatalog.campaignCatalog, weaponForId: (id: string) => id === 'pm' ? freshEquipmentCatalog.weapons[0] : undefined, ammoForId: (id: string) => id === '9x18' ? freshEquipmentCatalog.ammo[0] : undefined, armorIds: new Set(['patched-helmet']), armorSlotForId: (id: string) => id === 'patched-helmet' ? 'head' : undefined, armorForId: (id: string) => id === 'patched-helmet' ? freshEquipmentCatalog.armor[0] : undefined } }
const activeSave = (id = 'perimeter-checkpoint') => {
  const base = defaultSave(id, [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
  const campaign = startMission(base.campaign, id, DEFAULT_CAMPAIGN_MISSIONS)
  return { ...base, arenaId: campaign.activeMapId!, activeEncounterId: id, campaign }
}
const expectReloads = (save: ReturnType<typeof activeSave>, status: 'active' | 'failed' | 'completed', phase: 'player' | 'defeat' | 'victory') => {
  const adapter = createLocalStorageAdapter(createMemoryStorage(), catalog)
  expect(adapter.save(save)).toBe(true)
  expect(adapter.load(undefined, catalog)).toMatchObject({ ok: true, value: { arenaId: 'perimeter-checkpoint', activeEncounterId: 'perimeter-checkpoint', phase, campaign: { activeMapId: 'perimeter-checkpoint', mission: { status } } } })
}

describe('save data contract v4', () => {
  it('creates, serializes, validates and deep-copies complete campaign state', () => {
    const save = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    const result = deserializeSave(serializeSave(save), catalog)
    expect(result).toEqual({ ok: true, value: save })
    if (result.ok) expect(result.value.units[0]).not.toBe(save.units[0])
  })

  it('normalizes v3 active encounters to catalog arena and map IDs', () => {
    const active = activeSave()
    const v3 = { ...active, schemaVersion: 3, arenaId: 'stale-arena', activeEncounterId: undefined, campaign: { ...active.campaign, activeMapId: undefined, mission: { ...active.campaign.mission, mapId: 'stale-map' }, encounters: active.campaign.encounters.map((entry) => ({ ...entry, mapId: 'stale-map' })) } }
    expect(migrateSave(v3, undefined, catalog)).toMatchObject({ ok: true, value: { schemaVersion: 4, arenaId: 'perimeter-checkpoint', activeEncounterId: 'perimeter-checkpoint', campaign: { activeMapId: 'perimeter-checkpoint', mission: { mapId: 'perimeter-checkpoint' } } } })
  })

  it('migrates a valid v3 home save without inventing an active mission', () => {
    const home = defaultSave('stale-arena', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const v3 = {
      ...home,
      schemaVersion: 3,
      arenaId: 'stale-arena',
      activeEncounterId: null,
      campaign: {
        ...home.campaign,
        activeMissionId: null,
        activeMapId: null,
        screen: 'home' as const,
      },
    }
    expect(migrateSave(v3, undefined, catalog)).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 4,
        arenaId: 'stale-arena',
        activeEncounterId: null,
        campaign: { screen: 'home', activeMissionId: null, activeMapId: null },
      },
    })
  })

  it('requires exact campaign mission mirrors and catalog encounter coverage', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(validateSave({
      ...valid,
      campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, victories: 1 } },
    }, catalog).ok).toBe(false)
    expect(validateSave({
      ...valid,
      campaign: { ...valid.campaign, encounters: valid.campaign.encounters.slice(0, -1) },
    }, catalog).ok).toBe(false)
    expect(validateSave({
      ...valid,
      campaign: { ...valid.campaign, encounters: [...valid.campaign.encounters.slice(0, -1), valid.campaign.encounters[0]] },
    }, catalog).ok).toBe(false)
    expect(validateSave(valid, catalog).ok).toBe(true)
  })
  it('rejects malformed schema, combat, and active arena/map invariants', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(validateSave({ ...valid, schemaVersion: 5 }).ok).toBe(false)
    expect(validateSave({ ...valid, units: [hero(), hero()] }).ok).toBe(false)
    expect(validateSave({ ...valid, activeEncounterId: 'perimeter-checkpoint' }, catalog).ok).toBe(false)
    const active = activeSave()
    expect(validateSave({ ...active, arenaId: 'collapsed-yard' }).ok).toBe(false)
    expect(validateSave({ ...active, campaign: { ...active.campaign, activeMapId: 'collapsed-yard' } }).ok).toBe(false)
    expect(validateSave({ ...active, activeEncounterId: null }, catalog).ok).toBe(false)
  })

  it('validates the standalone current mission against the runtime catalog and campaign state', () => {
    const valid = activeSave()
    expect(validateSave(valid, catalog).ok).toBe(true)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, id: 'unknown-mission' } } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, rewardId: 'wrong-reward' } } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, mapId: 'wrong-map' } } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, status: 'completed' } } }, catalog).ok).toBe(false)
  })

  it('rejects v3 missions with unknown IDs instead of inventing catalog links', () => {
    const valid = activeSave()
    const v3 = { ...valid, schemaVersion: 3, campaign: { ...valid.campaign, mission: { ...valid.campaign.mission, id: 'unknown-mission' } } }
    expect(migrateSave(v3, undefined, catalog).ok).toBe(false)
  })

  it('rejects forged home saves that clear a completed reward claim or replay an earlier encounter', () => {
    const active = activeSave()
    const completed = { ...active, phase: 'victory' as const, campaign: missionVictory(active.campaign, DEFAULT_CAMPAIGN_MISSIONS) }
    const rewarded = { ...completed, phase: 'player' as const, activeEncounterId: null, campaign: claimReward(completed.campaign, 'perimeter-checkpoint-clear', 30) }
    const clearedClaim = {
      ...rewarded,
      campaign: {
        ...rewarded.campaign,
        claimedRewards: [],
        mission: { ...rewarded.campaign.mission, firstRewardClaimed: false },
        encounters: rewarded.campaign.encounters.map((entry) => entry.id === 'perimeter-checkpoint' ? { ...entry, firstRewardClaimed: false } : entry),
      },
    }
    expect(validateSave(clearedClaim, catalog).ok).toBe(false)

    const resetCompleted = {
      ...rewarded,
      campaign: {
        ...rewarded.campaign,
        mission: { ...rewarded.campaign.mission, status: 'available' as const },
        encounters: rewarded.campaign.encounters.map((entry) => entry.id === 'perimeter-checkpoint' ? { ...entry, status: 'available' as const } : entry),
      },
    }
    expect(validateSave(resetCompleted, catalog).ok).toBe(false)
  })

  it('keeps failed encounters and legitimate retries valid', () => {
    const active = activeSave()
    const failed = { ...active, phase: 'defeat' as const, campaign: missionDefeat(active.campaign) }
    expect(validateSave(failed, catalog).ok).toBe(true)
    const retryCampaign = retryMission(failed.campaign, DEFAULT_CAMPAIGN_MISSIONS)
    const retry = { ...failed, phase: 'player' as const, campaign: retryCampaign, activeEncounterId: 'perimeter-checkpoint', arenaId: 'perimeter-checkpoint' }
    expect(validateSave(retry, catalog).ok).toBe(true)
  })

  it('loads valid active, failed, completed, and reward encounter states with catalog data', () => {
    const active = activeSave()
    expectReloads(active, 'active', 'player')
    const failed = { ...active, phase: 'defeat' as const, campaign: missionDefeat(active.campaign) }
    expectReloads(failed, 'failed', 'defeat')
    const completed = { ...active, phase: 'victory' as const, campaign: missionVictory(active.campaign, DEFAULT_CAMPAIGN_MISSIONS) }
    expectReloads(completed, 'completed', 'victory')
    const rewarded = { ...completed, phase: 'player' as const, activeEncounterId: null, campaign: claimReward(completed.campaign, 'perimeter-checkpoint-clear', 30) }
    const adapter = createLocalStorageAdapter(createMemoryStorage(), catalog)
    expect(adapter.save(rewarded)).toBe(true)
    expect(adapter.load(undefined, catalog)).toMatchObject({ ok: true, value: { activeEncounterId: null, campaign: { activeMapId: null, mission: { status: 'completed', firstRewardClaimed: true }, claimedRewards: ['perimeter-checkpoint-clear'], xp: 30 } } })
  })

  it('rejects malformed campaign scalar fields and missing or unknown zone without throwing', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(() => validateSave({ ...valid, campaign: { ...valid.campaign, zone: undefined } }, catalog)).not.toThrow()
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, zone: undefined } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, zone: { id: 'unknown-zone', status: 'available' } } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, xp: Number.NaN } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, xp: -1 } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, campaign: { ...valid.campaign, firstDeathReturnUsed: 'false' } }, catalog).ok).toBe(false)
  })

  it('rejects unknown item/equipment IDs and accepts valid loaded runtime catalogs', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero({ weaponState: runtimeWeapon, armor: runtimeArmor })], runtimeCatalog.campaignCatalog)
    expect(validateSave(valid, runtimeCatalog).ok).toBe(true)
    const unknownItem = { ...valid, inventory: { ...valid.inventory, stash: { ...valid.inventory.stash, items: [{ id: 'unknown-item', quantity: 1, weight: 1 }] } } }
    expect(validateSave(unknownItem, runtimeCatalog).ok).toBe(false)
    const unknownEquipment = { ...valid, inventory: { ...valid.inventory, equipment: valid.inventory.equipment.map((entry) => entry.instanceId === 'hero-hornet' ? { ...entry, itemId: 'unknown-weapon' } : entry) } }
    expect(validateSave(unknownEquipment, runtimeCatalog).ok).toBe(false)
    const badQuickSlot = { ...valid, inventory: { ...valid.inventory, backpack: { ...valid.inventory.backpack, items: [{ id: 'field-bandage', quantity: 1, weight: 1 }] }, quickSlots: ['unknown-item', null, null, null] } }
    expect(validateSave(badQuickSlot, runtimeCatalog).ok).toBe(false)
  })
  it('rejects missing or tampered runtime-derived weapon and armor fields', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero({ weaponState: runtimeWeapon, armor: runtimeArmor })], runtimeCatalog.campaignCatalog)
    const missingWeaponField = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: Object.fromEntries(Object.entries(unit.weaponState!).filter(([key]) => key !== 'name')) } : unit) }
    const tamperedWeaponField = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: { ...unit.weaponState!, baseDamage: 999, ammoDamageModifier: 0.9 } } : unit) }
    const forgedMagazine = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: { ...unit.weaponState!, magazine: unit.weaponState!.magazineSize + 1 } } : unit) }
    const forgedReserve = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: { ...unit.weaponState!, reserveAmmo: -1 } } : unit) }
    const forgedMalfunction = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, weaponState: { ...unit.weaponState!, malfunctioned: true } } : unit) }
    const tamperedArmorField = { ...valid, units: valid.units.map((unit) => unit.id === 'hero' ? { ...unit, armor: { ...unit.armor!, reduction: { torso: 99, arm: 1 } } } : unit) }
    expect(validateSave(valid, runtimeCatalog).ok).toBe(true)
    expect(validateSave(missingWeaponField, runtimeCatalog).ok).toBe(false)
    expect(validateSave(tamperedWeaponField, runtimeCatalog).ok).toBe(false)
    expect(validateSave(forgedMagazine, runtimeCatalog).ok).toBe(false)
    expect(validateSave(forgedReserve, runtimeCatalog).ok).toBe(false)
    expect(validateSave(forgedMalfunction, runtimeCatalog).ok).toBe(false)
    expect(validateSave(tamperedArmorField, runtimeCatalog).ok).toBe(false)
  })

  it('hydrates fresh boot saves from catalog-authoritative player and enemy equipment', () => {
    const player = hero({ weaponState: { weaponInstanceId: 'hero-pm', weaponId: 'pm', name: 'stale', ammoId: 'wrong', baseDamage: 1, accuracyModifier: 1, critModifier: 1, penetration: 0, ammoDamageModifier: 0, ammoPenetrationModifier: 0, magazine: 1, magazineSize: 1, reserveAmmo: 1, durability: 40, maxDurability: 100, durabilityPerShot: 9, reloadAp: 9, makeshift: true }, armor: { armorInstanceId: 'hero-helmet', armorId: 'patched-helmet', durability: 60, maxDurability: 100, reduction: { torso: 99 } } })
    const guard: Unit = { id: 'guard', name: 'Guard', team: 'enemy', x: 3, y: 0, hp: 20, maxHp: 20, aim: 50, color: '#f00', ap: 0, archetypeId: 'guard' }
    const save = defaultSave('perimeter-checkpoint', [player, guard], freshCatalog.campaignCatalog, DEFAULT_CAMPAIGN_MISSIONS, freshEquipmentCatalog)
    const hydratedHero = save.units.find((unit) => unit.id === 'hero')!
    const hydratedGuard = save.units.find((unit) => unit.id === 'guard')!
    expect(hydratedHero.weaponState).toMatchObject({ weaponId: 'pm', ammoId: '9x18', baseDamage: 20, ammoDamageModifier: 0.1, ammoPenetrationModifier: 0.2, magazineSize: 8, durabilityPerShot: 1, reloadAp: 3, makeshift: false })
    expect(hydratedHero.armor).toMatchObject({ armorId: 'patched-helmet', reduction: { head: 4 } })
    expect(save.inventory.equipment.find((entry) => entry.instanceId === 'hero-helmet')?.slot).toBe('head')
    expect(hydratedGuard.weaponState).toMatchObject({ weaponId: 'pm', ammoDamageModifier: 0.1 })
    expect(validateSave(save, freshCatalog).ok).toBe(true)
  })

  it('derives the linked armor slot from the armor catalog instead of torso fallback', () => {
    const save = defaultSave('perimeter-checkpoint', [hero({ armor: { armorInstanceId: 'helmet', armorId: 'patched-helmet', durability: 100, maxDurability: 100, reduction: { head: 4 } } })], freshCatalog.campaignCatalog, DEFAULT_CAMPAIGN_MISSIONS, freshEquipmentCatalog)
    expect(save.inventory.equipment.find((entry) => entry.instanceId === 'helmet')?.slot).toBe('head')
  })

  it('accepts composite runtime armor through save round-trip and rejects unknown components', () => {
    const compositeCatalog = {
      campaignCatalog: {
        ...runtimeCatalog.campaignCatalog,
        armorIds: new Set(['vest-front', 'vest-back']),
        armorSlotForId: (id: string) => ['vest-front', 'vest-back'].includes(id) ? 'torso' : undefined,
        armorForId: (id: string) => id === 'vest-front' ? { id, name: 'Front plate', slot: 'torso' as const, reduction: { torso: 3 }, maxDurability: 60 } : id === 'vest-back' ? { id, name: 'Back plate', slot: 'torso' as const, reduction: { torso: 2, arm: 1 }, maxDurability: 40 } : undefined,
      },
    }
    const armor = { armorInstanceId: 'composite-vest', armorId: 'vest-front+vest-back', durability: 100, maxDurability: 100, reduction: { torso: 5, arm: 1 } }
    const save = defaultSave('perimeter-checkpoint', [hero({ armor })], compositeCatalog.campaignCatalog)
    expect(save.units[0].armor).toMatchObject({ armorId: armor.armorId, maxDurability: 100, reduction: armor.reduction })
    expect(validateSave(save, compositeCatalog).ok).toBe(true)
    const roundTrip = deserializeSave(serializeSave(save), compositeCatalog)
    expect(roundTrip.ok).toBe(true)
    expect(validateSave({ ...save, units: save.units.map((unit) => unit.id === 'hero' ? { ...unit, armor: { ...unit.armor!, armorId: 'vest-front+missing' } } : unit) }, compositeCatalog).ok).toBe(false)
  })
  it('backs up corrupt raw payload without deleting it', () => {
    const storage = createMemoryStorage({ [SAVE_STORAGE_KEY]: '{' })
    const adapter = createLocalStorageAdapter(storage)
    expect(adapter.load()).toMatchObject({ ok: false })
    expect(adapter.backupCorrupt()).toBe(true)
    expect(storage.getItem(SAVE_BACKUP_KEY)).toBe('{')
    expect(adapter.reset()).toBe(true)
  })
})
