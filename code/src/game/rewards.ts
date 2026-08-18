import type { CampaignMission, CampaignState } from './campaign'
import { claimReward, isRewardClaimable } from './campaign'
import type { Inventory, ResourceId } from './inventory'
import { addItem, addResource } from './inventory'
export interface RewardItem { id: string; quantity: number; weight: number }
export interface Reward { id: string; xp: number; resources: Partial<Record<ResourceId, number>>; items: RewardItem[]; oneTime: boolean }
export interface AwardResult { inventory: Inventory; xp: number; awarded: string[]; overflow: string[]; alreadyClaimed: boolean }
export interface RewardTransition { campaign: CampaignState; inventory: Inventory; xp: number; awarded: string[]; overflow: string[]; alreadyClaimed: boolean }
/** Mission rewards enter the unlimited base stash; no reward is silently dropped due to a field backpack limit. */
export function awardReward(inventory: Inventory, reward: Reward, claimedRewardIds: readonly string[]): AwardResult {
 if (reward.oneTime && claimedRewardIds.includes(reward.id)) return { inventory, xp: 0, awarded: [], overflow: [], alreadyClaimed: true }
 let next = inventory; const awarded: string[] = []
 for (const [id, quantity] of Object.entries(reward.resources) as [ResourceId, number][]) { const result = addResource(next, id, quantity, 1, 'stash'); next = result.inventory; if (result.stored) awarded.push(`${result.stored} ${id}`) }
 for (const item of reward.items) { const result = addItem(next, item.id, item.quantity, item.weight, 'stash'); next = result.inventory; if (result.stored) awarded.push(`${result.stored} ${item.id}`) }
 return { inventory: next, xp: reward.xp, awarded, overflow: [], alreadyClaimed: false }
}
export function awardRewardTransition(campaign: CampaignState, inventory: Inventory, reward: Reward, missions: readonly CampaignMission[]): RewardTransition {
 if (!isRewardClaimable(campaign, reward.id) || (reward.oneTime && campaign.claimedRewards.includes(reward.id))) return { campaign, inventory, xp: 0, awarded: [], overflow: [], alreadyClaimed: true }
 const result = awardReward(inventory, reward, campaign.claimedRewards)
 return { campaign: claimReward(campaign, reward.id, result.xp, missions), inventory: result.inventory, xp: result.xp, awarded: result.awarded, overflow: result.overflow, alreadyClaimed: result.alreadyClaimed }
}
