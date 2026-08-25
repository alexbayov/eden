/**
 * W5-05 — the **pure** loot penalty of a defeat: part of what the operative was *carrying* is lost.
 *
 * The whole ticket is one guarantee about scope, so it is expressed as the module's boundary rather
 * than as a comment on a caller:
 *
 *   - only `inventory.backpack` is read and written;
 *   - `inventory.stash` is **never** touched (criterion 2) — the base is safe by construction, not
 *     by remembering to skip it;
 *   - `inventory.equipment` is never touched: worn gear is not lost (doc 07 §7.7 "Что НЕ теряется"),
 *     and durability is combat's business;
 *   - `backpackCapacity` is unchanged;
 *   - quick slots are pruned as a consequence of the backpack shrinking, never edited directly.
 *
 * **No escalation.** Nothing here reads a death counter, and the policy has no per-death dimension
 * to read: one flat rule for every encounter (criterion 3, and the audit ban restated in doc 07
 * §7.7). **The free first death is the caller's**: this function applies the policy it is given,
 * unconditionally. `campaign.firstDeathReturnUsed` and `campaign.returnReason` live in
 * `campaign.ts`, `deathPenalty` already reads them for the XP half, and duplicating that decision
 * here would create a second place where "was this death free?" is answered — the exact
 * two-sources-of-truth failure the XP penalty was consolidated to avoid. `shouldApplyBackpackLoss`
 * states the intended pairing without taking the decision away from the caller.
 *
 * **Deterministic.** Same inventory + same policy + same selection = same result, byte for byte.
 * The default selection uses no randomness at all; `rngLossSelection` is available for a randomised
 * variant and is itself a pure function of its seed, threading the next state out in the result so a
 * caller cannot accidentally reuse a seed.
 *
 * Because the function is pure, **the preview and the application are the same call**: the return
 * value carries the exact list of what was lost, so a return screen can render it and then commit
 * the identical `inventory` (criterion 4) instead of computing the loss twice.
 */
import type { ReturnReason } from './campaign'
import {
  RESOURCE_IDS,
  removeItem,
  removeResource,
  type Inventory,
  type PoolId,
  type ResourceId,
  type Stack,
} from './inventory'
import { nextRandom } from './rng'

/**
 * The approved-rule shaped policy. Every field is a decision, so none of them has a value here.
 *
 * `protectedItemIds` exists because doc 07 §7.7 keeps quest/key items out of the penalty; it is a
 * list of ids rather than a "weightless" heuristic, since weight-0 loot is not the same concept.
 */
export interface BackpackLossPolicy {
  /** Share of carried units lost, in `[0, 1]`. Flat: there is no per-death dimension. */
  rate: number
  /** Whether raw resources may be taken. */
  loseResources: boolean
  /** Whether items (consumables, found loot) may be taken. */
  loseItems: boolean
  /** Item ids the penalty may never take. */
  protectedItemIds: readonly string[]
}

/**
 * A concrete policy for tests and callers, explicitly **not approved**.
 *
 * 30% is the first tier of the cancelled escalation table in doc 07 §7.7, i.e. the mildest number
 * that document ever proposed, and it is used here *without* the tiers above it. Naming it
 * `PROPOSED_` rather than `DEFAULT_` is deliberate: decision **D-01** has not been taken by the
 * owner, no shipped screen calls this module yet, and a name suggesting a default would quietly turn
 * an implementation's guess into the game's balance.
 */
export const PROPOSED_BACKPACK_LOSS_POLICY: BackpackLossPolicy = {
  rate: 0.3,
  loseResources: true,
  loseItems: true,
  protectedItemIds: [],
}

/** Backpack kinds the penalty can draw from. Mirrors `Container`'s two lists. */
export type LossKind = 'resources' | 'items'

/** One stack the policy is allowed to take from, in a stable order. */
export interface LossCandidate {
  kind: LossKind
  id: string
  quantity: number
  weight: number
}

/** What one stack actually lost. */
export interface LossEntry extends LossCandidate {
  /** Units taken from this stack; always `1..quantity`. */
  lost: number
}

/**
 * A selection's answer: how many units each candidate pays, parallel to the candidate array.
 * `rngState` is threaded back when the selection consumed randomness, so the caller can persist it.
 */
export interface LossPlan {
  units: readonly number[]
  rngState?: number
}

export type LossSelection = (candidates: readonly LossCandidate[], units: number) => LossPlan

export type BackpackLossFailure =
  /** `rate` outside `[0, 1]`, or not a finite number. */
  | 'invalid-policy'
  /** A selection that does not spend exactly the required units, or over-draws a stack. */
  | 'invalid-selection'

export interface BackpackLoss {
  inventory: Inventory
  /** Exactly what was taken, in candidate order. Empty when the policy takes nothing. */
  lost: LossEntry[]
  /** Units taken in total; `lost.reduce(...)`, precomputed for the return screen. */
  lostUnits: number
  /** Units that were eligible, i.e. the denominator the rate was applied to. */
  carriedUnits: number
  /** Present only when the selection consumed randomness. */
  rngState?: number
}

export type BackpackLossResult =
  | { ok: true; value: BackpackLoss }
  | { ok: false; reason: BackpackLossFailure; inventory: Inventory }

/**
 * The pairing this penalty is meant to have with the XP one, as a *statement* the caller may use:
 * only an actual defeat costs loot, and the free first death costs nothing. Retreating already pays
 * with the forfeited reward (see `retreatFromMission`), so charging it loot as well would make the
 * only escape from a soft-locked encounter the most expensive exit in the game.
 *
 * Kept as a predicate over the two fields rather than reading a `CampaignState`, so it cannot drift
 * into being "the" decision: `deathPenalty` remains the single reader of campaign state.
 */
export const shouldApplyBackpackLoss = (reason: ReturnReason, firstDeathReturnUsed: boolean): boolean =>
  reason === 'defeat' && firstDeathReturnUsed

const resourceOrder = new Map<string, number>(RESOURCE_IDS.map((id, index) => [id, index]))

/**
 * Eligible stacks in a total, content-independent order: resources first in `RESOURCE_IDS` order,
 * then items by id. A stable order is what makes the whole function deterministic — an order derived
 * from insertion into the backpack would make the loss depend on pickup history.
 */
export function lossCandidates(inventory: Inventory, policy: BackpackLossPolicy): LossCandidate[] {
  const protectedIds = new Set(policy.protectedItemIds)
  const of = (kind: LossKind, stacks: readonly Stack[]): LossCandidate[] =>
    stacks
      .filter((stack) => stack.quantity > 0 && !(kind === 'items' && protectedIds.has(stack.id)))
      .map((stack) => ({ kind, id: stack.id, quantity: stack.quantity, weight: stack.weight }))
  const resources = policy.loseResources ? of('resources', inventory.backpack.resources) : []
  const items = policy.loseItems ? of('items', inventory.backpack.items) : []
  return [
    ...resources.sort((left, right) => (resourceOrder.get(left.id) ?? 0) - (resourceOrder.get(right.id) ?? 0)),
    ...items.sort((left, right) => left.id.localeCompare(right.id)),
  ]
}

/**
 * Units the policy takes from a backpack carrying `carried` units.
 *
 * Floored, not rounded up. A backpack too small for the rate to reach one whole unit therefore
 * loses **nothing**, which is intentional: the audit's objection to the historical penalty was that
 * it felt unfair, and taking the last bandage off a nearly-empty backpack is the shape of that
 * unfairness. Flooring also keeps the penalty monotone in what was carried — carrying more can never
 * cost proportionally less.
 */
export const lossUnitsFor = (carried: number, rate: number) =>
  Math.max(0, Math.min(carried, Math.floor(carried * rate)))

const validPlan = (candidates: readonly LossCandidate[], plan: LossPlan, units: number) =>
  plan.units.length === candidates.length &&
  plan.units.every((count, index) => Number.isInteger(count) && count >= 0 && count <= candidates[index].quantity) &&
  plan.units.reduce((sum, count) => sum + count, 0) === units

/**
 * The default, randomness-free selection: proportional loss by the largest-remainder method.
 *
 * Every stack pays `floor(quantity × share)` and the units left over by flooring go to the stacks
 * with the largest fractional remainder, ties broken by candidate order. This spreads the penalty
 * across the backpack instead of emptying one stack, which is both the readable outcome for a player
 * ("I lost some of everything") and the one that cannot be gamed by splitting loot.
 */
export const proportionalLossSelection: LossSelection = (candidates, units) => {
  const carried = candidates.reduce((sum, candidate) => sum + candidate.quantity, 0)
  if (units <= 0 || carried <= 0) return { units: candidates.map(() => 0) }
  const share = units / carried
  const exact = candidates.map((candidate) => candidate.quantity * share)
  const base = exact.map((value) => Math.floor(value))
  let remaining = units - base.reduce((sum, value) => sum + value, 0)
  const byRemainder = candidates
    .map((candidate, index) => ({ index, remainder: exact[index] - base[index], capacity: candidate.quantity - base[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const entry of byRemainder) {
    if (remaining <= 0) break
    if (entry.capacity <= 0) continue
    const take = Math.min(entry.capacity, remaining)
    base[entry.index] += take
    remaining -= take
  }
  return { units: base }
}

/**
 * A randomised selection that is still fully deterministic: each unit is drawn from the remaining
 * eligible units with probability proportional to the stack's remaining size, using the shipped
 * `nextRandom` LCG. The advanced state is returned so the caller persists it exactly like the combat
 * rolls do; re-running with the same seed reproduces the same loss.
 *
 * The generator's `state` (32-bit) is used for the modulo rather than its `value` (1..100), because
 * `value` cannot address a backpack with more than 100 carried units without bias.
 */
export const rngLossSelection = (seed: number): LossSelection => (candidates, units) => {
  const remainingByIndex = candidates.map((candidate) => candidate.quantity)
  const taken = candidates.map(() => 0)
  let pool = remainingByIndex.reduce((sum, quantity) => sum + quantity, 0)
  let state = seed >>> 0
  for (let drawn = 0; drawn < units && pool > 0; drawn += 1) {
    const next = nextRandom(state)
    state = next.state
    let cursor = next.state % pool
    for (let index = 0; index < candidates.length; index += 1) {
      if (cursor < remainingByIndex[index]) {
        remainingByIndex[index] -= 1
        taken[index] += 1
        pool -= 1
        break
      }
      cursor -= remainingByIndex[index]
    }
  }
  return { units: taken, rngState: state }
}

/**
 * Applies the loot penalty to the backpack.
 *
 * Atomic: the plan is validated in full before the first stack is touched, and every removal goes
 * through `removeResource`/`removeItem` on the `backpack` pool, so a rejected plan leaves the
 * inventory identical (`result.inventory === inventory`) and an accepted one applies completely.
 * `removeItem` on the backpack prunes the quick slots, so a slot whose item was taken clears itself.
 */
export function applyBackpackDeathLoss(
  inventory: Inventory,
  policy: BackpackLossPolicy,
  selection: LossSelection = proportionalLossSelection,
): BackpackLossResult {
  if (typeof policy.rate !== 'number' || !Number.isFinite(policy.rate) || policy.rate < 0 || policy.rate > 1)
    return { ok: false, reason: 'invalid-policy', inventory }
  const candidates = lossCandidates(inventory, policy)
  const carriedUnits = candidates.reduce((sum, candidate) => sum + candidate.quantity, 0)
  const units = lossUnitsFor(carriedUnits, policy.rate)
  const plan = units > 0 ? selection(candidates, units) : { units: candidates.map(() => 0) }
  if (!validPlan(candidates, plan, units)) return { ok: false, reason: 'invalid-selection', inventory }

  const pool: PoolId = 'backpack'
  let next = inventory
  const lost: LossEntry[] = []
  for (const [index, candidate] of candidates.entries()) {
    const count = plan.units[index]
    if (count <= 0) continue
    const removed = candidate.kind === 'resources'
      ? removeResource(next, candidate.id as ResourceId, count, pool)
      : removeItem(next, candidate.id, count, pool)
    /* Unreachable while the plan is valid, because every count is bounded by the stack it came from;
       treated as a rejected transaction rather than trusted, so a future selection bug cannot half-
       apply a penalty. */
    if (!removed.ok) return { ok: false, reason: 'invalid-selection', inventory }
    next = removed.inventory
    lost.push({ ...candidate, lost: count })
  }
  return {
    ok: true,
    value: {
      /* Identity of the untouched halves is preserved on purpose: `stash`/`equipment` are the same
         objects, and a penalty that takes nothing returns the *same* inventory, which makes "the base
         was not touched" and "nothing happened" checkable by reference rather than only by value. */
      inventory: lost.length === 0 ? inventory : { ...next, stash: inventory.stash, equipment: inventory.equipment },
      lost,
      lostUnits: lost.reduce((sum, entry) => sum + entry.lost, 0),
      carriedUnits,
      ...(plan.rngState === undefined ? {} : { rngState: plan.rngState }),
    },
  }
}
