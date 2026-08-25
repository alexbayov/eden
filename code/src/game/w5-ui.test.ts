/**
 * W5 UI integration — pure tests for the three view/action layers added on top of the W5 domain.
 *
 * These are the layers the DOM tests cannot pin cheaply: every refusal reason, every price, and the
 * "preview equals payout" property. Kept pure so they run in milliseconds and so a failure names the
 * rule rather than a missing button.
 *
 * The shipped catalogs drive everything: AP costs, heal amounts and return tables are read from
 * `public/config`, never restated, so editing content exercises these immediately instead of
 * silently invalidating an assertion.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  validateItemEffects,
  validateItems,
  validateReturnTables,
  type ItemDefinition,
  type ItemEffectDefinition,
  type ReturnTableDefinition,
} from './campaign-content'
import { effectForItem } from './consumables'
import { PROPOSED_BACKPACK_LOSS_POLICY } from './death-loss'
import { buildDeathLossView } from './death-loss-view'
import { buildDismantlePanel } from './dismantle-view'
import { dismantleEquipment, returnsFor } from './dismantle'
import { unlinkDestroyedEquipment } from './equipment-content'
import { resolveCombatShortcut } from './input-gating'
import { quickSlotBlocker, repairableInField, useQuickSlot } from './quick-slot'
import { buildQuickSlotBar, describeQuickSlotBlocker, quickSlotShortcutLabel } from './quick-slot-view'
import {
  addItem,
  addResource,
  assignQuickSlot,
  createInventory,
  itemQuantity,
  resourceQuantity,
  type EquipmentInstance,
  type Inventory,
} from './inventory'
import type { ArmorState, Unit, WeaponState } from './combat'

const shipped = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown
const parsed = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!result.ok) throw result.error
  return result.value
}
const items = parsed(validateItems(shipped('items'))) as ItemDefinition[]
const effects = parsed(validateItemEffects(shipped('item-effects'))) as ItemEffectDefinition[]
const returnTable = parsed(validateReturnTables(shipped('return-tables'))) as ReturnTableDefinition[]

/** Content-driven expectations, so no number below is a literal copied out of a JSON file. */
const bandage = effectForItem(effects, 'field-bandage')!
const pistolRounds = effectForItem(effects, 'pistol-rounds')!
const repairKit = effectForItem(effects, 'repair-kit')!

const weaponState = (overrides: Partial<WeaponState> = {}): WeaponState => ({
  weaponInstanceId: 'pm-1',
  weaponId: 'pm',
  name: 'ПМ',
  ammoId: '9x18',
  baseDamage: 6,
  accuracyModifier: 0,
  critModifier: 0,
  penetration: 0,
  ammoDamageModifier: 0,
  ammoPenetrationModifier: 0,
  magazine: 4,
  magazineSize: 8,
  reserveAmmo: 8,
  durability: 100,
  maxDurability: 100,
  durabilityPerShot: 2,
  reloadAp: 2,
  makeshift: false,
  ...overrides,
})
const armorState = (overrides: Partial<ArmorState> = {}): ArmorState => ({
  armorInstanceId: 'vest-1',
  armorId: 'patched-vest',
  reduction: { torso: 3 },
  durability: 100,
  maxDurability: 100,
  ...overrides,
})
const heroUnit = (overrides: Partial<Unit> = {}): Unit => ({
  id: 'hero',
  name: 'Оперативник',
  team: 'player',
  x: 1,
  y: 4,
  hp: 12,
  maxHp: 24,
  aim: 72,
  color: '#65d7ff',
  ap: 10,
  posture: 'stand',
  statuses: {},
  weaponState: weaponState(),
  armor: armorState(),
  ...overrides,
})
const pistol = (): EquipmentInstance => ({ instanceId: 'pm-1', itemId: 'pm', slot: 'primary', durability: 100, maxDurability: 100 })
const vest = (durability = 100): EquipmentInstance => ({ instanceId: 'vest-1', itemId: 'patched-vest', slot: 'torso', durability, maxDurability: 100 })

/** Inventory carrying `itemId` in the backpack with slot 0 assigned to it. */
function carrying(itemId: string, quantity = 2, equipment = [pistol(), vest()]): Inventory {
  const weight = items.find((item) => item.id === itemId)?.weight ?? 1
  const stocked = addItem(createInventory(40, equipment), itemId, quantity, weight, 'backpack').inventory
  const assigned = assignQuickSlot(stocked, 0, itemId)
  if (!assigned.ok) throw new Error(`fixture: ${assigned.reason}`)
  return assigned.inventory
}

describe('W5-03 quick slot in combat', () => {
  /* `hero` has no default: a default parameter would swallow an explicit `undefined` and silently
     turn the "no hero" case into a test of the fully-equipped one. */
  const context = (inventory: Inventory, hero: Unit | undefined, phase: 'player' | 'enemy' = 'player') => ({
    hero,
    inventory,
    effects,
    phase,
  })

  it('heals the hero, charges the content AP price and consumes exactly one unit', () => {
    const inventory = carrying('field-bandage', 2)
    const hero = heroUnit({ hp: 12 })
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const healed = result.value.units.find((unit) => unit.id === 'hero')!
    /* Both numbers come from `item-effects.json`, not from this file. */
    expect(healed.hp).toBe(12 + (bandage.effect as { amount: number }).amount)
    expect(healed.ap).toBe(hero.ap - bandage.apCost)
    expect(result.value.apCost).toBe(bandage.apCost)
    expect(itemQuantity(result.value.inventory, 'field-bandage', 'backpack')).toBe(1)
    expect(result.value.slotCleared).toBe(false)
    /* Nothing else about the hero moved: a heal is not a repair and not a reload. */
    expect(healed.weaponState).toEqual(hero.weaponState)
    expect(healed.armor).toEqual(hero.armor)
    expect(result.value.inventory.stash).toBe(inventory.stash)
    expect(result.value.inventory.equipment).toBe(inventory.equipment)
  })

  it('caps the heal at maxHp and clears the slot when the last unit is spent', () => {
    const inventory = carrying('field-bandage', 1)
    const hero = heroUnit({ hp: 23 })
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.units.find((unit) => unit.id === 'hero')!.hp).toBe(24)
    expect(result.value.applied).toBe('+1 HP')
    expect(result.value.slotCleared).toBe(true)
    expect(result.value.inventory.quickSlots).toEqual([null, null, null, null])
  })

  it('refuses a full-HP heal so the bandage is not wasted', () => {
    const inventory = carrying('field-bandage', 2)
    const hero = heroUnit({ hp: 24 })
    expect(quickSlotBlocker(context(inventory, hero), 0)).toBe('not-wounded')
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result).toMatchObject({ ok: false, reason: 'not-wounded' })
    /* And the refusal consumed nothing: the item count is the check, not the inventory identity,
       because a refusal never even reaches the domain function. */
    expect(itemQuantity(inventory, 'field-bandage', 'backpack')).toBe(2)
  })

  it('refuses every other invalid use with a distinct reason and consumes nothing', () => {
    const withBandage = carrying('field-bandage', 1)
    const withRounds = carrying('pistol-rounds', 1)
    /* `hero` is always given explicitly, including as `undefined`, so an optional-property lookup
       cannot silently substitute the default and turn the "no hero" case into a passing accident. */
    const cases: { label: string; inventory: Inventory; hero: Unit | undefined; phase?: 'player' | 'enemy'; index: number; reason: string }[] = [
      { label: 'negative index', inventory: withBandage, hero: heroUnit(), index: -1, reason: 'index' },
      { label: 'index past the last slot', inventory: withBandage, hero: heroUnit(), index: 9, reason: 'index' },
      { label: 'unassigned slot', inventory: withBandage, hero: heroUnit(), index: 2, reason: 'empty-slot' },
      { label: 'enemy phase', inventory: withBandage, hero: heroUnit(), phase: 'enemy', index: 0, reason: 'not-player-turn' },
      { label: 'no hero', inventory: withBandage, hero: undefined, index: 0, reason: 'no-hero' },
      { label: 'downed hero', inventory: withBandage, hero: heroUnit({ hp: 0 }), index: 0, reason: 'no-hero' },
      { label: 'not enough AP', inventory: withBandage, hero: heroUnit({ ap: bandage.apCost - 1 }), index: 0, reason: 'insufficient-ap' },
      { label: 'ammo without a weapon', inventory: withRounds, hero: heroUnit({ weaponState: undefined }), index: 0, reason: 'no-weapon' },
      {
        label: 'ammo for the wrong calibre',
        inventory: withRounds,
        hero: heroUnit({ weaponState: weaponState({ ammoId: '7x39' }) }),
        index: 0,
        reason: 'wrong-ammo',
      },
      { label: 'repair with undamaged gear', inventory: carrying('repair-kit', 1), hero: heroUnit(), index: 0, reason: 'nothing-to-repair' },
    ]
    for (const entry of cases) {
      const ctx = context(entry.inventory, entry.hero, entry.phase ?? 'player')
      expect(quickSlotBlocker(ctx, entry.index), entry.label).toBe(entry.reason)
      const result = useQuickSlot(ctx, ctx.hero ? [ctx.hero] : [], entry.index)
      expect(result, entry.label).toMatchObject({ ok: false, reason: entry.reason })
      /* Every blocker has a player-facing sentence: a silent refusal is not acceptable. */
      expect(describeQuickSlotBlocker(entry.reason as never, bandage.apCost, 0).length, entry.label).toBeGreaterThan(0)
    }
  })

  it('restores reserve ammo of the matching calibre only', () => {
    const inventory = carrying('pistol-rounds', 1)
    const hero = heroUnit()
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const effect = pistolRounds.effect as { ammoId: string; amount: number }
    const next = result.value.units.find((unit) => unit.id === 'hero')!
    expect(next.weaponState!.reserveAmmo).toBe(hero.weaponState!.reserveAmmo + effect.amount)
    /* The magazine is `reloadWeapon`'s business, so a bundle must not quietly load it. */
    expect(next.weaponState!.magazine).toBe(hero.weaponState!.magazine)
    expect(next.hp).toBe(hero.hp)
  })

  it('repairs the most damaged linked instance, never HP and never a stash spare', () => {
    const inventory = carrying('repair-kit', 1, [pistol(), vest(40)])
    /* Armour at 40% is worse than the weapon at 90%, so the kit must pick the armour. */
    const hero = heroUnit({ weaponState: weaponState({ durability: 90 }), armor: armorState({ durability: 40 }) })
    expect(repairableInField(hero).map((entry) => entry.instanceId)).toEqual(['vest-1', 'pm-1'])
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const amount = (repairKit.effect as { amount: number }).amount
    const next = result.value.units.find((unit) => unit.id === 'hero')!
    expect(next.armor!.durability).toBe(40 + amount)
    expect(next.weaponState!.durability).toBe(90)
    expect(next.hp).toBe(hero.hp)
    /*
     * The durability is written to the *unit*, not to the inventory copy: `persist` runs
     * `syncEquipmentInstances(inventory, units)`, which copies unit state onto the instance, so
     * writing both here would create a second writer for one number.
     */
    expect(result.value.inventory.equipment.find((entry) => entry.instanceId === 'vest-1')!.durability).toBe(40)
  })

  it('never over-repairs past maxDurability', () => {
    const amount = (repairKit.effect as { amount: number }).amount
    const inventory = carrying('repair-kit', 1, [pistol(), vest(100 - 1)])
    const hero = heroUnit({ weaponState: weaponState({ durability: 100 }), armor: armorState({ durability: 99 }) })
    const result = useQuickSlot(context(inventory, hero), [hero], 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.units.find((unit) => unit.id === 'hero')!.armor!.durability).toBe(100)
    expect(result.value.applied).toBe('durability брони +1')
    expect(amount).toBeGreaterThan(1)
  })

  it('builds a bar of exactly four slots, priced from content, with a reason on every unavailable one', () => {
    const inventory = carrying('field-bandage', 3)
    const bar = buildQuickSlotBar({ hero: heroUnit({ hp: 10 }), inventory, effects, phase: 'player' })
    expect(bar.options).toHaveLength(4)
    expect(bar.options[0]).toMatchObject({
      slotNumber: 1,
      itemId: 'field-bandage',
      quantity: 3,
      apCost: bandage.apCost,
      available: true,
      disabled: false,
      reason: '',
    })
    expect(bar.options[0].ariaLabel).toContain(quickSlotShortcutLabel(0))
    expect(bar.options[0].ariaLabel).toContain('Доступно')
    expect(bar.anyAvailable).toBe(true)
    /* Empty slots still render — the bar is also the carried-loot readout — and each says why. */
    for (const option of bar.options.slice(1)) {
      expect(option.itemId).toBeNull()
      expect(option.blocked).toBe('empty-slot')
      expect(option.disabled).toBe(true)
      expect(option.reason.length).toBeGreaterThan(0)
      expect(option.ariaLabel).toContain('Недоступно')
    }
  })

  it('reports the whole bar as unavailable off-turn without hiding what is carried', () => {
    const inventory = carrying('field-bandage', 2)
    const bar = buildQuickSlotBar({ hero: heroUnit({ hp: 10 }), inventory, effects, phase: 'enemy' })
    expect(bar.anyAvailable).toBe(false)
    expect(bar.options[0]).toMatchObject({ itemId: 'field-bandage', quantity: 2, blocked: 'not-player-turn' })
    expect(bar.summary).toContain('Сейчас не ваш ход')
  })

  it('binds Shift+digit, leaving the bare digits to body parts', () => {
    for (const index of [0, 1, 2, 3])
      expect(resolveCombatShortcut({ key: String(index + 1), code: `Digit${index + 1}`, shiftKey: true }, 'mission', 'player')).toEqual({
        action: 'use-quick-slot',
        index,
      })
    /* The US-layout Shift+1 character, so the binding is not layout-dependent. */
    expect(resolveCombatShortcut({ key: '!', code: 'Digit1', shiftKey: true }, 'mission', 'player')).toEqual({
      action: 'use-quick-slot',
      index: 0,
    })
    /* Bare digits still aim, and Shift+5 is not a slot. */
    expect(resolveCombatShortcut({ key: '1', code: 'Digit1' }, 'mission', 'player')).toMatchObject({ action: 'select-body-part' })
    expect(resolveCombatShortcut({ key: '%', code: 'Digit5', shiftKey: true }, 'mission', 'player')).toBeNull()
    /* And the gate still applies: no quick slot outside an active player turn. */
    expect(resolveCombatShortcut({ key: '1', code: 'Digit1', shiftKey: true }, 'home', 'player')).toBeNull()
    expect(resolveCombatShortcut({ key: '1', code: 'Digit1', shiftKey: true }, 'mission', 'enemy')).toBeNull()
  })
})

describe('W5-04 dismantle panel', () => {
  const inventoryWithGear = () => {
    let inventory = createInventory(40, [pistol(), vest(50)])
    inventory = addItem(inventory, 'repair-kit', 2, 2, 'stash').inventory
    inventory = addResource(inventory, 'metal', 10, 1, 'stash').inventory
    return inventory
  }

  it('previews exactly what the shipped table pays, for gear and for stashed items', () => {
    const panel = buildDismantlePanel({ inventory: inventoryWithGear(), returnTable, units: [] })
    const byId = new Map(panel.options.map((option) => [option.id, option]))
    /* Expectations read off the table, so a content edit changes both sides together. */
    expect(byId.get('pm-1')!.returns).toEqual(returnsFor(returnTable, 'pm'))
    expect(byId.get('vest-1')!.returns).toEqual(returnsFor(returnTable, 'patched-vest'))
    expect(byId.get('repair-kit')!.returns).toEqual(returnsFor(returnTable, 'repair-kit'))
    expect(byId.get('repair-kit')!.quantityLabel).toBe('×2')
    /* Gear states its condition and the competing repair price, so the choice is comparable. */
    expect(byId.get('vest-1')!.conditionLabel).toBe('50% durability')
    expect(byId.get('vest-1')!.repairCostLabel).toContain('ремонт')
    expect(byId.get('pm-1')!.repairCostLabel).toBe('')
    /* Nothing is worn here (`units: []`), so every entry is a destructible spare awaiting its
       confirmation press. */
    for (const option of panel.options) {
      expect(option.requiresConfirmation, option.id).toBe(true)
      expect(option.disabled, option.id).toBe(false)
      expect(option.ariaLabel).toContain('Возврат:')
      expect(option.ariaLabel).toContain('необратимо')
    }
  })

  it('never offers gear the hero is using, and offers spares behind one confirmation', () => {
    const inventory = inventoryWithGear()
    const units = [heroUnit({ armor: armorState({ durability: 50 }) })]
    const panel = buildDismantlePanel({ inventory, returnTable, units })
    const worn = panel.options.find((option) => option.id === 'vest-1')!
    expect(worn.equipped).toBe(true)
    /*
     * Not a prompt: worn gear can never be dismantled. Destroying it soft-locked the run, because the
     * arena templates hardcode the hero's loadout and there is no equip system to fit a replacement.
     * Listed rather than hidden so «почему нельзя разобрать жилет» has an answer.
     */
    expect(worn).toMatchObject({ blocked: 'equipped', available: false, disabled: true, requiresConfirmation: false })
    expect(worn.reason).toContain('нельзя разобрать')
    expect(worn.ariaLabel).toContain('Недоступно')
    expect(panel.summary).toContain('Снаряжение героя')
    expect(panel.pendingConfirmation).toBeNull()
    /* The weapon the same hero holds is equally protected. */
    expect(panel.options.find((option) => option.id === 'pm-1')!.blocked).toBe('equipped')

    /* Arming the worn entry changes nothing: it is not a confirmable action. */
    const forced = buildDismantlePanel({ inventory, returnTable, units, confirmingId: 'vest-1' })
    expect(forced.options.find((option) => option.id === 'vest-1')!).toMatchObject({
      blocked: 'equipped',
      available: false,
      disabled: true,
    })
    expect(forced.pendingConfirmation).toBeNull()

    /* A spare stashed item is destructible, and takes exactly one confirmation. */
    const spare = panel.options.find((option) => option.id === 'repair-kit')!
    expect(spare).toMatchObject({ blocked: 'needs-confirmation', requiresConfirmation: true, disabled: false })
    const armedSpare = buildDismantlePanel({ inventory, returnTable, units, confirmingId: 'repair-kit' })
    expect(armedSpare.options.find((option) => option.id === 'repair-kit')!).toMatchObject({
      confirming: true,
      available: true,
      requiresConfirmation: false,
    })
    expect(armedSpare.pendingConfirmation?.id).toBe('repair-kit')
  })

  it('marks a no-return item as unavailable rather than offering a pointless destruction', () => {
    const inventory = addItem(createInventory(40, [{ ...pistol(), instanceId: 'mystery-1', itemId: 'mystery-gun' }]), 'salvaged-parts', 1, 1, 'stash').inventory
    const panel = buildDismantlePanel({ inventory, returnTable, units: [] })
    const unknown = panel.options.find((option) => option.id === 'mystery-1')!
    expect(unknown).toMatchObject({ blocked: 'no-yield', available: false, disabled: true })
    expect(unknown.returnsLabel).toBe('ничего')
    expect(unknown.reason).toContain('не даёт возврата')
    /* `salvaged-parts` does have a table, so this list is not uniformly a dead end: it is offered,
       behind the confirmation every irreversible destruction requires. */
    const parts = panel.options.find((option) => option.id === 'salvaged-parts')!
    expect(parts).toMatchObject({ blocked: 'needs-confirmation', disabled: false, requiresConfirmation: true })
    expect(
      buildDismantlePanel({ inventory, returnTable, units: [], confirmingId: 'salvaged-parts' }).options.find(
        (option) => option.id === 'salvaged-parts',
      )!.available,
    ).toBe(true)
    /* Arming the zero-return entry stays inert: there is nothing to confirm. */
    expect(
      buildDismantlePanel({ inventory, returnTable, units: [], confirmingId: 'mystery-1' }).pendingConfirmation,
    ).toBeNull()
  })

  it('never offers a backpack item, so a packed run is not silently unpacked', () => {
    const inventory = addItem(createInventory(40, []), 'repair-kit', 1, 2, 'backpack').inventory
    const panel = buildDismantlePanel({ inventory, returnTable, units: [] })
    expect(panel.options).toHaveLength(0)
    expect(panel.summary).toContain('Разбирать нечего')
  })

  /**
   * The desync `unlinkDestroyedEquipment` exists to prevent.
   *
   * `syncEquipmentInstances` only copies unit state *onto* a matching instance; it has no opinion
   * about a unit still pointing at an instance that has been destroyed. Left alone, dismantling a
   * spare that a stale unit still names produces a hero whose `armorInstanceId` resolves to nothing —
   * a state the save validator rejects, i.e. an action that either cannot be saved or writes a payload
   * the next boot cannot load. Asserted at this level because the DOM test can only observe the
   * symptom. The instance is dismantled *without* being passed as linked, which is exactly the case
   * this guards: the inventory and the unit list disagreeing about what still exists.
   */
  it('drops unit references to destroyed instances, and only those', () => {
    const inventory = createInventory(40, [pistol(), vest()])
    const hero = heroUnit()
    const enemy: Unit = { ...heroUnit({ id: 'raider', team: 'enemy' }), armor: armorState({ armorInstanceId: 'raider-armor' }) }

    const afterVest = dismantleEquipment(inventory, 'vest-1', returnTable, { confirmed: true })
    expect(afterVest.ok).toBe(true)
    if (!afterVest.ok) return
    const [unlinkedHero, unlinkedEnemy] = unlinkDestroyedEquipment(afterVest.value.inventory, [hero, enemy])
    expect(unlinkedHero.armor).toBeUndefined()
    /* Only the destroyed link is dropped: the weapon survives untouched. */
    expect(unlinkedHero.weaponState).toEqual(hero.weaponState)
    /* Enemy gear has no inventory instance and must not be stripped by a base-side action. */
    expect(unlinkedEnemy).toBe(enemy)

    /* Nothing destroyed means nothing rebuilt, so an ordinary persist stays reference-stable. */
    expect(unlinkDestroyedEquipment(inventory, [hero, enemy])[0]).toBe(hero)
  })
})

describe('W5-05 death loss view', () => {
  const carried = () => {
    let inventory = createInventory(40, [vest()])
    inventory = addResource(inventory, 'metal', 100, 1, 'stash').inventory
    inventory = addResource(inventory, 'metal', 6, 1, 'backpack').inventory
    inventory = addItem(inventory, 'field-bandage', 4, 1, 'backpack').inventory
    return inventory
  }
  const view = (overrides: Partial<Parameters<typeof buildDeathLossView>[0]> = {}) =>
    buildDeathLossView({
      inventory: carried(),
      policy: PROPOSED_BACKPACK_LOSS_POLICY,
      reason: 'defeat',
      firstDeathReturnUsed: true,
      /* Item names come from the shipped catalog, exactly as the shell supplies them. */
      labelFor: (itemId: string) => items.find((item) => item.id === itemId)?.name ?? itemId,
      ...overrides,
    })

  it('previews the exact inventory it will commit, and takes nothing outside the backpack', () => {
    const preview = view()
    expect(preview.applies).toBe(true)
    expect(preview.carriedUnits).toBe(10)
    expect(preview.lostUnits).toBe(3)
    expect(preview.lines.map((line) => line.text)).toEqual(['Металл ×2 из 6', 'Полевой бинт ×1 из 4'])
    /* Preview and payout are one computation: the numbers in `lines` describe `inventory` itself. */
    const source = carried()
    const committed = buildDeathLossView({
      inventory: source,
      policy: PROPOSED_BACKPACK_LOSS_POLICY,
      reason: 'defeat',
      firstDeathReturnUsed: true,
    }).inventory!
    expect(resourceQuantity(committed, 'metal', 'backpack')).toBe(4)
    expect(itemQuantity(committed, 'field-bandage', 'backpack')).toBe(3)
    /* The base is untouched by *reference*, so a rebuilt-but-equal stash would fail this. */
    expect(committed.stash).toBe(source.stash)
    expect(committed.equipment).toBe(source.equipment)
    expect(resourceQuantity(committed, 'metal', 'stash')).toBe(100)
    expect(preview.safetyNote).toContain('Stash')
  })

  it('labels the rule as an unapproved proposal while D-01 is open', () => {
    const preview = view()
    expect(preview.proposed).toBe(true)
    expect(preview.ratePercent).toBe(Math.round(PROPOSED_BACKPACK_LOSS_POLICY.rate * 100))
    expect(preview.policyLabel).toContain('D-01')
    expect(preview.policyLabel).toContain('без эскалации')
    /* An approved policy drops the caveat and nothing else changes. */
    const approved = view({ proposed: false })
    expect(approved.policyLabel).not.toContain('D-01')
    expect(approved.lines).toEqual(preview.lines)
  })

  it('distinguishes the free first death, a retreat, and a backpack too small to charge', () => {
    const free = view({ firstDeathReturnUsed: false })
    expect(free).toMatchObject({ applies: false, inventory: null, lostUnits: 0 })
    expect(free.skippedReason).toContain('Первое поражение')

    const retreat = view({ reason: 'retreat' })
    expect(retreat).toMatchObject({ applies: false, inventory: null })
    expect(retreat.skippedReason).toContain('Отступление')
    /* The two must not share one sentence: doc 12 requires visibly different consequences. */
    expect(retreat.skippedReason).not.toBe(free.skippedReason)

    const tiny = view({ inventory: addResource(createInventory(40, []), 'metal', 3, 1, 'backpack').inventory })
    expect(tiny).toMatchObject({ applies: true, lostUnits: 0 })
    expect(tiny.summary).toContain('округляются в ноль')
    /* An empty-loss success still carries an inventory to commit: it is simply unchanged. */
    expect(tiny.inventory).not.toBeNull()
  })

  it('commits nothing when the policy itself is invalid', () => {
    const broken = view({ policy: { ...PROPOSED_BACKPACK_LOSS_POLICY, rate: 1.5 } })
    expect(broken).toMatchObject({ applies: false, inventory: null })
    expect(broken.skippedReason).toContain('отклонена')
  })
})
