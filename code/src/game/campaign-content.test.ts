import { describe, expect, it } from 'vitest'
import { CONTENT_VERSION } from './content-format'
import { validateBaseUpgrades, validateCampaignCatalog, validateMissions, validateRecipes, validateRewards } from './campaign-content'

describe('data-driven M2 catalog contracts', () => {
  /* W6-01: a `secure` mission now has to carry the parameters its objective actually needs. Before
     the objective runtime this fixture was accepted with none, which is precisely the gap that let
     `retrieve`/`escape` ship as renamed cleanups. */
  const secureParams = { zone: { x: 3, y: 2 }, radius: 1, holdTurns: 3 }
  const mission = { contentVersion: CONTENT_VERSION, kind: 'missions', entries: [{ id: 'near-perimeter', zoneId: 'near-perimeter', name: 'Signal', objective: 'secure', objectiveParams: secureParams, arenaId: 'dusty-perimeter', difficulty: 0, rewardId: 'near-perimeter-clear' }] }
  const reward = { contentVersion: CONTENT_VERSION, kind: 'rewards', entries: [{ id: 'near-perimeter-clear', name: 'Clear', xp: 80, resources: { metal: 3, cloth: 2 }, items: [{ id: 'field-bandage', quantity: 1, weight: 1 }], oneTime: true }] }
  it('validates linked mission and reward records from versioned JSON', () => { const missions = validateMissions(mission); const rewards = validateRewards(reward); expect(missions).toMatchObject({ ok: true, value: [{ rewardId: 'near-perimeter-clear' }] }); expect(rewards).toMatchObject({ ok: true, value: [{ id: 'near-perimeter-clear', xp: 80 }] }) })
  it('validates the active recipe and upgrade schema rather than UI hardcodes', () => { expect(validateRecipes({ contentVersion: 1, kind: 'recipes', entries: [{ id: 'bandage', name: 'Bandage', node: 'workbench', nodeLevel: 1, cost: { cloth: 1 }, output: { itemId: 'field-bandage', quantity: 1 }, description: 'test' }] }).ok).toBe(true); expect(validateBaseUpgrades({ contentVersion: 1, kind: 'base-upgrades', entries: [{ id: 'stash-2', name: 'Stash L2', node: 'stash', targetLevel: 2, cost: { metal: 5 }, effect: { kind: 'stash-capacity', capacityBonus: 10 }, description: 'test' }] }).ok).toBe(true) })
  it('rejects recipe and reward item references outside the item catalog', () => {
    const items = [{ id: 'field-bandage', name: 'Bandage', weight: 1, kind: 'consumable' as const }]
    const recipes = validateRecipes({ contentVersion: 1, kind: 'recipes', entries: [{ id: 'bandage', name: 'Bandage', node: 'workbench', nodeLevel: 1, cost: { cloth: 1 }, output: { itemId: 'missing-item', quantity: 1 }, description: 'test' }] })
    const rewards = validateRewards({ ...reward, entries: [{ ...reward.entries[0], items: [{ id: 'missing-item', quantity: 1, weight: 1 }] }] })
    if (!recipes.ok || !rewards.ok) throw new Error('expected valid child content')
    const result = validateCampaignCatalog({ zones: [{ id: 'near-perimeter', name: 'Near', order: 1, description: 'test', unlocked: true }], missions: [{ id: 'near-perimeter', zoneId: 'near-perimeter', order: 1, name: 'Signal', description: 'test', objective: 'secure' as const, objectiveParams: { kind: 'secure' as const, ...secureParams }, arenaId: 'dusty-perimeter', difficulty: 0, rewardId: 'near-perimeter-clear' }], rewards: rewards.value, items, recipes: recipes.value }, new Set(['dusty-perimeter']), new Set(items.map((item) => item.id)))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['recipes.bandage.output.itemId', 'rewards.near-perimeter-clear.items.missing-item']))
  })
})

