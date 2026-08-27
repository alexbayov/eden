import { describe, expect, it } from 'vitest'
import { LEGACY_SAVE_STORAGE_KEYS, SAVE_BACKUP_KEY, SAVE_SCHEMA_VERSION, SAVE_STORAGE_KEY, createLocalStorageAdapter, createMemoryStorage, defaultSave, deserializeSave, migrateSave, serializeSave, validateSave, type SaveData } from './save'
import { claimReward, missionDefeat, missionVictory, retreatFromMission, retryMission, startMission, type CampaignMission } from './campaign'
import { characterForXp, DEFAULT_LEVEL_CURVE, levelForXp, skillPointsGranted } from './progression'
import { AP_MAX, type Unit } from './combat'
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
/**
 * Strips a current save back to the exact shape a pre-upgrade installation had on disk: no
 * `character` block, no `campaign.returnReason` and — since W6-01 — no `objective`. Built by removal
 * from a *validated* payload rather than hand-written, so a legacy fixture cannot drift into
 * describing a state the game never wrote.
 */
type LegacyV4Save = Omit<SaveData, 'schemaVersion' | 'character' | 'campaign' | 'objective'> & {
  schemaVersion: 4
  campaign: Omit<SaveData['campaign'], 'returnReason' | 'zones'>
}
const asV4 = (save: SaveData): LegacyV4Save => {
  const rest = { ...save } as Partial<SaveData>
  delete rest.character
  delete rest.objective
  const campaign = { ...save.campaign } as Partial<SaveData['campaign']>
  delete campaign.returnReason
  delete campaign.zones
  return { ...rest, schemaVersion: 4, campaign } as LegacyV4Save
}
/**
 * The v5 shape: everything the current save has except `objective` (W6-01's only addition).
 *
 * Exists so the v5 → v6 migration is tested from a payload that a v5 installation could actually have
 * written, rather than from a current save with one field deleted by hand.
 */
type LegacyV5Save = Omit<SaveData, 'schemaVersion' | 'objective'> & { schemaVersion: 5 }
const asV5 = (save: SaveData): LegacyV5Save => {
  const rest = { ...save } as Partial<SaveData>
  delete rest.objective
  const campaign = { ...save.campaign } as Partial<SaveData['campaign']>
  delete campaign.zones
  return { ...rest, schemaVersion: 5, campaign } as LegacyV5Save
}
/**
 * The v6 shape: everything the current save has except `campaign.zones` (W7-01's only addition).
 *
 * Built by removal from a validated payload so a v6 fixture cannot drift into describing a state v6 never wrote.
 */
type LegacyV6Save = Omit<SaveData, 'schemaVersion'> & { schemaVersion: 6 }
const asV6 = (save: SaveData): LegacyV6Save => {
  const campaign = { ...save.campaign } as Partial<SaveData['campaign']>
  delete campaign.zones
  return { ...save, schemaVersion: 6, campaign } as LegacyV6Save
}
const expectReloads = (save: ReturnType<typeof activeSave>, status: 'active' | 'failed' | 'completed', phase: 'player' | 'defeat' | 'victory') => {
  const adapter = createLocalStorageAdapter(createMemoryStorage(), catalog)
  expect(adapter.save(save)).toBe(true)
  expect(adapter.load(undefined, catalog)).toMatchObject({ ok: true, value: { arenaId: 'perimeter-checkpoint', activeEncounterId: 'perimeter-checkpoint', phase, campaign: { activeMapId: 'perimeter-checkpoint', mission: { status } } } })
}

describe('save data contract v5', () => {
  it('creates, serializes, validates and deep-copies complete campaign state', () => {
    const save = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(save.schemaVersion).toBe(SAVE_SCHEMA_VERSION)
    expect(SAVE_SCHEMA_VERSION).toBe(7)
    expect(save.character).toEqual({ level: 1, xp: 0, unspentSkillPoints: 0 })
    const result = deserializeSave(serializeSave(save), catalog)
    expect(result).toEqual({ ok: true, value: save })
    if (result.ok) expect(result.value.units[0]).not.toBe(save.units[0])
  })

  it('normalizes v3 active encounters through v4 to catalog arena and map IDs', () => {
    const active = asV4(activeSave())
    const v3 = { ...active, schemaVersion: 3, arenaId: 'stale-arena', activeEncounterId: undefined, campaign: { ...active.campaign, activeMapId: undefined, mission: { ...active.campaign.mission, mapId: 'stale-map' }, encounters: active.campaign.encounters.map((entry) => ({ ...entry, mapId: 'stale-map' })) } }
    expect(migrateSave(v3, undefined, catalog)).toMatchObject({ ok: true, value: { schemaVersion: 7, arenaId: 'perimeter-checkpoint', activeEncounterId: 'perimeter-checkpoint', campaign: { activeMapId: 'perimeter-checkpoint', mission: { mapId: 'perimeter-checkpoint' } } } })
  })

  it('migrates a valid v3 home save without inventing an active mission', () => {
    const home = asV4(defaultSave('stale-arena', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
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
        schemaVersion: 7,
        arenaId: 'stale-arena',
        activeEncounterId: null,
        campaign: {
          screen: 'home',
          activeMissionId: null,
          activeMapId: null,
          /* W7-01: the ladder is rebuilt from the stored encounters rather than defaulted, so a mid-campaign save
             does not have a finished zone reopened. */
          zones: [{ order: 1, status: 'available' }],
        },
        /* W6-01: a multi-hop migration lands on fresh objective state, not on a guess. */
        objective: { heldTurns: 0, carrying: false },
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
    const claimedCampaign = claimReward(completed.campaign, 'perimeter-checkpoint-clear', 30)
    const rewarded = { ...completed, phase: 'player' as const, activeEncounterId: null, campaign: claimedCampaign, character: characterForXp(claimedCampaign.xp) }
    const adapter = createLocalStorageAdapter(createMemoryStorage(), catalog)
    expect(adapter.save(rewarded)).toBe(true)
    expect(adapter.load(undefined, catalog)).toMatchObject({ ok: true, value: { activeEncounterId: null, campaign: { activeMapId: null, mission: { status: 'completed', firstRewardClaimed: true }, claimedRewards: ['perimeter-checkpoint-clear'], xp: 30 }, character: { level: 1, xp: 30, unspentSkillPoints: 0 } } })
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
})

/**
 * W4-05 — the migration, both directions of outcome. Success on a valid v4 payload, and a refusal
 * on *each* invariant, because a migration that repairs a broken source is indistinguishable from
 * one that fabricates progress (doc 23 §5.3 rule 4: the invalid source is rejected before, not
 * after, the rewrite).
 */
describe('save schema v5 migration from v4', () => {
  it('raises a valid v4 home save to v5 with derived progression defaults', () => {
    const v4 = asV4(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    expect('character' in v4).toBe(false)
    expect('returnReason' in v4.campaign).toBe(false)
    const migrated = migrateSave(v4, undefined, catalog)
    expect(migrated).toMatchObject({ ok: true, value: { schemaVersion: 7, character: { level: 1, xp: 0, unspentSkillPoints: 0 } } })
    if (migrated.ok) expect(migrated.value.campaign.returnReason).toBeNull()
  })

  it('derives level and unspent points from the v4 campaign XP rather than zeroing them', () => {
    /* 75 XP is exactly the L3 threshold of the shipped curve, so both derived fields are load-bearing. */
    const base = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const claimed = { ...base, campaign: { ...base.campaign, xp: 75, claimedRewards: [] } }
    const migrated = migrateSave(asV4(claimed), undefined, catalog)
     expect(migrated).toMatchObject({ ok: true, value: { character: { level: 2, xp: 75, unspentSkillPoints: 1 } } })
    expect(levelForXp(75)).toBe(2)
    expect(skillPointsGranted(2)).toBe(1)
  })

  it('resolves the v4 return screen ambiguity as a retreat, so upgrading never charges XP', () => {
    /* A v4 payload cannot say whether the player was defeated or retreated: both were the same
       transition. The migration picks the option that costs the player nothing, once. */
    const active = activeSave()
    const failed = { ...active, phase: 'defeat' as const, campaign: missionDefeat(active.campaign) }
    const migrated = migrateSave(asV4(failed), undefined, catalog)
    expect(migrated).toMatchObject({ ok: true, value: { campaign: { screen: 'return', returnReason: 'retreat' } } })
  })

  it('refuses a v4 source that is invalid, on each invariant, before rewriting any field', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const broken = (mutate: (save: Record<string, unknown>) => void) => {
      const source = { ...asV4(valid) } as unknown as Record<string, unknown>
      mutate(source)
      return migrateSave(source, undefined, catalog)
    }
    const campaignOf = (source: Record<string, unknown>) => source.campaign as Record<string, unknown>
    /* Negative XP would migrate into a negative-XP character; caught as a v4 defect instead. */
    expect(broken((source) => { source.campaign = { ...campaignOf(source), xp: -1 } }).ok).toBe(false)
    expect(broken((source) => { source.campaign = { ...campaignOf(source), xp: Number.NaN } }).ok).toBe(false)
    expect(broken((source) => { source.campaign = { ...campaignOf(source), zone: { id: 'unknown-zone', status: 'available' } } }).ok).toBe(false)
    expect(broken((source) => { source.campaign = { ...campaignOf(source), encounters: (campaignOf(source).encounters as unknown[]).slice(0, -1) } }).ok).toBe(false)
    expect(broken((source) => { source.campaign = { ...campaignOf(source), claimedRewards: ['perimeter-checkpoint-clear'] } }).ok).toBe(false)
    expect(broken((source) => { source.units = [hero(), hero()] }).ok).toBe(false)
    expect(broken((source) => { source.turn = 0 }).ok).toBe(false)
    expect(broken((source) => { source.phase = 'victory' }).ok).toBe(false)
    expect(broken((source) => { source.activeEncounterId = 'perimeter-checkpoint' }).ok).toBe(false)
    expect(broken((source) => { source.base = { workbench: 9 } }).ok).toBe(false)
    /* And the sanity check: an untouched source of the same shape still migrates. */
    expect(broken(() => {}).ok).toBe(true)
  })

  it('refuses migration without a validated campaign catalog instead of guessing', () => {
    const v4 = asV4(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    expect(migrateSave(v4).ok).toBe(false)
  })

  it('rejects a save from a future version rather than downgrading it', () => {
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const future = migrateSave({ ...valid, schemaVersion: 8 }, undefined, catalog)
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.error.code).toBe('version')
  })

  it('uses a v5-specific storage and backup key so a v4 payload is never read as v5', () => {
    expect(SAVE_STORAGE_KEY).toBe('eden.save.v7')
    expect(SAVE_BACKUP_KEY).toBe('eden.save.v7.corrupt-backup')
    expect(LEGACY_SAVE_STORAGE_KEYS).toEqual(['eden.save.v6', 'eden.save.v5', 'eden.save.v4'])
    const storage = createMemoryStorage({ [SAVE_STORAGE_KEY]: '{' })
    const adapter = createLocalStorageAdapter(storage, catalog)
    expect(adapter.load(undefined, catalog)).toMatchObject({ ok: false })
    expect(adapter.backupCorrupt()).toBe(true)
    expect(storage.getItem(SAVE_BACKUP_KEY)).toBe('{')
  })

  it('reads a payload left under the legacy key, so bumping the key does not hide a save', () => {
    /* Without this fallback the key bump alone would start every existing player at a fresh
       campaign, which is the failure W4-05 criterion 6 is about — and it would look like data loss,
       not like a migration bug. */
    const legacy = asV4(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    const storage = createMemoryStorage({ [LEGACY_SAVE_STORAGE_KEYS[0]]: JSON.stringify(legacy) })
    const adapter = createLocalStorageAdapter(storage, catalog)
    expect(adapter.hasPendingUpgrade()).toBe(true)
    const loaded = adapter.load(undefined, catalog)
    expect(loaded).toMatchObject({ ok: true, value: { schemaVersion: 7, character: { level: 1 } } })

    /* Writing puts the live copy under the current key and leaves the legacy payload intact. */
    if (!loaded?.ok) throw new Error('expected the legacy payload to migrate')
    expect(adapter.save(loaded.value)).toBe(true)
    expect(adapter.hasPendingUpgrade()).toBe(false)
    expect(storage.getItem(LEGACY_SAVE_STORAGE_KEYS[0])).toBe(JSON.stringify(legacy))
    expect(JSON.parse(storage.getItem(SAVE_STORAGE_KEY)!).schemaVersion).toBe(7)

    /* A current-key payload wins over a legacy one, so a stale v4 can never shadow live progress. */
    expect(adapter.load(undefined, catalog)).toMatchObject({ ok: true, value: { schemaVersion: 7 } })
  })

  it('backs up the legacy payload that actually failed, not an unrelated empty key', () => {
    const storage = createMemoryStorage({ [LEGACY_SAVE_STORAGE_KEYS[0]]: '{ broken' })
    const adapter = createLocalStorageAdapter(storage, catalog)
    expect(adapter.load(undefined, catalog)).toMatchObject({ ok: false })
    expect(adapter.backupCorrupt()).toBe(true)
    expect(storage.getItem(SAVE_BACKUP_KEY)).toBe('{ broken')
  })

  it('clears every slot on reset, so a legacy payload cannot resurrect on the next boot', () => {
    const legacy = asV4(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    const storage = createMemoryStorage({
      [LEGACY_SAVE_STORAGE_KEYS[0]]: JSON.stringify(legacy),
      [SAVE_STORAGE_KEY]: '{ broken',
    })
    const adapter = createLocalStorageAdapter(storage, catalog)
    expect(adapter.reset()).toBe(true)
    expect(adapter.load(undefined, catalog)).toBeNull()
    expect(adapter.hasPendingUpgrade()).toBe(false)
  })
})

describe('save schema v6 migration from v5 (W6-01 objective state)', () => {
  it('raises a valid v5 save to v6 with fresh objective state', () => {
    const v5 = asV5(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    expect('objective' in v5).toBe(false)

    const migrated = migrateSave(v5, undefined, catalog)

    expect(migrated).toMatchObject({ ok: true, value: { schemaVersion: 7, objective: { heldTurns: 0, carrying: false } } })
    /* Nothing else moved. Compared field by field rather than wholesale, because the chain now continues to v7 and
       that stage legitimately adds `campaign.zones` — see the v6 → v7 block below. */
    if (!migrated.ok) throw new Error('expected the v5 payload to migrate')
    expect(migrated.value.character).toEqual(v5.character)
    expect(migrated.value.inventory).toEqual(v5.inventory)
    const { zones, ...campaignWithoutLadder } = migrated.value.campaign
    expect(campaignWithoutLadder).toEqual(v5.campaign)
    expect(zones).toHaveLength(1)
  })

  it('rejects an invalid v5 source instead of rewriting it into a valid-looking v6', () => {
    /* The property the whole chain rests on: each stage is validated by its own version's rules
       *before* any field is added, so a broken payload fails rather than being laundered by the
       migration into something the validator then accepts. */
    const v5 = asV5(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    const broken = { ...v5, campaign: { ...v5.campaign, xp: -1 } }

    const migrated = migrateSave(broken, undefined, catalog)

    expect(migrated.ok).toBe(false)
    if (!migrated.ok) expect(migrated.error.code).toBe('shape')
  })

  it('reads a v5 payload left under its own key, so the key bump does not hide a save', () => {
    /* Same guarantee W4-05 established for v4, now for v5: bumping the storage key must not start an
       existing player at a fresh campaign. Both legacy keys are searched, newest first. */
    const v5 = asV5(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    const storage = createMemoryStorage({ 'eden.save.v5': JSON.stringify(v5) })
    const adapter = createLocalStorageAdapter(storage, catalog)

    expect(adapter.hasPendingUpgrade()).toBe(true)
    const loaded = adapter.load(undefined, catalog)
    expect(loaded).toMatchObject({ ok: true, value: { schemaVersion: 7, objective: { heldTurns: 0, carrying: false } } })

    if (!loaded?.ok) throw new Error('expected the v5 payload to migrate')
    expect(adapter.save(loaded.value)).toBe(true)
    /* The live copy lands under the current key and the legacy payload is left intact. */
    expect(JSON.parse(storage.getItem(SAVE_STORAGE_KEY)!).schemaVersion).toBe(7)
    expect(storage.getItem('eden.save.v5')).toBe(JSON.stringify(v5))
  })

  it('requires objective state to be inert outside an active mission', () => {
    /*
     * Why this is validated rather than trusted: `evaluateObjective` compares `heldTurns` against the
     * mission's `holdTurns` and does not re-derive it from the board, so a hand-edited value is a free
     * completion. `carrying` is the same for a delivery. Rejecting non-zero progress on a non-mission
     * screen also stops one mission's progress from being inherited by the next.
     */
    const home = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(validateSave(home, catalog).ok).toBe(true)
    expect(validateSave({ ...home, objective: { heldTurns: 3, carrying: false } }, catalog).ok).toBe(false)
    expect(validateSave({ ...home, objective: { heldTurns: 0, carrying: true } }, catalog).ok).toBe(false)
    /* Shape is checked too, so a missing or malformed block cannot reach the runtime. */
    expect(validateSave({ ...home, objective: undefined }, catalog).ok).toBe(false)
    expect(validateSave({ ...home, objective: { heldTurns: -1, carrying: false } }, catalog).ok).toBe(false)
    expect(validateSave({ ...home, objective: { heldTurns: 1.5, carrying: false } }, catalog).ok).toBe(false)

    /* On an active mission the same progress is legitimate. */
    const active = activeSave()
    expect(validateSave({ ...active, objective: { heldTurns: 3, carrying: true } }, catalog).ok).toBe(true)
  })
})

describe('save v6 overwatch validation (W6-04)', () => {
  const watching = (overwatch: unknown, unitId = 'hero') => {
    const active = activeSave()
    return { ...active, units: active.units.map((unit) => (unit.id === unitId ? { ...unit, overwatch } : unit)) }
  }

  it('accepts a legitimate reserve', () => {
    expect(validateSave(watching({ reservedAp: 4 }), catalog).ok).toBe(true)
    expect(validateSave(watching({ reservedAp: 0 }), catalog).ok).toBe(true)
    /* `startTurn` can grant up to AP_MAX, so a reserve above the nominal 10 is reachable. */
    expect(validateSave(watching({ reservedAp: AP_MAX }), catalog).ok).toBe(true)
  })

  it('rejects every tampered payload that used to load cleanly', () => {
    /*
     * Before W6-04 `overwatch` was not validated at all — `grep overwatch save.ts` returned nothing — and all
     * of these were accepted. `reservedAp: 9999` is a free reaction stronger than any turn can grant, and the
     * string would reach `combatAttack`'s AP comparison as a string.
     */
    for (const tampered of [
      { reservedAp: 9999 },
      { reservedAp: AP_MAX + 1 },
      { reservedAp: -5 },
      { reservedAp: 1.5 },
      { reservedAp: 'lots' },
      { reservedAp: 4, bonus: 9 },
      {},
      null,
    ])
      expect(validateSave(watching(tampered), catalog).ok, JSON.stringify(tampered)).toBe(false)
  })

  it('refuses an enemy carrying Overwatch, a state no transition produces', () => {
    /* Enemy Overwatch does not exist and is explicitly out of scope in W6-04, so a block on an enemy unit is
       either tampering or a bug — either way it must not load. The base fixture is hero-only, so the enemy is
       added here; the control case proves the unit itself is otherwise acceptable. */
    const active = activeSave()
    const raider = hero({ id: 'raider', name: 'Raider', team: 'enemy', hp: 16, maxHp: 16, x: 4, y: 1 })
    const withEnemy = { ...active, units: [...active.units, raider] }
    expect(validateSave(withEnemy, catalog).ok).toBe(true)
    const armedEnemy = { ...active, units: [...active.units, { ...raider, overwatch: { reservedAp: 4 } }] }
    expect(validateSave(armedEnemy, catalog).ok).toBe(false)
  })

  it('refuses Overwatch outside an active mission', () => {
    /* `runEnemyTurn` clears the block at the end of every phase, so a persisted one on the home screen would
       arm a reaction where Overwatch cannot be activated and no enemy phase runs. */
    const home = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const armed = { ...home, units: home.units.map((unit) => ({ ...unit, overwatch: { reservedAp: 4 } })) }
    expect(validateSave(home, catalog).ok).toBe(true)
    expect(validateSave(armed, catalog).ok).toBe(false)
  })
})

describe('save schema v7 migration from v6 (W7-01 zone ladder)', () => {
  it('rebuilds the ladder from the stored encounters rather than defaulting', () => {
    /*
     * The rule that matters: a v6 save can be mid-campaign with every encounter of its zone completed, and defaulting
     * to "first zone available" would reopen a zone the player had finished. The encounters carry the answer.
     */
    const v6 = asV6(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    expect('zones' in v6.campaign).toBe(false)

    const migrated = migrateSave(v6, undefined, catalog)

    expect(migrated).toMatchObject({ ok: true, value: { schemaVersion: 7 } })
    if (!migrated.ok) throw new Error('expected the v6 payload to migrate')
    expect(migrated.value.campaign.zones).toEqual([
      { id: v6.campaign.zone.id, order: 1, status: 'available' },
    ])
    /* Nothing else moved: v7 adds one field. */
    expect(migrated.value.character).toEqual(v6.character)
    expect(migrated.value.inventory).toEqual(v6.inventory)
    expect(migrated.value.objective).toEqual(v6.objective)
  })

  it('carries a finished zone forward as completed instead of reopening it', () => {
    /* The case that makes the "rebuild" rule necessary rather than decorative. */
    const base = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const finished = (entry: (typeof base.campaign.encounters)[number]) => ({
      ...entry,
      status: 'completed' as const,
      victories: 1,
      firstRewardClaimed: true,
    })
    const encounters = base.campaign.encounters.map(finished)
    const cleared = {
      ...base,
      campaign: {
        ...base.campaign,
        encounters,
        /* `campaign.mission` must stay an exact copy of its matching encounter — the validator enforces that pairing,
           and forgetting it here produced a rejection that looked like a migration defect. */
        mission: encounters.find((entry) => entry.id === base.campaign.mission.id) ?? finished(base.campaign.mission),
        claimedRewards: DEFAULT_CAMPAIGN_MISSIONS.map((mission) => mission.rewardId),
        zone: { ...base.campaign.zone, status: 'completed' as const },
      },
    }
    const migrated = migrateSave(asV6(cleared), undefined, catalog)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value.campaign.zones[0].status).toBe('completed')
    expect(migrated.value.campaign.zone.status).toBe('completed')
  })

  it('rejects an invalid v6 source rather than laundering it into a valid v7', () => {
    const v6 = asV6(defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS))
    const broken = { ...v6, campaign: { ...v6.campaign, xp: -1 } }
    const migrated = migrateSave(broken, undefined, catalog)
    expect(migrated.ok).toBe(false)
    if (!migrated.ok) expect(migrated.error.code).toBe('shape')
  })

  it('refuses a hand-edited ladder that skips the campaign', () => {
    /*
     * Validated rather than trusted for the same reason `overwatch` is: an edited ladder is a skipped campaign. Three
     * separate routes, one assertion each so a regression names which one came back.
     */
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    expect(validateSave(valid, catalog).ok).toBe(true)
    const withLadder = (zones: unknown) => ({ ...valid, campaign: { ...valid.campaign, zones } })

    /* A later zone open while an earlier one is locked. */
    expect(
      validateSave(
        withLadder([
          { id: 'z1', order: 1, status: 'locked' },
          { id: 'z2', order: 2, status: 'available' },
        ]),
        catalog,
      ).ok,
    ).toBe(false)
    /* Two zones open at once, which no transition produces. */
    expect(
      validateSave(
        withLadder([
          { id: 'z1', order: 1, status: 'available' },
          { id: 'z2', order: 2, status: 'available' },
        ]),
        catalog,
      ).ok,
    ).toBe(false)
    /* Malformed shapes. */
    for (const bad of [[], null, [{ id: 'z1', order: 0, status: 'available' }], [{ id: 'z1', order: 1, status: 'open' }]])
      expect(validateSave(withLadder(bad), catalog).ok, JSON.stringify(bad)).toBe(false)
  })

  it('requires the active zone to be the one the ladder says is open', () => {
    /*
     * Every screen reads `campaign.zone` while unlocking reads `campaign.zones`, so a mismatch would show the player
     * one zone and let them play another. The pair is kept in step by `missionVictory`; this refuses a payload where
     * it is not.
     */
    const valid = defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
    const mismatched = {
      ...valid,
      campaign: { ...valid.campaign, zone: { id: 'some-other-zone', status: 'available' as const } },
    }
    expect(validateSave(mismatched, catalog).ok).toBe(false)
  })
})

describe('save v5 character block', () => {
  const homeSave = () => defaultSave('perimeter-checkpoint', [hero()], undefined, DEFAULT_CAMPAIGN_MISSIONS)
  const withXp = (xp: number) => {
    const base = homeSave()
    return { ...base, campaign: { ...base.campaign, xp }, character: characterForXp(xp) }
  }

  it('accepts a character consistent with the progression curve', () => {
    for (const xp of [0, 29, 30, 74, 75, 300, 999]) expect(validateSave(withXp(xp), catalog).ok).toBe(true)
  })

  it('rejects a missing, malformed or curve-inconsistent character block', () => {
    const valid = withXp(30)
    expect(validateSave({ ...valid, character: undefined }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, character: { level: 2, xp: 30 } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, character: { ...valid.character, xp: -1 } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, character: { ...valid.character, level: 0 } }, catalog).ok).toBe(false)
    /* Level above the curve's ceiling, and level that disagrees with the XP it claims. */
    expect(validateSave({ ...valid, character: { ...valid.character, level: DEFAULT_LEVEL_CURVE.thresholds.length + 2 } }, catalog).ok).toBe(false)
    expect(validateSave({ ...valid, character: { level: 6, xp: 30, unspentSkillPoints: 5 } }, catalog).ok).toBe(false)
    /* More unspent points than the reached levels ever granted. */
    expect(validateSave({ ...valid, character: { ...valid.character, unspentSkillPoints: 99 } }, catalog).ok).toBe(false)
    /* XP that disagrees with the campaign: one home for one number. */
    expect(validateSave({ ...valid, character: { ...valid.character, xp: 75, level: 3 } }, catalog).ok).toBe(false)
  })

  it('requires the return screen to record why it was reached, and only there', () => {
    const active = activeSave()
    const defeated = { ...active, phase: 'defeat' as const, campaign: missionDefeat(active.campaign) }
    const retreated = { ...active, phase: 'defeat' as const, campaign: retreatFromMission(active.campaign) }
    expect(defeated.campaign.returnReason).toBe('defeat')
    expect(retreated.campaign.returnReason).toBe('retreat')
    expect(validateSave(defeated, catalog).ok).toBe(true)
    expect(validateSave(retreated, catalog).ok).toBe(true)
    expect(validateSave({ ...defeated, campaign: { ...defeated.campaign, returnReason: null } }, catalog).ok).toBe(false)
    expect(validateSave({ ...defeated, campaign: { ...defeated.campaign, returnReason: 'quit' } }, catalog).ok).toBe(false)
    /* A stale reason outside the return screen would be read by the penalty later. */
    expect(validateSave({ ...active, campaign: { ...active.campaign, returnReason: 'defeat' } }, catalog).ok).toBe(false)
  })
})

describe('save data contract v5, continued', () => {

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
