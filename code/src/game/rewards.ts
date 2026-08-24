import type { CampaignMission, CampaignState } from './campaign'
import { claimReward, isRewardClaimable } from './campaign'
import type { Inventory, ResourceId } from './inventory'
import { addItem, addResource } from './inventory'
import { DEFAULT_LEVEL_CURVE, awardXp, characterForXp, type CharacterState, type LevelCurve } from './progression'
export interface RewardItem { id: string; quantity: number; weight: number }
export interface Reward { id: string; xp: number; resources: Partial<Record<ResourceId, number>>; items: RewardItem[]; oneTime: boolean }
export interface AwardResult { inventory: Inventory; xp: number; awarded: string[]; overflow: string[]; alreadyClaimed: boolean }
export interface RewardTransition {
  campaign: CampaignState
  inventory: Inventory
  /** Progression after the XP award: level and unspent points resolved by `awardXp`. */
  character: CharacterState
  xp: number
  awarded: string[]
  overflow: string[]
  alreadyClaimed: boolean
  /** Levels gained by this claim, so the reward screen can report a level-up without recomputing. */
  levelsGained: number
  skillPointsGained: number
}
/** Mission rewards enter the unlimited base stash; no reward is silently dropped due to a field backpack limit. */
export function awardReward(inventory: Inventory, reward: Reward, claimedRewardIds: readonly string[]): AwardResult {
 if (reward.oneTime && claimedRewardIds.includes(reward.id)) return { inventory, xp: 0, awarded: [], overflow: [], alreadyClaimed: true }
 let next = inventory; const awarded: string[] = []
 for (const [id, quantity] of Object.entries(reward.resources) as [ResourceId, number][]) { const result = addResource(next, id, quantity, 1, 'stash'); next = result.inventory; if (result.stored) awarded.push(`${result.stored} ${id}`) }
 for (const item of reward.items) { const result = addItem(next, item.id, item.quantity, item.weight, 'stash'); next = result.inventory; if (result.stored) awarded.push(`${result.stored} ${item.id}`) }
 return { inventory: next, xp: reward.xp, awarded, overflow: [], alreadyClaimed: false }
}
/**
 * The one place a mission reward becomes progression (W4-01). `claimReward` still owns
 * `campaign.xp`; `awardXp` owns the level and the skill points, and the two are advanced in the
 * same transition so a save can never persist an XP total whose level was not recomputed.
 *
 * `character` is optional so callers without progression state in hand (older tests, the balance
 * simulator's scripted victories) keep working: the state is then derived from the campaign's XP,
 * which is exactly what the v4→v5 migration does.
 */
export function awardRewardTransition(campaign: CampaignState, inventory: Inventory, reward: Reward, missions: readonly CampaignMission[], character?: CharacterState, curve: LevelCurve = DEFAULT_LEVEL_CURVE): RewardTransition {
 const before = character ?? characterForXp(campaign.xp, curve)
 if (!isRewardClaimable(campaign, reward.id) || (reward.oneTime && campaign.claimedRewards.includes(reward.id))) return { campaign, inventory, character: before, xp: 0, awarded: [], overflow: [], alreadyClaimed: true, levelsGained: 0, skillPointsGained: 0 }
 const result = awardReward(inventory, reward, campaign.claimedRewards)
 const next = claimReward(campaign, reward.id, result.xp, missions)
 /* A refused claim must not advance progression either: `claimReward` returning the same state is
    the campaign's way of saying nothing happened. */
 if (next === campaign) return { campaign, inventory, character: before, xp: 0, awarded: [], overflow: [], alreadyClaimed: true, levelsGained: 0, skillPointsGained: 0 }
 const award = awardXp({ ...before, xp: campaign.xp }, result.xp, curve)
 return { campaign: next, inventory: result.inventory, character: award.character, xp: result.xp, awarded: result.awarded, overflow: result.overflow, alreadyClaimed: result.alreadyClaimed, levelsGained: award.levelsGained, skillPointsGained: award.skillPointsGained }
}
