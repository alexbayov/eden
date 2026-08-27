/**
 * W5-05 — pure view model for the backpack loss shown on the return screen.
 *
 * `death-loss.ts` is pure, so the **preview and the application are the same call**: this module runs
 * `applyBackpackDeathLoss` once, renders what it reports, and the shell later commits the identical
 * `inventory` from the same result. Nothing is computed twice, so the list a player reads before
 * pressing "вернуться на базу" cannot differ from what is actually taken (W5-05 criterion 4).
 *
 * The rule is stated to the player, but no longer as a proposal: **decision D-01 landed on 27 August
 * 2026** and approved the 30% the implementation was already carrying. The `proposed` input and the
 * caveat branch of `policyLabel` were deleted rather than defaulted to `false`, because a flag that
 * can only ever be false is a second answer to "is this balance approved?" that will not stay in step
 * with the policy it describes. `ratePercent` is still read off the policy and never restated, so the
 * label follows the rate if the rate is ever retuned.
 *
 * What the view states positively, because a penalty screen is where a player most needs it: the
 * stash, worn equipment and XP-related consequences are **not** part of this loss. Saying only what
 * was taken invites the assumption that the base was raided too.
 */
import {
  applyBackpackDeathLoss,
  lossUnitsFor,
  shouldApplyBackpackLoss,
  type BackpackLoss,
  type BackpackLossPolicy,
  type LossEntry,
  type LossSelection,
} from './death-loss'
import type { ReturnReason } from './campaign'
import { RESOURCE_LABELS, type Inventory, type ResourceId } from './inventory'

export interface LossLine {
  kind: 'resources' | 'items'
  id: string
  /** Catalog name for an item, canonical Russian label for a resource. */
  label: string
  /** Units taken from this stack. */
  lost: number
  /** Units the stack held before. */
  carried: number
  /** `Металл ×2 из 6` — what a player reads. */
  text: string
}

export interface DeathLossView {
  /** True when this return actually costs loot: a non-free defeat, never a retreat. */
  applies: boolean
  /** Why not, when `applies` is false. Empty otherwise. */
  skippedReason: string
  /** Exactly what will be taken, in the domain's deterministic order. */
  lines: LossLine[]
  lostUnits: number
  carriedUnits: number
  /** Rate as a percentage for display; read off the policy, never restated. */
  ratePercent: number
  /** The rule as stated to the player. */
  policyLabel: string
  /** Headline: what happens to the backpack. */
  summary: string
  /** What is explicitly untouched. */
  safetyNote: string
  /**
   * The inventory to commit. Identical to what the preview describes; `null` when the domain refused
   * the policy, which the shell must treat as "change nothing" rather than as an empty loss.
   */
  inventory: Inventory | null
  /** Advanced RNG state when a randomised selection was used, so the shell can persist it. */
  rngState?: number
}

const lineFor = (entry: LossEntry, labelFor: (itemId: string) => string): LossLine => {
  const label = entry.kind === 'resources' ? RESOURCE_LABELS[entry.id as ResourceId] : labelFor(entry.id)
  return {
    kind: entry.kind,
    id: entry.id,
    label,
    lost: entry.lost,
    carried: entry.quantity,
    text: `${label} ×${entry.lost} из ${entry.quantity}`,
  }
}

export interface DeathLossInput {
  inventory: Inventory
  policy: BackpackLossPolicy
  reason: ReturnReason
  firstDeathReturnUsed: boolean
  labelFor?: (itemId: string) => string
  selection?: LossSelection
}

/**
 * The whole return-screen loss as data.
 *
 * When the penalty does not apply, `applies` is false and `inventory` is `null` — deliberately not an
 * empty-loss success. "Nothing was taken because this death was free" and "nothing was taken because
 * the backpack was too small" are different sentences for the player, and collapsing them would hide
 * the free-death rule the moment it matters most.
 */
export function buildDeathLossView(input: DeathLossInput): DeathLossView {
  const labelFor = input.labelFor ?? ((itemId: string) => itemId)
  const ratePercent = Math.round(input.policy.rate * 100)
  const policyLabel = `Правило: теряется ${ratePercent}% переносимого груза, без эскалации.`
  const safetyNote = 'Stash, надетая экипировка и её durability не затрагиваются.'
  const base = { ratePercent, policyLabel, safetyNote, lines: [] as LossLine[], lostUnits: 0, carriedUnits: 0 }

  if (!shouldApplyBackpackLoss(input.reason, input.firstDeathReturnUsed))
    return {
      ...base,
      applies: false,
      skippedReason: input.reason === 'retreat'
        ? 'Отступление: груз не теряется — цена отступления в том, что награда не получена.'
        : input.reason === 'defeat'
          ? 'Первое поражение: груз не теряется. Следующее поражение будет стоить части рюкзака.'
          : 'Штраф не применяется вне поражения.',
      summary: 'Рюкзак сохранён полностью.',
      inventory: null,
    }

  const result = applyBackpackDeathLoss(input.inventory, input.policy, input.selection)
  if (!result.ok)
    return {
      ...base,
      applies: false,
      /* A rejected policy is a bug, not a balance state: the screen says nothing was taken and the
         shell commits nothing, rather than guessing a fallback penalty. */
      skippedReason: `Штраф не применён: политика потерь отклонена (${result.reason}). Рюкзак не изменён.`,
      summary: 'Рюкзак сохранён полностью.',
      inventory: null,
    }

  const loss: BackpackLoss = result.value
  const lines = loss.lost.map((entry) => lineFor(entry, labelFor))
  return {
    ...base,
    applies: true,
    skippedReason: '',
    lines,
    lostUnits: loss.lostUnits,
    carriedUnits: loss.carriedUnits,
    summary: loss.lostUnits === 0
      ? `Груз слишком мал для штрафа: ${ratePercent}% от ${loss.carriedUnits} ед. округляются в ноль, потерь нет.`
      : `Потеряно ${loss.lostUnits} из ${loss.carriedUnits} ед. груза (${ratePercent}%).`,
    inventory: loss.inventory,
    ...(loss.rngState === undefined ? {} : { rngState: loss.rngState }),
  }
}

export { lossUnitsFor }
