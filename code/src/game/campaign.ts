/** Pure, catalog-driven M3-B campaign transitions. */
export type CampaignScreen = 'home' | 'mission-select' | 'mission' | 'reward' | 'return'
export type MissionStatus = 'locked' | 'available' | 'active' | 'completed' | 'failed'
export interface MissionProgress { id: string; status: MissionStatus; victories: number; firstRewardClaimed: boolean; mapId: string; arenaId: string; rewardId: string }
export interface ZoneProgress { id: string; status: 'available' | 'completed' }
/**
 * Why the `return` screen has to record *how* it was reached (W4-02).
 *
 * Up to save v4 a retreat was literally `missionDefeat`, so the two were indistinguishable in
 * state. Once a defeat costs XP that is no longer acceptable: the penalty is charged when the
 * player leaves the return screen, and by then the only thing that can say whether the operative
 * was knocked out or walked away is the campaign itself. `null` outside the return screen, and the
 * save validator enforces that biconditional.
 */
export type ReturnReason = 'defeat' | 'retreat' | null
export interface CampaignState { catalogId: string; screen: CampaignScreen; activeMissionId: string | null; activeMapId: string | null; mission: MissionProgress; encounters: MissionProgress[]; zone: ZoneProgress; firstDeathReturnUsed: boolean; returnReason: ReturnReason; xp: number; claimedRewards: string[] }
export interface CampaignMission { id: string; zoneId: string; order: number; rewardId: string; mapId?: string; arenaId?: string }

const ordered = (missions: readonly CampaignMission[]) => [...missions].sort((a, b) => a.order - b.order)
const mapIdOf = (mission: CampaignMission) => mission.arenaId ?? mission.mapId ?? mission.id
const requireMissions = (missions: readonly CampaignMission[]) => {
  const sequence = ordered(missions)
  if (!sequence.length) throw new Error('Campaign catalog must contain at least one mission.')
  if (sequence.some((mission) => !mission.id || !mission.zoneId || !mission.rewardId || !mapIdOf(mission))) throw new Error('Campaign catalog contains an invalid mission.')
  return sequence
}
const current = (state: CampaignState) => state.encounters.find((mission) => mission.id === state.activeMissionId) ?? state.encounters.find((mission) => mission.id === state.mission.id) ?? state.mission
const replaceCurrent = (state: CampaignState, mission: MissionProgress): CampaignState => ({ ...state, mission, encounters: state.encounters.map((entry) => entry.id === mission.id ? mission : entry) })

const progressFor = (entry: CampaignMission, status: MissionStatus, victories = 0, firstRewardClaimed = false): MissionProgress => ({ id: entry.id, rewardId: entry.rewardId, mapId: mapIdOf(entry), arenaId: mapIdOf(entry), status, victories, firstRewardClaimed })

export function createCampaign(missions: readonly CampaignMission[], catalogId: string): CampaignState {
  const sequence = requireMissions(missions)
  if (!catalogId) throw new Error('Campaign catalog must have an id.')
  const first = sequence[0]
  const encounters = sequence.map((entry, index) => progressFor(entry, index === 0 ? 'available' : 'locked'))
  return { catalogId, screen: 'home', activeMissionId: null, activeMapId: null, mission: encounters[0], encounters, zone: { id: first.zoneId, status: 'available' }, firstDeathReturnUsed: false, returnReason: null, xp: 0, claimedRewards: [] }
}
export function startMission(state: CampaignState, missionId: string = state.mission.id, missions: readonly CampaignMission[] = state.encounters.map((entry, order) => ({ id: entry.id, zoneId: state.zone.id, order: order + 1, rewardId: entry.rewardId, arenaId: entry.arenaId }))): CampaignState { const definition = missions.find((entry) => entry.id === missionId); const progress = state.encounters.find((entry) => entry.id === missionId) ?? (state.mission.id === missionId ? state.mission : null); if (!definition || !progress || (progress.status !== 'available' && progress.status !== 'failed')) return state; return replaceCurrent({ ...state, screen: 'mission', activeMissionId: missionId, activeMapId: mapIdOf(definition) }, { ...progress, mapId: mapIdOf(definition), status: 'active' }) }
export function missionVictory(state: CampaignState, missions: readonly CampaignMission[] = state.encounters.map((entry, order) => ({ id: entry.id, zoneId: state.zone.id, order: order + 1, rewardId: entry.rewardId, arenaId: entry.arenaId }))): CampaignState { const progress = current(state); if (state.screen !== 'mission' || progress.status !== 'active') return state; const completed = { ...progress, status: 'completed' as const, victories: progress.victories + 1 }; const list = requireMissions(missions); const position = list.findIndex((mission) => mission.id === progress.id); const next = list[position + 1]; let result = replaceCurrent({ ...state, screen: 'reward' }, completed); if (next) result = { ...result, encounters: result.encounters.map((entry) => entry.id === next.id && entry.status === 'locked' ? { ...entry, status: 'available' } : entry) }; else result = { ...result, zone: { ...result.zone, status: 'completed' } }; return result }
const failMission = (state: CampaignState, reason: Exclude<ReturnReason, null>): CampaignState => { const progress = current(state); return state.screen === 'mission' && progress.status === 'active' ? replaceCurrent({ ...state, screen: 'return', returnReason: reason }, { ...progress, status: 'failed' }) : state }
export const missionDefeat = (state: CampaignState): CampaignState => failMission(state, 'defeat')
/**
 * Explicit voluntary exit from an active encounter. Shares the encounter bookkeeping with a defeat
 * — the encounter is `failed`, the campaign moves to `return` and no reward becomes claimable —
 * but the hero is evacuated instead of being knocked out, so the surviving HP/statuses are carried
 * by the caller. This is the only safe way out of a combat soft lock (no ammo, no valid attack).
 *
 * Since W4-02 the two are **no longer the same transition**: a retreat records
 * `returnReason: 'retreat'`, costs no XP and does not consume the free-death allowance, while a
 * defeat records `'defeat'` and is charged by `deathPenalty`. Losing the reward is the cost of
 * retreating; losing XP as well is the cost of being knocked out.
 */
export const retreatFromMission = (state: CampaignState): CampaignState => failMission(state, 'retreat')
export const canRetreatFromMission = (state: CampaignState): boolean => state.screen === 'mission' && current(state).status === 'active'
export function claimReward(state: CampaignState, rewardKey: string, xp: number, missions: readonly CampaignMission[] = state.encounters.map((entry, order) => ({ id: entry.id, zoneId: state.zone.id, order: order + 1, rewardId: entry.rewardId, arenaId: entry.arenaId }))): CampaignState { const progress = current(state); const definition = requireMissions(missions).find((mission) => mission.id === progress.id); if (state.screen !== 'reward' || progress.status !== 'completed' || !definition || definition.rewardId !== rewardKey || state.claimedRewards.includes(definition.rewardId)) return state; return replaceCurrent({ ...state, screen: 'home', activeMissionId: null, activeMapId: null, xp: state.xp + xp, claimedRewards: [...state.claimedRewards, definition.rewardId] }, { ...progress, firstRewardClaimed: true }) }

export const isRewardClaimable = (state: CampaignState, rewardKey: string) => { const progress = current(state); return state.screen === 'reward' && progress.status === 'completed' && progress.rewardId === rewardKey && !state.claimedRewards.includes(rewardKey) }
export const returnFromMission = (state: CampaignState): CampaignState => state.screen === 'return' ? { ...state, screen: 'home', activeMissionId: null, activeMapId: null, returnReason: null } : state
export const retryMission = (state: CampaignState, missions: readonly CampaignMission[]): CampaignState => state.screen === 'return' ? startMission(replaceCurrent({ ...state, returnReason: null }, { ...current(state), status: 'available' }), current(state).id, missions) : state
/**
 * Leaves the return screen and consumes the one free defeat — **only** for an actual defeat. A
 * retreat may not spend the allowance: it already pays with the lost reward, and letting a
 * voluntary exit burn the free death would make the first real knockout arbitrarily expensive.
 * The XP side of the same transition lives in `progression.ts` (`resolveDefeatReturn`).
 */
export const firstDeathReturn = (state: CampaignState): CampaignState => state.screen === 'return' && state.returnReason === 'defeat' && !state.firstDeathReturnUsed ? { ...returnFromMission(state), firstDeathReturnUsed: true } : returnFromMission(state)
export const missionProgress = (state: CampaignState, missionId: string) => state.encounters.find((mission) => mission.id === missionId) ?? null
export const campaignMissions = (state: CampaignState) => state.encounters

