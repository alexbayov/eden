import { describe, expect, it } from 'vitest'
import { resolveCombatShortcut } from './input-gating'
import { retreatFromMission, startMission } from './campaign'
import { applyEnemyArchetype, hydrateArenaUnits, parseEquipmentCatalog } from './equipment-content'
import { calculateDamage, calculateHitBreakdown, runEnemyTurn, type Unit } from './combat'
import { parseArenaContent } from './content'
import { defaultSave, validateSave } from './save'
import { resolveEnemyPhase } from './session'
import { readFileSync } from 'node:fs'

const shipped = (name: string) => JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown
const missions = [
  { id: 'perimeter-checkpoint', zoneId: 'near-perimeter', order: 1, rewardId: 'perimeter-checkpoint-clear', arenaId: 'perimeter-checkpoint' },
  { id: 'collapsed-yard', zoneId: 'near-perimeter', order: 2, rewardId: 'collapsed-yard-clear', arenaId: 'collapsed-yard' },
  { id: 'relay-station', zoneId: 'near-perimeter', order: 3, rewardId: 'relay-station-clear', arenaId: 'relay-station' },
]
const catalog = { campaignCatalog: {
  catalogId: 'm3-d-test', missions, missionIds: new Set(missions.map((mission) => mission.id)), rewardIds: new Set(missions.map((mission) => mission.rewardId)), arenaIds: new Set(missions.map((mission) => mission.arenaId)),
  rewardIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.rewardId,
  arenaIdForMission: (id: string) => missions.find((mission) => mission.id === id)?.arenaId,
} }
const hero = (overrides: Partial<Unit> = {}): Unit => ({ id: 'hero', name: 'Hero', team: 'player', x: 0, y: 0, hp: 24, maxHp: 24, aim: 72, color: '#fff', ap: 10, statuses: {}, ...overrides })
const enemy = (): Unit => ({ id: 'enemy', name: 'Enemy', team: 'enemy', x: 3, y: 0, hp: 18, maxHp: 18, aim: 62, color: '#f00', ap: 0, statuses: {} })

/** Regression suite for M3-D critic P0/P1 remediation. */
describe('M3-D state, escape, balance, and persistence regressions', () => {
  it('dispatching E on home is a no-op: it cannot resolve enemy phase or damage the hero', () => {
    const save = defaultSave('perimeter-checkpoint', [hero(), enemy()], undefined, missions)
    const impossible = { ...save, phase: 'enemy' as const }
    expect(resolveCombatShortcut({ key: 'E' }, 'home', 'enemy')).toBeNull()
    expect(resolveEnemyPhase(impossible, { contentVersion: 1, id: 'perimeter-checkpoint', name: 'Arena', width: 5, height: 2, tile: { width: 1, height: 1 }, units: [hero(), enemy()], cover: [] })).toBe(impossible)
    expect(impossible.units.find((unit) => unit.id === 'hero')?.hp).toBe(24)
  })

  it('rejects home and mission-select enemy/victory/defeat saves as impossible', () => {
    const save = defaultSave('perimeter-checkpoint', [hero()], undefined, missions)
    for (const screen of ['home', 'mission-select'] as const) {
      for (const phase of ['enemy', 'victory', 'defeat'] as const) {
        expect(validateSave({ ...save, phase, campaign: { ...save.campaign, screen } }, catalog).ok).toBe(false)
      }
    }
  })

  it('retreat exits an active mission as failed without making a reward claimable', () => {
    const save = defaultSave('perimeter-checkpoint', [hero({ hp: 7, statuses: { arm: 2 } })], undefined, missions)
    const active = startMission(save.campaign, 'perimeter-checkpoint', missions)
    const retreated = retreatFromMission(active)
    expect(retreated).toMatchObject({ screen: 'return', mission: { status: 'failed', firstRewardClaimed: false }, claimedRewards: [] })
    expect(retreated.encounters[0]).toMatchObject({ status: 'failed', firstRewardClaimed: false })
  })

  it('keeps relay defender damage below a one-hit kill at difficulty 1, including a critical torso hit', () => {
    const equipment = parseEquipmentCatalog(shipped('equipment'))
    const relay = parseArenaContent(shipped('relay-station'))
    const units = relay.units.map((unit) => applyEnemyArchetype({ ...unit, ap: unit.team === 'enemy' ? 10 : 0 }, equipment))
    const defender = units.find((unit) => unit.id === 'relay-defender')!
    const operative = units.find((unit) => unit.id === 'hero')!
    expect(calculateDamage(defender, operative, 'torso', true)).toBeLessThan(operative.hp)
    expect(calculateHitBreakdown(defender, operative, 'torso', 'none').final).toBeLessThanOrEqual(80)
    const result = runEnemyTurn([operative, defender], relay.width, relay.height, relay.cover.map((cover) => ({ ...cover, kind: cover.type })), () => 1)
    expect(result.units.find((unit) => unit.id === 'hero')?.hp).toBeGreaterThan(0)
  })

  it('carries surviving hero HP/statuses into next encounters and retries reset a defeated template', () => {
    const equipment = parseEquipmentCatalog(shipped('equipment'))
    const first = parseArenaContent(shipped('perimeter-checkpoint'))
    const next = parseArenaContent(shipped('collapsed-yard'))
    const prior = first.units.map((unit) => unit.id === 'hero' ? { ...unit, ap: 0, hp: 9, statuses: { arm: 2, blind: 1 } } : { ...unit, ap: 0 })
    const continued = hydrateArenaUnits({ units: next.units }, equipment, defaultSave(first.id, prior, undefined, missions).inventory, prior)
    expect(continued.find((unit) => unit.id === 'hero')).toMatchObject({ hp: 9, statuses: { arm: 2, blind: 1 } })
    const defeated = [...prior.map((unit) => unit.id === 'hero' ? { ...unit, hp: 0, statuses: { arm: 2 } } : unit)]
    const retried = hydrateArenaUnits({ units: next.units }, equipment, defaultSave(first.id, defeated, undefined, missions).inventory, defeated)
    expect(retried.find((unit) => unit.id === 'hero')).toMatchObject({ hp: 24, statuses: {} })
  })
})
