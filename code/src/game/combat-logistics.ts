/**
 * W6-05 — the two things that connected combat to the base but did not exist: restocking ammunition, and
 * being told your gear is unfit before you leave.
 *
 * **Restocking.** Ammunition was a *consumable*, never a resource. Bundles could be crafted
 * (`pistol-rounds`, `rifle-rounds`, `shotgun-shells`), but the only way to use one was mid-mission: pack it
 * into the weight-limited backpack, assign it to a quick slot, and burn 2 AP during a fight. There was no
 * "top up before leaving" at all — `grep reserveAmmo src/game/base.ts src/game/base-view.ts` returned
 * nothing. Mission-start ammo was simply whatever survived the last fight, which is why an empty reserve was
 * a soft lock whose only exit was a rewardless retreat.
 *
 * **The pre-mission check.** `malfunctionEligible` jams a weapon below 30% durability at 8% per shot, or 15%
 * if it is `makeshift` — and the shipped starter weapon *is* makeshift, so that is the default experience.
 * Durability was visible on the base screen as a percentage, but nothing marked the 30% threshold, and
 * nothing warned about an empty magazine and empty reserve. The player found out on the first trigger pull.
 *
 * Two decisions worth naming:
 *
 *   1. **Restocking consumes crafted bundles, not raw resources.** Metal already buys bundles through
 *      `recipes.json`; letting the base spend metal directly would create a second price for the same goods
 *      and make the recipes pointless. So this is a *transfer* — stashed bundle into the weapon's reserve —
 *      and the economy stays the one the simulator measures.
 *   2. **The check reports, it does not block.** Leaving with a nearly-broken weapon is a legitimate choice;
 *      leaving *without knowing* is the defect. Criterion 5 asks that the player cannot start "without a
 *      warning", not that the game refuse.
 */
import {
  itemQuantity,
  removeItem,
  type EquipmentInstance,
  type Inventory,
} from './inventory'
import { malfunctionEligible, type Unit, type WeaponState } from './combat'
import type { ItemEffectDefinition } from './consumables'

/**
 * Durability share below which a weapon starts jamming.
 *
 * Mirrors `malfunctionEligible`'s own threshold rather than restating a number: the whole point of the warning
 * is to name the line the combat rule actually uses. `combat-logistics.test.ts` asserts the two agree.
 */
export const JAM_RISK_DURABILITY = 0.3

/** Jam chance per shot once eligible, from `malfunctionOccurs`. Display only. */
export const JAM_CHANCE_MAKESHIFT = 15
export const JAM_CHANCE_WORN = 8

/** Rounds a bundle of `itemId` yields, read from the shipped `restore-ammo` effects. */
export const bundleYield = (
  effects: readonly ItemEffectDefinition[],
  itemId: string,
): { ammoId: string; amount: number } | null => {
  const definition = effects.find((entry) => entry.itemId === itemId)
  if (!definition || definition.effect.kind !== 'restore-ammo') return null
  return { ammoId: definition.effect.ammoId, amount: definition.effect.amount }
}

/** Every bundle in the catalog that feeds `ammoId`. */
export const bundlesForAmmo = (effects: readonly ItemEffectDefinition[], ammoId: string): string[] =>
  effects
    .filter((entry) => entry.effect.kind === 'restore-ammo' && entry.effect.ammoId === ammoId)
    .map((entry) => entry.itemId)

export type RestockFailure =
  /** No such instance in `inventory.equipment`. */
  | 'unknown-equipment'
  /** The instance is not a weapon, so it has no reserve to fill. */
  | 'not-a-weapon'
  /** No bundle in the catalog matches this weapon's calibre. */
  | 'no-matching-ammo'
  /** The stash holds none of the matching bundles. */
  | 'no-bundles'

export interface Restocked {
  inventory: Inventory
  /** The instance with its reserve raised. */
  equipment: EquipmentInstance
  /** Bundles consumed from the stash. */
  bundlesUsed: number
  /** Rounds added to the reserve. */
  roundsAdded: number
  itemId: string
}

export type RestockResult =
  | { ok: true; value: Restocked }
  | { ok: false; reason: RestockFailure; inventory: Inventory }

/**
 * Moves one stashed ammunition bundle into a weapon's reserve (criterion 1).
 *
 * **Atomic and one bundle at a time.** The bundle leaves the stash and the reserve rises in the same returned
 * object, so a save can never hold a spent bundle with no rounds or rounds with no bundle spent. One at a time
 * rather than "fill it up" because the reserve has no cap in the data model — a `fillAll` would silently
 * decide how much ammunition a player *should* carry, which is a balance decision this ticket has no mandate
 * to make.
 *
 * Stash-only, matching every other base transaction: the backpack is what the player packed for the mission,
 * and quietly emptying it here would change the weight budget they just committed to.
 */
export function restockAmmo(
  inventory: Inventory,
  instanceId: string,
  effects: readonly ItemEffectDefinition[],
): RestockResult {
  const equipment = inventory.equipment.find((entry) => entry.instanceId === instanceId)
  if (!equipment) return { ok: false, reason: 'unknown-equipment', inventory }
  /* A weapon is an instance that tracks a magazine; armour has no reserve. */
  if (equipment.magazineSize === undefined || equipment.ammoId === undefined)
    return { ok: false, reason: 'not-a-weapon', inventory }

  const candidates = bundlesForAmmo(effects, equipment.ammoId)
  if (!candidates.length) return { ok: false, reason: 'no-matching-ammo', inventory }

  /* Deterministic pick: the first catalog bundle the stash actually holds. */
  const itemId = candidates.find((candidate) => itemQuantity(inventory, candidate, 'stash') > 0)
  if (!itemId) return { ok: false, reason: 'no-bundles', inventory }
  const yielded = bundleYield(effects, itemId)
  if (!yielded) return { ok: false, reason: 'no-matching-ammo', inventory }

  const removed = removeItem(inventory, itemId, 1, 'stash')
  /* Unreachable while the quantity check above holds; treated as a refusal so a future divergence cannot
     half-apply the transfer. */
  if (!removed.ok) return { ok: false, reason: 'no-bundles', inventory }

  const restocked: EquipmentInstance = {
    ...equipment,
    reserveAmmo: (equipment.reserveAmmo ?? 0) + yielded.amount,
  }
  return {
    ok: true,
    value: {
      inventory: {
        ...removed.inventory,
        equipment: removed.inventory.equipment.map((entry) =>
          entry.instanceId === instanceId ? restocked : entry,
        ),
      },
      equipment: restocked,
      bundlesUsed: 1,
      roundsAdded: yielded.amount,
      itemId,
    },
  }
}

/** Severity of a pre-mission finding. `blocking` still does not prevent departure — see the module note. */
export type ReadinessLevel = 'ok' | 'warning' | 'critical'

export interface ReadinessIssue {
  id: string
  level: Exclude<ReadinessLevel, 'ok'>
  /** What is wrong, in the player's terms. */
  text: string
  /** What to do about it, so the warning is actionable rather than ominous. */
  advice: string
}

export interface ReadinessReport {
  level: ReadinessLevel
  issues: ReadinessIssue[]
  /** Headline for the mission-select screen. */
  summary: string
  /** True when the operative cannot fire at all: no round chambered and no reserve. */
  outOfAmmo: boolean
  /** True when the weapon is in the jam-risk band. */
  jamRisk: boolean
}

const durabilityShare = (durability: number, maxDurability: number) =>
  maxDurability > 0 ? durability / maxDurability : 0

/**
 * Pre-mission gear check (criteria 2 and 5).
 *
 * Reads the *live* weapon state off the hero rather than the inventory instance, because that is what the
 * mission actually starts with: `hydrateArenaUnits` carries magazine, reserve and durability forward from the
 * persistent instance, and the unit is the authoritative side for anything a live encounter holds.
 *
 * The `makeshift` case is called out separately and deliberately: the shipped starter weapon is makeshift, so
 * it jams at 15% per shot at *full* durability. A check that only mentioned worn gear would stay silent on the
 * single most common cause of a lost encounter.
 */
export function missionReadiness(hero: Unit | undefined, armorInstance?: EquipmentInstance): ReadinessReport {
  const issues: ReadinessIssue[] = []
  const weapon: WeaponState | undefined = hero?.weaponState

  if (!hero || !weapon) {
    issues.push({
      id: 'no-weapon',
      level: 'critical',
      text: 'Оружия нет: дальняя атака недоступна.',
      advice: 'Выдайте оружие на базе до вылазки.',
    })
    return {
      level: 'critical',
      issues,
      summary: 'Оперативник не готов: нет оружия.',
      outOfAmmo: true,
      jamRisk: false,
    }
  }

  const outOfAmmo = weapon.magazine === 0 && weapon.reserveAmmo === 0
  if (outOfAmmo)
    issues.push({
      id: 'out-of-ammo',
      level: 'critical',
      text: 'Магазин и резерв пусты: стрелять будет нечем.',
      advice: 'Пополните боеприпасы на базе — иначе единственным выходом будет отступление без награды.',
    })
  else if (weapon.magazine === 0)
    issues.push({
      id: 'empty-magazine',
      level: 'warning',
      text: `Магазин пуст, в резерве ${weapon.reserveAmmo}.`,
      advice: 'Первым действием в бою придётся перезарядиться.',
    })

  if (weapon.malfunctioned)
    issues.push({
      id: 'jammed',
      level: 'critical',
      text: 'Оружие заклинило.',
      advice: 'Устранение осечки в бою стоит 2 ОЧ.',
    })

  const share = durabilityShare(weapon.durability, weapon.maxDurability)
  const jamRisk = malfunctionEligible(weapon)
  if (weapon.makeshift)
    issues.push({
      id: 'makeshift',
      level: 'warning',
      text: `Самодельное оружие: осечка в ${JAM_CHANCE_MAKESHIFT}% случаев на выстрел.`,
      advice: 'Риск не снижается ремонтом — его снимает только другое оружие.',
    })
  /*
   * Reported **in addition to** `makeshift`, not instead of it.
   *
   * An earlier version used `else if`, which hid the wear on exactly the weapon the player is most likely to be
   * carrying: the shipped starter `hornet` is makeshift, so a badly worn one reported only "it is makeshift" and
   * said nothing about the 12 durability left. The two facts are independent — one is unrepairable and one is
   * fixable — and the repairable one is the actionable half.
   */
  if (share < JAM_RISK_DURABILITY)
    issues.push({
      id: 'worn-weapon',
      level: 'warning',
      text: `Прочность оружия ${Math.round(share * 100)}%: ниже ${Math.round(
        JAM_RISK_DURABILITY * 100,
      )}% ${weapon.makeshift ? 'износ добавляется к риску осечки' : `начинаются осечки (${JAM_CHANCE_WORN}% на выстрел)`}.`,
      advice: 'Ремонт на базе снимет эту часть риска.',
    })

  /*
   * Armour at zero durability gives **no** protection — `armorAt` zeroes the reduction — while the combat
   * screen still prints the reduction values beside it. That gap is exactly what this warning closes.
   */
  if (armorInstance && armorInstance.durability === 0)
    issues.push({
      id: 'armor-destroyed',
      level: 'warning',
      text: 'Броня разрушена: защита не действует, хотя значения показаны.',
      advice: 'Отремонтируйте броню, чтобы снижение урона снова работало.',
    })

  const level: ReadinessLevel = issues.some((issue) => issue.level === 'critical')
    ? 'critical'
    : issues.length
      ? 'warning'
      : 'ok'
  return {
    level,
    issues,
    summary:
      level === 'ok'
        ? 'Снаряжение в порядке.'
        : level === 'critical'
          ? `Критические проблемы снаряжения: ${issues.filter((issue) => issue.level === 'critical').length}.`
          : `Предупреждения по снаряжению: ${issues.length}.`,
    outOfAmmo,
    jamRisk,
  }
}
