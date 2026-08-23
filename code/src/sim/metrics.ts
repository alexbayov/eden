/**
 * Metric aggregation for the balance simulator (W3-02).
 *
 * Aggregation only — every input number was produced by the combat module during
 * `simulateBattle`. The metric list is the one W3-02 requires, and the JSON field names are the
 * ones fixed by docs/23 §8 so a report stays machine-comparable across runs.
 *
 * Two definitions worth stating because they change how the numbers read:
 *
 *   - **TTK is measured in player turns**, not shots or seconds: the player turn index on which an
 *     enemy of that archetype died. It is per archetype, so a two-enemy arena contributes two
 *     samples.
 *   - **Rates are per shot, not per battle.** `missRate`, `critRate` and `malfunctionRate` divide by
 *     the number of triggered shots. A jam consumes a round and AP but resolves no projectile, so it
 *     is excluded from the hit/miss denominator and counted only in `malfunctionRate`; otherwise
 *     jams would silently inflate the miss rate.
 */
import type { BattleResult } from './battle'

export interface Summary {
  count: number
  mean: number
  median: number
  min: number
  max: number
  /** Population standard deviation. */
  stdDev: number
}

export interface CombatMetrics {
  runs: number
  winRate: number
  lossRate: number
  ammoEmptyRate: number
  turnLimitRate: number
  retreatRate: number
  turnsMean: number
  turnsMedian: number
  turns: Summary
  ttkByArchetype: Record<string, number>
  ttkDetailByArchetype: Record<string, Summary>
  damageTakenMean: number
  damageTaken: Summary
  damageDealtMean: number
  heroHpEndMean: number
  ammoSpentMean: number
  ammoSpent: Summary
  ammoRemainingMean: number
  reloadsMean: number
  jamClearsMean: number
  weaponDurabilityLostMean: number
  armorDurabilityLostMean: number
  malfunctionRate: number
  critRate: number
  missRate: number
  hitRate: number
  executionRate: number
  shotsTotal: number
  resolvedShotsTotal: number
  malfunctionsTotal: number
  killRate: number
}

const round = (value: number, digits = 4) => {
  const factor = 10 ** digits
  /** `+0` normalises `-0`, which would otherwise serialise as `-0` and break byte equality. */
  return Math.round(value * factor) / factor + 0
}

export function summarize(values: readonly number[]): Summary {
  if (!values.length) return { count: 0, mean: 0, median: 0, min: 0, max: 0, stdDev: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length
  return {
    count: sorted.length,
    mean: round(mean),
    median: round(median),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    stdDev: round(Math.sqrt(variance)),
  }
}

const rate = (numerator: number, denominator: number) => (denominator === 0 ? 0 : round(numerator / denominator))
const meanOf = (values: readonly number[]) => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0)

export function aggregateCombat(results: readonly BattleResult[]): CombatMetrics {
  const runs = results.length
  const shots = results.flatMap((result) => result.shots)
  /* A jam resolves no projectile, so it is not part of the hit/miss denominator. */
  const resolved = shots.filter((shot) => !shot.malfunctioned)
  const turns = results.map((result) => result.turns)
  const ttkSamples = new Map<string, number[]>()
  for (const result of results)
    for (const [archetype, samples] of Object.entries(result.ttkTurnsByArchetype))
      ttkSamples.set(archetype, [...(ttkSamples.get(archetype) ?? []), ...samples])
  const archetypes = [...ttkSamples.keys()].sort()
  const outcomes = (kind: BattleResult['outcome']) => results.filter((result) => result.outcome === kind).length
  return {
    runs,
    winRate: rate(outcomes('win'), runs),
    lossRate: rate(outcomes('loss'), runs),
    ammoEmptyRate: rate(outcomes('ammo-empty'), runs),
    turnLimitRate: rate(outcomes('turn-limit'), runs),
    retreatRate: rate(results.filter((result) => result.retreated).length, runs),
    turnsMean: meanOf(turns),
    turnsMedian: summarize(turns).median,
    turns: summarize(turns),
    ttkByArchetype: Object.fromEntries(archetypes.map((id) => [id, summarize(ttkSamples.get(id)!).mean])),
    ttkDetailByArchetype: Object.fromEntries(archetypes.map((id) => [id, summarize(ttkSamples.get(id)!)])),
    damageTakenMean: meanOf(results.map((result) => result.damageTaken)),
    damageTaken: summarize(results.map((result) => result.damageTaken)),
    damageDealtMean: meanOf(results.map((result) => result.damageDealt)),
    heroHpEndMean: meanOf(results.map((result) => result.heroHpEnd)),
    ammoSpentMean: meanOf(results.map((result) => result.ammoSpent)),
    ammoSpent: summarize(results.map((result) => result.ammoSpent)),
    ammoRemainingMean: meanOf(results.map((result) => result.ammoRemaining)),
    reloadsMean: meanOf(results.map((result) => result.reloads)),
    jamClearsMean: meanOf(results.map((result) => result.jamClears)),
    weaponDurabilityLostMean: meanOf(results.map((result) => result.weaponDurabilityLost)),
    armorDurabilityLostMean: meanOf(results.map((result) => result.armorDurabilityLost)),
    malfunctionRate: rate(shots.filter((shot) => shot.malfunctioned).length, shots.length),
    critRate: rate(resolved.filter((shot) => shot.critical).length, resolved.length),
    missRate: rate(resolved.filter((shot) => !shot.hit).length, resolved.length),
    hitRate: rate(resolved.filter((shot) => shot.hit).length, resolved.length),
    executionRate: rate(resolved.filter((shot) => shot.executed).length, resolved.length),
    shotsTotal: shots.length,
    resolvedShotsTotal: resolved.length,
    malfunctionsTotal: shots.filter((shot) => shot.malfunctioned).length,
    killRate: rate(
      results.reduce((sum, result) => sum + result.enemiesKilled, 0),
      results.reduce((sum, result) => sum + result.enemyCount, 0),
    ),
  }
}

export { round as roundMetric }
