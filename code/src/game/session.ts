import { advanceStatuses, runEnemyTurn, startTurn, type Unit } from './combat'
import { missionDefeat, type CampaignState } from './campaign'
import type { ArenaConfig } from './content'
import { nextRandom } from './rng'
import type { SaveAdapter, SaveData } from './save'
import { syncEquipmentInstances } from './equipment-content'

export function resolveEnemyPhase(save: SaveData, arena: ArenaConfig): SaveData {
 if (save.phase !== 'enemy') return save
 let rngState = save.rngState
 const roll = () => { const next = nextRandom(rngState); rngState = next.state; return next.value }
 const result = runEnemyTurn(save.units, arena.width, arena.height, arena.cover.map((cover) => ({ ...cover, kind: cover.type })), roll)
  const reconciledInventory = syncEquipmentInstances(save.inventory, result.units)
 if (result.heroDefeated) return { ...save, rngState, units: result.units, inventory: reconciledInventory, phase: 'defeat', campaign: missionDefeat(save.campaign) }
 const units: Unit[] = result.units.map((unit) => unit.id === 'hero' ? advanceStatuses(startTurn(unit)) : { ...unit, ap: 0 })
 return { ...save, rngState, units, inventory: syncEquipmentInstances(reconciledInventory, units), phase: 'player', turn: save.turn + 1 }
}
export function beginEnemyPhase(save: SaveData): SaveData | null {
  return save.phase === "player"
    ? { ...save, activeEncounterId: save.campaign.activeMissionId, phase: "enemy" }
    : null;
}
export const canBeginTransition = (locked: boolean, phase: SaveData['phase']) => !locked && phase === 'player'
export const campaignForDefeat = (campaign: CampaignState) => missionDefeat(campaign)
export type PersistTransition = { ok: true; value: SaveData } | { ok: false; error: string }
export function persistTransition(adapter: SaveAdapter, next: SaveData): PersistTransition {
 const result = adapter.saveDetailed(next)
 return result.ok ? { ok: true, value: next } : { ok: false, error: result.error ?? "unknown save failure" }
}
export function persistEnemyPhase(adapter: SaveAdapter, save: SaveData): SaveData | null { const enemy = beginEnemyPhase(save); return enemy && persistTransition(adapter, enemy).ok ? enemy : null }
export function resumePersistedEnemyPhase(adapter: SaveAdapter, save: SaveData, arena: ArenaConfig): SaveData | null { if (save.phase !== 'enemy') return save; const resolved = resolveEnemyPhase(save, arena); return persistTransition(adapter, resolved).ok ? resolved : null }

export interface EnemyPhaseCoordinator { begin: () => boolean; resolve: () => SaveData | null }
/** Application-level pure orchestration: persist the exact enemy snapshot before any timer is scheduled. */
export function createEnemyPhaseCoordinator(current: SaveData, adapter: SaveAdapter, schedule: (callback: () => void) => void, arena: ArenaConfig, onResolved: (save: SaveData) => void): EnemyPhaseCoordinator {
 let locked = false
 let snapshot: SaveData | null = null
 const resolve = () => {
  if (!snapshot) return null
  const resolved = resolveEnemyPhase(snapshot, arena)
  if (!persistTransition(adapter, resolved).ok) return null
  snapshot = null
  locked = false
  onResolved(resolved)
  return resolved
 }
 return {
  begin() {
   if (!canBeginTransition(locked, current.phase)) return false
   const enemy = beginEnemyPhase(current)
   if (!enemy || !persistTransition(adapter, enemy).ok) return false
   locked = true; snapshot = enemy; schedule(resolve); return true
  },
  resolve,
 }
}
