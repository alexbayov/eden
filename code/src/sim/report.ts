/**
 * Report assembly for the balance simulator (W3-02 acceptance criteria 1–3).
 *
 * Splits cleanly from `metrics.ts`: that module turns battles into numbers, this one turns numbers
 * into the two artefacts docs/23 §8 requires — a machine-readable JSON report and a human-readable
 * Markdown summary — and into the economy projection W3-03 asks for.
 *
 * ## Determinism of the artefacts, not just of the battles
 *
 * "Same seed gives a byte-identical report" is an acceptance criterion, so the report body must
 * contain nothing environmental. Two rules follow and both are enforced by construction:
 *
 *   - No clock and no host data anywhere in `SimulationReport`. The commit hash is the single
 *     exception and it is an *input*, resolved by the caller from `git`/env, never read here.
 *   - Every object is built with its keys in a fixed literal order and every array is sorted by a
 *     total key, so `JSON.stringify` output is stable. `Object.fromEntries(map)` over an unsorted
 *     map would silently make the bytes depend on insertion order.
 *
 * ## Economy projection
 *
 * The economy section is not a second simulation. It is the *combat* results priced with the
 * shipped constants (`REPAIR_MATERIAL_RATE`, `MEDBAY_HEAL_PER_LEVEL`, `repairCost`, the reward
 * catalog): what one pass of the zone yields versus what repairing the measured durability loss
 * and healing the measured damage costs. Constants are imported, never restated, which is W3-03
 * acceptance criterion 3.
 */
import {
  MEDBAY_ITEM,
  MEDBAY_HEAL_PER_LEVEL,
  REPAIR_MATERIAL,
  REPAIR_MATERIAL_RATE,
  repairCost,
  type BaseUpgradeDefinition,
  type RecipeDefinition,
} from '../game/base'
import type { RewardDefinition } from '../game/campaign-content'
import { RESOURCE_IDS, type ResourceId } from '../game/inventory'
import type { BattleResult } from './battle'
import { aggregateCombat, roundMetric, type CombatMetrics } from './metrics'

export type SimulationMode = 'isolated' | 'chain'

export interface RunConfig {
  runs: number
  seed: number
  policyId: string
  mode: SimulationMode
  /** Whether the pass restocked ammunition between encounters (chain mode only). */
  restock: boolean
  turnLimit: number
}

/** One arena's slice of the report. `arena` is the id, matching docs/23 §8's example field. */
export interface ArenaReport {
  arena: string
  encounterId: string
  policy: string
  metrics: CombatMetrics
}

export interface ResourceFlow {
  resource: ResourceId
  /** Granted by reward catalogs for the encounters that were won, per pass, mean over runs. */
  income: number
  /** Spent restoring the measured durability loss (and nothing else). */
  repairCost: number
  net: number
}

export interface EconomyReport {
  /** Mean XP a single pass of the simulated set awards, counting only wins. */
  xpPerPassMean: number
  /** XP if every encounter in the set is won: the catalog ceiling, not a measurement. */
  xpPerPassMax: number
  bandagesPerPassMean: number
  /** Bandages the measured hero damage needs, at `MEDBAY_HEAL_PER_LEVEL` per bandage, medbay L1. */
  bandagesNeededPerPassMean: number
  /** Extra bandages the pass's net cloth could be crafted into, priced from the recipe catalog. */
  bandagesCraftablePerPassMean: number
  bandageBalancePerPassMean: number
  resources: ResourceFlow[]
  /** Passes needed to afford every base upgrade in the catalog from net income; null when net ≤ 0. */
  passesForAllUpgrades: number | null
  constants: {
    repairMaterial: ResourceId
    repairMaterialRate: number
    medbayHealPerLevel: number
  }
}

export interface SimulationReport {
  /** Short SHA of the tree the numbers came from, or null when it could not be resolved. */
  commit: string | null
  contentCatalogId: string
  seed: number
  runs: number
  policy: string
  mode: SimulationMode
  /** Whether the pass restocked ammunition between encounters (chain mode only). */
  restock: boolean
  turnLimit: number
  arenas: ArenaReport[]
  /** Every battle of every arena pooled: docs W3-02 criterion 2's "и суммарно". */
  total: CombatMetrics
  economy: EconomyReport
}

export interface EconomySources {
  rewards: readonly RewardDefinition[]
  upgrades: readonly BaseUpgradeDefinition[]
  recipes: readonly RecipeDefinition[]
  /**
   * `arenaId -> rewardId`, so a win can be priced without re-deriving the campaign. Keyed by arena
   * rather than encounter because that is what `BattleResult.arenaId` carries. The two ids coincide
   * on the shipped content but are distinct fields; conflating them would misprice a future
   * encounter that reuses a map.
   */
  rewardIdByArena: ReadonlyMap<string, string>
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)

/** The item `treatHero` consumes, taken from the shipped constant rather than spelled out. */
const BANDAGE_ITEM = MEDBAY_ITEM

/**
 * Bandages one pass consumes. `treatHero` heals `medbay * MEDBAY_HEAL_PER_LEVEL` per bandage and
 * cannot overheal, so the count is the measured damage divided by the L1 heal, rounded up: the
 * cheapest way to be back at full HP. Medbay level 1 is `defaultBase()`, which is where a
 * simulated campaign starts.
 */
const bandagesFor = (damage: number) => Math.ceil(damage / MEDBAY_HEAL_PER_LEVEL)

/**
 * Metal one pass of repairs costs. Priced through `repairCost` rather than by multiplying
 * `REPAIR_MATERIAL_RATE` by hand, because the shipped rule is per-10-points *ceiling* per
 * instance, and weapon and armour are two instances repaired separately.
 */
function repairSpend(weaponLost: number, armorLost: number): number {
  const per = (lost: number) => repairCost(Math.max(0, 100 - lost), 100)[REPAIR_MATERIAL] ?? 0
  return per(weaponLost) + per(armorLost)
}

/**
 * `passes[i]` is every battle of run index `i`, one per encounter, in campaign order — the unit the
 * economy is priced in. Grouping is the caller's, not inferred from a pooled array: in `chain` mode
 * a pass *is* a causally linked sequence (encounter 2 starts on encounter 1's ammo), and reordering
 * it would silently price a run that never happened.
 */
export function buildEconomy(
  passes: readonly (readonly BattleResult[])[],
  /** Arena ids of the simulated set, in campaign order — the same key `rewardIdByArena` uses. */
  arenaIds: readonly string[],
  sources: EconomySources,
): EconomyReport {
  const rewardFor = (arenaId: string) => {
    const rewardId = sources.rewardIdByArena.get(arenaId)
    return rewardId ? sources.rewards.find((entry) => entry.id === rewardId) : undefined
  }
  /* Cloth per bandage, from the shipped recipe; absent recipe means cloth cannot become bandages. */
  const clothPerBandage = sources.recipes.find((recipe) => recipe.output.itemId === BANDAGE_ITEM)?.cost.cloth ?? 0

  const passStats = passes.map((pass) => {
    /* Only a win claims a reward: `awardRewardTransition` refuses anything else. */
    const rewards = pass
      .filter((result) => result.outcome === 'win')
      .map((result) => rewardFor(result.arenaId))
      .filter((reward): reward is RewardDefinition => Boolean(reward))
    return {
      xp: rewards.reduce((sum, reward) => sum + reward.xp, 0),
      bandages: rewards.reduce(
        (sum, reward) => sum + reward.items.filter((item) => item.id === BANDAGE_ITEM).reduce((count, item) => count + item.quantity, 0),
        0,
      ),
      bandagesNeeded: bandagesFor(pass.reduce((sum, result) => sum + result.damageTaken, 0)),
      repair: pass.reduce((sum, result) => sum + repairSpend(result.weaponDurabilityLost, result.armorDurabilityLost), 0),
      income: Object.fromEntries(
        RESOURCE_IDS.map((resource) => [resource, rewards.reduce((sum, reward) => sum + (reward.resources[resource] ?? 0), 0)]),
      ) as Record<ResourceId, number>,
    }
  })

  const resources: ResourceFlow[] = RESOURCE_IDS.map((resource) => {
    const income = roundMetric(mean(passStats.map((pass) => pass.income[resource])))
    /* Repair spends `REPAIR_MATERIAL` only; no other resource has a measured sink in this slice. */
    const spend = resource === REPAIR_MATERIAL ? roundMetric(mean(passStats.map((pass) => pass.repair))) : 0
    return { resource, income, repairCost: spend, net: roundMetric(income - spend) }
  }).filter((flow) => flow.income !== 0 || flow.repairCost !== 0)

  const netRepairMaterial = resources.find((flow) => flow.resource === REPAIR_MATERIAL)?.net ?? 0
  const upgradeMetal = sources.upgrades.reduce((sum, upgrade) => sum + (upgrade.cost[REPAIR_MATERIAL] ?? 0), 0)
  const bandagesMean = roundMetric(mean(passStats.map((pass) => pass.bandages)))
  const bandagesNeededMean = roundMetric(mean(passStats.map((pass) => pass.bandagesNeeded)))
  const clothIncome = resources.find((flow) => flow.resource === 'cloth')?.net ?? 0
  const craftable = clothPerBandage > 0 ? roundMetric(clothIncome / clothPerBandage) : 0

  return {
    xpPerPassMean: roundMetric(mean(passStats.map((pass) => pass.xp))),
    xpPerPassMax: arenaIds.reduce((sum, arenaId) => sum + (rewardFor(arenaId)?.xp ?? 0), 0),
    bandagesPerPassMean: bandagesMean,
    bandagesNeededPerPassMean: bandagesNeededMean,
    bandagesCraftablePerPassMean: craftable,
    bandageBalancePerPassMean: roundMetric(bandagesMean + craftable - bandagesNeededMean),
    resources,
    passesForAllUpgrades:
      netRepairMaterial > 0 && upgradeMetal > 0 ? Math.ceil(upgradeMetal / netRepairMaterial) : null,
    constants: {
      repairMaterial: REPAIR_MATERIAL,
      repairMaterialRate: REPAIR_MATERIAL_RATE,
      medbayHealPerLevel: MEDBAY_HEAL_PER_LEVEL,
    },
  }
}

export interface ReportSources extends EconomySources {
  commit: string | null
  contentCatalogId: string
}

export interface ArenaResults {
  encounterId: string
  arenaId: string
  /** Index `i` is run index `i`; the order is the seed order and must not be reshuffled. */
  results: readonly BattleResult[]
}

/** `arenaResults` must be in campaign order; the report keeps that order so the bytes are stable. */
export function buildReport(
  arenaResults: readonly ArenaResults[],
  config: RunConfig,
  sources: ReportSources,
): SimulationReport {
  const pooled = arenaResults.flatMap((entry) => entry.results)
  const passes = Array.from({ length: config.runs }, (_unused, index) =>
    arenaResults.map((entry) => entry.results[index]).filter((result): result is BattleResult => Boolean(result)),
  )
  return {
    commit: sources.commit,
    contentCatalogId: sources.contentCatalogId,
    seed: config.seed,
    runs: config.runs,
    policy: config.policyId,
    mode: config.mode,
    restock: config.restock,
    turnLimit: config.turnLimit,
    arenas: arenaResults.map((entry) => ({
      arena: entry.arenaId,
      encounterId: entry.encounterId,
      policy: config.policyId,
      metrics: aggregateCombat(entry.results),
    })),
    total: aggregateCombat(pooled),
    economy: buildEconomy(passes, arenaResults.map((entry) => entry.arenaId), sources),
  }
}

const percent = (value: number) => `${roundMetric(value * 100, 2)}%`
const fixed = (value: number) => value.toFixed(2)

/**
 * The Markdown summary. Same numbers as the JSON, no extra derivation — a reader must never have
 * to reconcile the two artefacts. Deterministic for the same reason the JSON is.
 */
export function renderMarkdown(report: SimulationReport): string {
  const lines: string[] = []
  lines.push('# Balance simulation report')
  lines.push('')
  lines.push(`- commit: \`${report.commit ?? 'unknown'}\``)
  lines.push(`- content catalog: \`${report.contentCatalogId}\``)
  lines.push(`- seed: \`${report.seed}\``)
  lines.push(`- runs per encounter: \`${report.runs}\``)
  lines.push(`- policy: \`${report.policy}\``)
  lines.push(`- mode: \`${report.mode}\`${report.restock ? ' (+ восполнение патронов между encounter)' : ''}`)
  lines.push(`- turn limit: \`${report.turnLimit}\``)
  lines.push('')
  /* Exact flags rather than a script name: the two npm scripts differ only in defaults, and a
     reader who copies a command that silently uses a different mode reproduces different numbers. */
  const command = `npx tsx src/sim/cli.ts --runs ${report.runs} --seed ${report.seed} --policy ${report.policy} --mode ${report.mode} --turn-limit ${report.turnLimit}${report.restock ? ' --restock' : ''}`
  lines.push(
    report.commit
      ? `Числа воспроизводятся на коммите \`${report.commit}\` из каталога \`code/\`:\n\n\`\`\`\n${command}\n\`\`\``
      : `⚠️ Коммит не определён: отчёт невоспроизводим и по правилу 2 из \`design-data/README.md\` не является основанием для изменения баланса. Команда прогона:\n\n\`\`\`\n${command}\n\`\`\``,
  )
  lines.push('')
  lines.push('## Combat, per encounter')
  lines.push('')
  lines.push('| encounter | win | loss | ammo-empty | turn-limit | obj-failed | turns (mean/med) | dmg taken | dmg dealt | ammo | reloads | jams | hit | crit | malf | wpn dur | armor dur |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const arena of report.arenas) {
    const metrics = arena.metrics
    lines.push(
      `| \`${arena.encounterId}\` | ${percent(metrics.winRate)} | ${percent(metrics.lossRate)} | ${percent(metrics.ammoEmptyRate)} | ${percent(metrics.turnLimitRate)} | ${percent(metrics.objectiveFailedRate)} | ${fixed(metrics.turnsMean)} / ${metrics.turnsMedian} | ${fixed(metrics.damageTakenMean)} | ${fixed(metrics.damageDealtMean)} | ${fixed(metrics.ammoSpentMean)} | ${fixed(metrics.reloadsMean)} | ${fixed(metrics.jamClearsMean)} | ${percent(metrics.hitRate)} | ${percent(metrics.critRate)} | ${percent(metrics.malfunctionRate)} | ${fixed(metrics.weaponDurabilityLostMean)} | ${fixed(metrics.armorDurabilityLostMean)} |`,
    )
  }
  const total = report.total
  lines.push(
    `| **всего** | ${percent(total.winRate)} | ${percent(total.lossRate)} | ${percent(total.ammoEmptyRate)} | ${percent(total.turnLimitRate)} | ${percent(total.objectiveFailedRate)} | ${fixed(total.turnsMean)} / ${total.turnsMedian} | ${fixed(total.damageTakenMean)} | ${fixed(total.damageDealtMean)} | ${fixed(total.ammoSpentMean)} | ${fixed(total.reloadsMean)} | ${fixed(total.jamClearsMean)} | ${percent(total.hitRate)} | ${percent(total.critRate)} | ${percent(total.malfunctionRate)} | ${fixed(total.weaponDurabilityLostMean)} | ${fixed(total.armorDurabilityLostMean)} |`,
  )
  lines.push('')
  lines.push('## TTK по архетипу (ходы игрока)')
  lines.push('')
  lines.push('| encounter | архетип | mean | median | min | max | stdDev | выборка |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|')
  for (const arena of report.arenas)
    for (const [archetype, summary] of Object.entries(arena.metrics.ttkDetailByArchetype))
      lines.push(
        `| \`${arena.encounterId}\` | \`${archetype}\` | ${fixed(summary.mean)} | ${summary.median} | ${summary.min} | ${summary.max} | ${fixed(summary.stdDev)} | ${summary.count} |`,
      )
  lines.push('')
  lines.push('## Экономика одного прохода набора')
  lines.push('')
  lines.push(`- XP за проход: ${fixed(report.economy.xpPerPassMean)} из ${report.economy.xpPerPassMax} возможных.`)
  lines.push(
    `- Бинты: в награду ${fixed(report.economy.bandagesPerPassMean)}, из нетто-ткани можно скрафтить ${fixed(report.economy.bandagesCraftablePerPassMean)}, требуется на лечение ${fixed(report.economy.bandagesNeededPerPassMean)}, баланс ${fixed(report.economy.bandageBalancePerPassMean)} (медотсек L1, ${report.economy.constants.medbayHealPerLevel} HP за бинт).`,
  )
  lines.push('')
  lines.push('| ресурс | приход | ремонт | нетто |')
  lines.push('|---|---:|---:|---:|')
  for (const flow of report.economy.resources)
    lines.push(`| \`${flow.resource}\` | ${fixed(flow.income)} | ${fixed(flow.repairCost)} | ${fixed(flow.net)} |`)
  lines.push('')
  lines.push(
    report.economy.passesForAllUpgrades === null
      ? `- Улучшения базы недостижимы из нетто-дохода: \`${report.economy.constants.repairMaterial}\` не в профиците.`
      : `- Все улучшения базы из каталога окупаются за ${report.economy.passesForAllUpgrades} проход(ов) при текущем нетто-доходе.`,
  )
  lines.push('')
  lines.push('## Что этот отчёт не измеряет')
  lines.push('')
  lines.push('- Игрока. Политика — детерминированная эвристика, а не человек: см. `code/src/sim/policies.ts`.')
  lines.push('- Прогрессию персонажа: уровней, навыков и перков в коде нет, XP ни на что не влияет.')
  lines.push('- Штраф смерти: поражение не отнимает ресурсы, поэтому нетто-доход выше, чем будет после `W4-02`/`W5-05`.')
  lines.push('- Ремонт и лечение как решения: экономика оценивает стоимость восстановления, но симулятор не тратит ресурсы между боями.')
  lines.push('')
  return lines.join('\n')
}

/** Stable JSON with a trailing newline: byte-comparable across runs and diff-friendly. */
export const renderJson = (report: SimulationReport): string => `${JSON.stringify(report, null, 2)}\n`
