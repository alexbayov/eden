import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArenaContent, validateArenaCatalog } from './content'
import { validateMissions } from './campaign-content'
import { claimReward, createCampaign, missionDefeat, missionVictory, returnFromMission, startMission, type CampaignMission } from './campaign'
import { awardReward } from './rewards'
import { characterForXp } from './progression'
import { createLocalStorageAdapter, createMemoryStorage, defaultSave, validateSave } from './save'

const shipped = (name: string) => JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown
const catalog = () => {
  const missions = validateMissions(shipped('missions'))
  if (!missions.ok) throw missions.error
  return missions.value.map(({ id, zoneId, order, rewardId, arenaId }) => ({ id, zoneId, order, rewardId, arenaId })) satisfies CampaignMission[]
}
const mapFor = (mission: CampaignMission) => parseArenaContent(shipped(mission.arenaId!))
const catalogOptions = (missions: readonly CampaignMission[]) => ({ campaignCatalog: {
  missions,
  missionIds: new Set(missions.map(({ id }) => id)),
  rewardIds: new Set(missions.map(({ rewardId }) => rewardId)),
  arenaIds: new Set(missions.map(({ arenaId }) => arenaId!)),
  rewardIdForMission: (id: string) => missions.find((entry) => entry.id === id)?.rewardId,
  arenaIdForMission: (id: string) => missions.find((entry) => entry.id === id)?.arenaId,
} })

const runtimeUnits = (mission: CampaignMission) => mapFor(mission).units.map((unit) => ({
  ...unit,
  ap: unit.team === 'player' ? 10 : 0,
}))

const validateSaveWithoutCatalog = (save: ReturnType<typeof defaultSave>) => validateSave({ ...save, campaign: { ...save.campaign, catalogId: '' } }).ok

describe('M3-B encounter runtime integration', () => {
  it('passes the loaded equipment catalog to every initialUnits recovery/reset path', () => {
    const app = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8')
    const calls = app.split('\n').filter((line) => line.includes('initialUnits('))
    expect(calls).toHaveLength(4)
    expect(calls.every((line) => line.includes('equipment') || line.includes('catalog.equipment'))).toBe(true)
  })


  it('retries a failed mission from mission select and preserves locked/available/completed rules', () => {
    const missions = catalog()
    const initial = createCampaign(missions, 'test-catalog')
    const available = startMission(initial, missions[0].id, missions)
    const failed = missionDefeat(available)
    const missionSelect = { ...returnFromMission(failed), screen: 'mission-select' as const }
    const retried = startMission(missionSelect, missions[0].id, missions)

    expect(retried).not.toBe(missionSelect)
    expect(retried.screen).toBe('mission')
    expect(retried.activeMissionId).toBe(missions[0].id)
    expect(retried.mission.status).toBe('active')

    expect(startMission(initial, missions[1].id, missions)).toBe(initial)
    const completed = missionVictory(available, missions)
    expect(startMission(completed, missions[0].id, missions)).toBe(completed)
    expect(startMission(completed, missions[1].id, missions)).not.toBe(completed)
  })

  it('requires the manifest and mission arena IDs to match exactly', () => {
    const missions = catalog()
    const maps = missions.map(mapFor)
    const manifest = { contentVersion: 1, kind: 'arena-manifest', catalogId: 'test', entries: maps.map((map) => ({ id: map.id, path: map.id })) }
    const extra = { ...maps[0], id: 'extra-map' }
    expect(() => validateArenaCatalog(
      { ...manifest, entries: [...manifest.entries, { id: extra.id, path: extra.id }] },
      [...maps, extra],
      new Set(missions.map((mission) => mission.arenaId!)),
    )).toThrow()
    expect(() => validateArenaCatalog(
      manifest,
      maps,
      new Set([...missions.map((mission) => mission.arenaId!), 'missing-map']),
    )).toThrow()
  })

  it('rejects a malformed save without a runtime campaign catalog', () => {
    const missions = catalog()
    const save = defaultSave(missions[0].arenaId!, runtimeUnits(missions[0]), undefined, missions)
    expect(validateSaveWithoutCatalog(save)).toBe(false)
  })
  it('parses every shipped encounter map through the active catalog validator', () => {
    const missions = catalog()
    const maps = missions.map(mapFor)
    const validated = validateArenaCatalog(maps, new Set(missions.map((mission) => mission.arenaId)))
    expect(validated.all.map((entry) => entry.id)).toEqual(missions.map((mission) => mission.arenaId))
  })

  it('selects every catalog map using only that map’s data, without stale map or unit state', () => {
    const missions = catalog()
    let campaign = createCampaign(missions, 'test-catalog')
    let priorArenaId: string | null = null

    for (const mission of missions) {
      campaign = startMission(campaign, mission.id, missions)
      const arena = mapFor(mission)
      const units = runtimeUnits(mission)
      const save = {
        ...defaultSave(arena.id, units, undefined, missions),
        activeEncounterId: mission.id,
        campaign,
        /* Save v5: progression is derived from campaign XP, which the reward claims below grow. */
        character: characterForXp(campaign.xp),
      }
      const adapter = createLocalStorageAdapter(createMemoryStorage(), catalogOptions(missions))

      expect(save.arenaId).toBe(mission.arenaId)
      expect(save.campaign.activeMapId).toBe(mission.arenaId)
      expect(save.units).toEqual(units.map((unit) => ({ ...unit, statuses: unit.statuses ?? {} })))
      expect(save.units.map(({ id }) => id)).toEqual(arena.units.map(({ id }) => id))
      if (priorArenaId) expect(save.arenaId).not.toBe(priorArenaId)
      expect(save.units.filter((unit) => !arena.units.some((expected) => expected.id === unit.id))).toEqual([])
      expect(adapter.save(save)).toBe(true)
      expect(adapter.load(undefined, catalogOptions(missions))).toMatchObject({
        ok: true,
        value: { arenaId: mission.arenaId, units, campaign: { activeMapId: mission.arenaId } },
      })

      priorArenaId = save.arenaId
      campaign = claimReward(missionVictory(campaign, missions), mission.rewardId, 1)
    }
  })

  it('awards a completed encounter exactly once and never on defeat', () => {
    const missions = catalog()
    const firstMission = missions[0]
    const initial = defaultSave(firstMission.arenaId, [], undefined, missions)
    const active = startMission(initial.campaign, firstMission.id, missions)
    const defeated = missionDefeat(active)
    expect(claimReward(defeated, firstMission.rewardId, 30)).toBe(defeated)
    const victorious = missionVictory(active, missions)
    const reward = { id: firstMission.rewardId, xp: 30, resources: { metal: 2 }, items: [], oneTime: true }
    const first = awardReward(initial.inventory, reward, victorious.claimedRewards)
    const claimed = claimReward(victorious, reward.id, first.xp)
    const second = awardReward(first.inventory, reward, claimed.claimedRewards)
    expect(claimed.xp).toBe(30)
    expect(second.alreadyClaimed).toBe(true)
    expect(second.inventory).toBe(first.inventory)
  })
})
