/**
 * W5-04 — pure view model for the base dismantle panel.
 *
 * `dismantle.ts` owns the transaction and refuses to guess anything about presentation. This module
 * turns the shipped return tables into a list a player can act on: for every eligible instance and
 * stashed item it states **exactly what comes back** before anything is destroyed, and whether the
 * action is available at all.
 *
 * Three decisions, each closing a way this screen could mislead:
 *
 *   1. **The preview and the payout are the same numbers.** Both come from `returnsFor` on the same
 *      table the transaction reads, so a "you will get 4 metal" that pays 2 is impossible without
 *      changing content. The preview is not recomputed from a percentage.
 *   2. **Worn gear is listed and permanently unavailable; every *spare* takes two presses.** Hiding
 *      worn gear would make "why can I not dismantle my vest" unanswerable, and allowing it — even
 *      behind a confirmation — soft-locks the run, because the hero's loadout comes from the arena
 *      template and cannot be replaced (see the note in `dismantle.ts`). Spares are still
 *      irreversible, so they arm first: `confirming` carries the pending id, making the confirm step
 *      state the shell holds rather than a `window.confirm` the tests cannot observe.
 *   3. **A zero-return item is shown as unavailable with the reason.** Content simply has no table
 *      for it, and `dismantleEquipment` would refuse with `no-yield` anyway. Rendering it as a live
 *      button that logs a refusal would be a worse version of the same information.
 *
 * There is no "repair vs dismantle" *recommendation* here, only the two prices side by side
 * (`repairCostLabel` next to `returnsLabel`). Which is better depends on whether the player intends
 * to keep the item, and inventing a recommendation would state a balance opinion the owner has not
 * taken.
 */
import { repairCost } from './base'
import { formatCost } from './base-view'
import type { Unit } from './combat'
import { linkedEquipmentInstanceIds, returnsFor, totalUnits, type ReturnTable } from './dismantle'
import {
  equipmentDurabilityPercent,
  hasResources,
  type EquipmentInstance,
  type Inventory,
  type ResourceCost,
} from './inventory'

/** Why an entry cannot be dismantled right now, or `null`. */
export type DismantleBlocker =
  /** Content gives this id nothing back. */
  | 'no-yield'
  /** The hero is wearing/carrying it: refused outright, not a prompt. */
  | 'equipped'
  /** An irreversible destruction the player has not confirmed yet. */
  | 'needs-confirmation'

export interface DismantleOption {
  /** `equipment` entries are keyed by `instanceId`; `item` entries by the stashed `itemId`. */
  kind: 'equipment' | 'item'
  /** Stable id for the DOM and for the click handler: instance id, or item id. */
  id: string
  itemId: string
  /** Catalog name of the thing being destroyed. */
  label: string
  /** `×3` for a stacked item, empty for a single instance. */
  quantityLabel: string
  /** `Металл ×4, Механика ×2` — exactly what will be paid into the stash. */
  returnsLabel: string
  returns: ResourceCost
  /** Durability readout for gear, empty for items. */
  conditionLabel: string
  /** What repairing this instance would cost instead, empty when it is undamaged or an item. */
  repairCostLabel: string
  /** True when a live encounter still points at this instance. */
  equipped: boolean
  blocked: DismantleBlocker | null
  available: boolean
  disabled: boolean
  /** True when pressing the control asks for confirmation instead of dismantling. */
  requiresConfirmation: boolean
  /** True when this entry is the one currently awaiting confirmation. */
  confirming: boolean
  reason: string
  ariaLabel: string
}

export interface DismantlePanelView {
  options: DismantleOption[]
  /** Visible summary; states the irreversibility once rather than on every row. */
  summary: string
  /** The instance awaiting confirmation, mirrored back so the shell can render a banner. */
  pendingConfirmation: DismantleOption | null
}

export interface DismantlePanelInput {
  inventory: Inventory
  returnTable: ReturnTable
  /** Live encounter units, so worn gear can be marked. Empty on the base screen is fine. */
  units: readonly Unit[]
  labelFor?: (itemId: string) => string
  /** Instance/item id the player has been asked to confirm, from shell state. */
  confirmingId?: string | null
}

const reasonFor = (blocked: DismantleBlocker | null, label: string): string => {
  if (blocked === null) return ''
  if (blocked === 'no-yield') return `${label} не даёт возврата: разбирать нечего.`
  if (blocked === 'equipped')
    return `${label} используется героем: снаряжение нельзя разобрать, иначе выйти на миссию будет нечем. Замены в игре пока нет.`
  return `${label} будет уничтожен безвозвратно. Нажмите ещё раз, чтобы подтвердить.`
}

const optionFor = (
  input: DismantlePanelInput,
  kind: 'equipment' | 'item',
  id: string,
  itemId: string,
  quantityLabel: string,
  conditionLabel: string,
  repairCostLabel: string,
  equipped: boolean,
): DismantleOption => {
  const labelFor = input.labelFor ?? ((value: string) => value)
  const label = labelFor(itemId)
  const returns = returnsFor(input.returnTable, itemId)
  const yields = totalUnits(returns) > 0
  /* Order is the precedence the player needs: nothing to confirm if nothing comes back, and nothing
     to confirm either if the entry can never be dismantled at all. Only a genuinely destructible
     entry can be *armed*, so arming a refused one is inert rather than a latent one-click destroy. */
  const destructible = yields && !equipped
  const confirming = destructible && input.confirmingId === id
  const blocked: DismantleBlocker | null = !yields
    ? 'no-yield'
    : equipped
      ? 'equipped'
      : !confirming
        ? 'needs-confirmation'
        : null
  return {
    kind,
    id,
    itemId,
    label,
    quantityLabel,
    returnsLabel: yields ? formatCost(returns) : 'ничего',
    returns,
    conditionLabel,
    repairCostLabel,
    equipped,
    blocked,
    available: blocked === null,
    /* An entry awaiting confirmation stays operable: the second press is what confirms it. Worn gear
       and a zero-return entry are dead ends, so both report as unavailable. */
    disabled: blocked === 'no-yield' || blocked === 'equipped',
    requiresConfirmation: blocked === 'needs-confirmation',
    confirming,
    reason: reasonFor(blocked, label),
    ariaLabel: `Разобрать ${label}${quantityLabel ? ` ${quantityLabel}` : ''}${
      conditionLabel ? `, ${conditionLabel}` : ''
    }. Возврат: ${yields ? formatCost(returns) : 'ничего'}.${
      blocked === 'needs-confirmation'
        ? ' Действие необратимо: потребуется подтверждение.'
        : blocked === null
          ? ' Подтвердите: действие необратимо.'
          : ` Недоступно: ${reasonFor(blocked, label)}`
    }`,
  }
}

/** Repair price for an instance, or an empty label when it is undamaged. */
const repairLabelFor = (inventory: Inventory, entry: EquipmentInstance): string => {
  const cost = repairCost(entry.durability, entry.maxDurability)
  if (Object.keys(cost).length === 0) return ''
  return `ремонт: ${formatCost(cost)}${hasResources(inventory, cost, 'stash') ? '' : ' (не хватает)'}`
}

/**
 * Every eligible entry, gear first and then stashed items, each in a deterministic order.
 *
 * Gear comes first because it is the expensive, irreversible half of the decision; within each group
 * the order is by id, so the list does not reshuffle as durability changes.
 */
export function buildDismantlePanel(input: DismantlePanelInput): DismantlePanelView {
  const linked = linkedEquipmentInstanceIds(input.units)
  const equipment = [...input.inventory.equipment]
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
    .map((entry) =>
      optionFor(
        input,
        'equipment',
        entry.instanceId,
        entry.itemId,
        '',
        `${equipmentDurabilityPercent(entry)}% durability`,
        repairLabelFor(input.inventory, entry),
        linked.has(entry.instanceId),
      ),
    )
  /* Stash only: a backpack item is loaded for a mission, and dismantling it at the workbench would
     silently change the weight budget the player just packed. */
  const items = [...input.inventory.stash.items]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((stack) => optionFor(input, 'item', stack.id, stack.id, `×${stack.quantity}`, '', '', false))
  const options = [...equipment, ...items]
  const usable = options.filter((option) => !option.disabled)
  const worn = options.filter((option) => option.blocked === 'equipped').length
  const wornNote = worn > 0 ? ` Снаряжение героя (${worn}) разобрать нельзя: замены в игре пока нет.` : ''
  return {
    options,
    summary: usable.length === 0
      ? `Разбирать нечего: ни один свободный предмет не даёт возврата.${wornNote}`
      : `Доступно к разборке: ${usable.length}. Разборка необратима; возврат идёт в stash.${wornNote}`,
    pendingConfirmation: options.find((option) => option.confirming) ?? null,
  }
}
