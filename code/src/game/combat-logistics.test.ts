/**
 * W6-05 — logistics tests: restocking ammunition, and the pre-mission gear check.
 *
 * Two properties matter more than the individual cases:
 *
 *   - **the transfer is atomic and stash-only.** A bundle leaving the stash and rounds arriving in the reserve
 *     are one transition, so a save can never hold a spent bundle with no rounds. Refusals are checked by
 *     *reference*, so a rebuilt-but-equal inventory fails;
 *   - **the warning names the same threshold the combat rule uses.** A check that said "30%" while
 *     `malfunctionEligible` used something else would be worse than no check at all — it would teach the
 *     player a wrong number. The threshold is compared against the rule itself rather than restated.
 *
 * Nothing here restates a catalog value: bundle yields come from `item-effects.json`, and jam chances are
 * compared against `malfunctionOccurs` by probing it rather than by asserting 15 and 8 as literals.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  JAM_CHANCE_MAKESHIFT,
  JAM_CHANCE_WORN,
  JAM_RISK_DURABILITY,
  bundleYield,
  bundlesForAmmo,
  missionReadiness,
  restockAmmo,
} from './combat-logistics'
import { validateItemEffects } from './campaign-content'
import { malfunctionEligible, malfunctionOccurs, type Unit, type WeaponState } from './combat'
import { addItem, createInventory, itemQuantity, type EquipmentInstance } from './inventory'

const effects = (() => {
  const result = validateItemEffects(JSON.parse(readFileSync('public/config/item-effects.json', 'utf8')))
  if (!result.ok) throw new Error('shipped item-effects.json is invalid')
  return result.value
})()

const weaponInstance = (overrides: Partial<EquipmentInstance> = {}): EquipmentInstance => ({
  instanceId: 'pm-1',
  itemId: 'pm',
  slot: 'primary',
  durability: 100,
  maxDurability: 100,
  magazine: 8,
  magazineSize: 8,
  reserveAmmo: 0,
  ammoId: '9x18',
  ...overrides,
})
const armorInstance = (overrides: Partial<EquipmentInstance> = {}): EquipmentInstance => ({
  instanceId: 'vest-1',
  itemId: 'patched-vest',
  slot: 'torso',
  durability: 100,
  maxDurability: 100,
  ...overrides,
})

const weaponState = (overrides: Partial<WeaponState> = {}): WeaponState => ({
  weaponInstanceId: 'pm-1',
  weaponId: 'pm',
  name: 'ПМ',
  ammoId: '9x18',
  baseDamage: 20,
  accuracyModifier: 0,
  critModifier: 0,
  penetration: 0,
  ammoDamageModifier: 0,
  ammoPenetrationModifier: 0,
  magazine: 8,
  magazineSize: 8,
  reserveAmmo: 16,
  durability: 100,
  maxDurability: 100,
  durabilityPerShot: 1,
  reloadAp: 3,
  makeshift: false,
  ...overrides,
})
const hero = (weapon: WeaponState | undefined = weaponState()): Unit => ({
  id: 'hero',
  name: 'Оперативник',
  hp: 24,
  maxHp: 24,
  team: 'player',
  aim: 72,
  color: '#ffffff',
  ap: 10,
  x: 0,
  y: 0,
  weaponState: weapon,
})

/** Stash holding `quantity` of `itemId`, plus the given equipment. */
const stashWith = (itemId: string, quantity: number, equipment: EquipmentInstance[]) =>
  addItem(createInventory(20, equipment), itemId, quantity, 1, 'stash').inventory

describe('W6-05 restocking ammunition (criterion 1)', () => {
  it('moves one stashed bundle into the reserve, atomically', () => {
    /* The transaction that did not exist: `grep reserveAmmo src/game/base.ts` returned nothing, so mission-start
       ammo was whatever survived the last fight. */
    const bundle = bundleYield(effects, 'pistol-rounds')!
    const inventory = stashWith('pistol-rounds', 2, [weaponInstance({ reserveAmmo: 4 })])

    const result = restockAmmo(inventory, 'pm-1', effects)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    /* Both halves moved together: one bundle gone, its rounds arrived. */
    expect(itemQuantity(result.value.inventory, 'pistol-rounds', 'stash')).toBe(1)
    expect(result.value.equipment.reserveAmmo).toBe(4 + bundle.amount)
    expect(result.value.roundsAdded).toBe(bundle.amount)
    expect(result.value.bundlesUsed).toBe(1)
    /* And the instance in the returned inventory carries the same reserve as the reported one. */
    expect(result.value.inventory.equipment.find((entry) => entry.instanceId === 'pm-1')?.reserveAmmo).toBe(
      4 + bundle.amount,
    )
  })

  it('matches the bundle to the weapon calibre, from the shipped catalog', () => {
    /* Driven by `item-effects.json` rather than a fixture, so a new calibre is covered automatically and a
       mismatched one cannot pass. */
    for (const definition of effects.filter((entry) => entry.effect.kind === 'restore-ammo')) {
      const ammoId = (definition.effect as { kind: 'restore-ammo'; ammoId: string }).ammoId
      expect(bundlesForAmmo(effects, ammoId)).toContain(definition.itemId)
      const inventory = stashWith(definition.itemId, 1, [weaponInstance({ ammoId })])
      const result = restockAmmo(inventory, 'pm-1', effects)
      expect(result.ok, definition.itemId).toBe(true)
    }
  })

  it('refuses a calibre the stash cannot feed, without touching anything', () => {
    /* Refusal checked by reference: a rebuilt-but-equal inventory would mean the transaction ran and undid
       itself, which is not the same guarantee. */
    const inventory = stashWith('rifle-rounds', 3, [weaponInstance({ ammoId: '9x18' })])
    const result = restockAmmo(inventory, 'pm-1', effects)
    expect(result).toMatchObject({ ok: false, reason: 'no-bundles' })
    if (result.ok) return
    expect(result.inventory).toBe(inventory)
  })

  it('refuses an empty stash, an unknown instance and a non-weapon', () => {
    const empty = createInventory(20, [weaponInstance()])
    expect(restockAmmo(empty, 'pm-1', effects)).toMatchObject({ ok: false, reason: 'no-bundles' })
    expect(restockAmmo(empty, 'missing', effects)).toMatchObject({ ok: false, reason: 'unknown-equipment' })
    /* Armour has no reserve to fill, and asking must not be a silent no-op. */
    const withArmor = stashWith('pistol-rounds', 1, [armorInstance()])
    expect(restockAmmo(withArmor, 'vest-1', effects)).toMatchObject({ ok: false, reason: 'not-a-weapon' })
  })

  it('reports no matching ammo when the catalog has no bundle for the calibre', () => {
    const inventory = stashWith('pistol-rounds', 1, [weaponInstance({ ammoId: 'plasma' })])
    expect(restockAmmo(inventory, 'pm-1', effects)).toMatchObject({ ok: false, reason: 'no-matching-ammo' })
  })

  it('never touches the backpack, so a packed run is not silently changed', () => {
    /* Stash-only for the same reason every other base transaction is: the backpack is what the player committed
       to carrying, and quietly spending from it would change the weight budget behind their back. */
    const inventory = addItem(createInventory(20, [weaponInstance()]), 'pistol-rounds', 2, 1, 'backpack').inventory
    const result = restockAmmo(inventory, 'pm-1', effects)
    expect(result).toMatchObject({ ok: false, reason: 'no-bundles' })
    if (result.ok) return
    expect(itemQuantity(result.inventory, 'pistol-rounds', 'backpack')).toBe(2)
  })

  it('adds one bundle per call rather than filling the reserve', () => {
    /* Deliberate: the reserve has no cap in the data model, so "fill it up" would silently decide how much
       ammunition a player should carry — a balance decision this ticket has no mandate to make. */
    const bundle = bundleYield(effects, 'pistol-rounds')!
    let inventory = stashWith('pistol-rounds', 3, [weaponInstance({ reserveAmmo: 0 })])
    for (let call = 1; call <= 3; call += 1) {
      const result = restockAmmo(inventory, 'pm-1', effects)
      expect(result.ok, `call ${call}`).toBe(true)
      if (!result.ok) return
      inventory = result.value.inventory
      expect(result.value.equipment.reserveAmmo).toBe(bundle.amount * call)
    }
    expect(itemQuantity(inventory, 'pistol-rounds', 'stash')).toBe(0)
  })
})

describe('W6-05 the pre-mission check names the rule it warns about', () => {
  it('uses the same durability threshold as the combat rule', () => {
    /*
     * The property that makes the warning worth having. A check that said 30% while `malfunctionEligible` used
     * a different line would teach the player a wrong number, which is worse than silence. Probed against the
     * rule rather than compared to a literal.
     */
    const justBelow = weaponState({ durability: Math.floor(100 * JAM_RISK_DURABILITY) - 1, makeshift: false })
    const justAbove = weaponState({ durability: Math.ceil(100 * JAM_RISK_DURABILITY) + 1, makeshift: false })
    expect(malfunctionEligible(justBelow)).toBe(true)
    expect(malfunctionEligible(justAbove)).toBe(false)
    expect(missionReadiness(hero(justBelow)).jamRisk).toBe(true)
    expect(missionReadiness(hero(justAbove)).jamRisk).toBe(false)
    expect(missionReadiness(hero(justBelow)).issues.map((issue) => issue.id)).toContain('worn-weapon')
  })

  it('quotes jam chances that match what the roll actually does', () => {
    /* Probed by finding the highest roll that still jams, so the displayed numbers are tied to
       `malfunctionOccurs` rather than duplicated from it. */
    const highestJamming = (weapon: WeaponState) => {
      for (let roll = 100; roll >= 1; roll -= 1) if (malfunctionOccurs(weapon, roll)) return roll
      return 0
    }
    expect(highestJamming(weaponState({ makeshift: true }))).toBe(JAM_CHANCE_MAKESHIFT)
    expect(highestJamming(weaponState({ makeshift: false, durability: 10 }))).toBe(JAM_CHANCE_WORN)
  })

  it('reports wear on a makeshift weapon too, rather than only the makeshift risk', () => {
    /*
     * Found by the browser spec. An `else if` hid the wear on exactly the weapon the player is most likely to
     * carry — the shipped starter `hornet` is makeshift — so a badly worn one said only "it is makeshift" and
     * nothing about the durability left. The two facts are independent: one is unrepairable, the other is the
     * actionable half.
     */
    const worn = missionReadiness(hero(weaponState({ makeshift: true, durability: 12, maxDurability: 100 })))
    const ids = worn.issues.map((issue) => issue.id)
    expect(ids).toContain('makeshift')
    expect(ids).toContain('worn-weapon')
    expect(worn.issues.find((issue) => issue.id === 'worn-weapon')!.text).toContain('12%')
    /* An intact makeshift weapon reports only the unrepairable risk. */
    expect(missionReadiness(hero(weaponState({ makeshift: true, durability: 100 }))).issues.map((i) => i.id)).toEqual([
      'makeshift',
    ])
  })

  it('warns about a makeshift weapon even at full durability', () => {
    /* The most common cause of a lost encounter: the shipped starter weapon is makeshift, so it jams at 15% per
       shot with a pristine weapon. A check that only mentioned wear would stay silent on it. */
    const report = missionReadiness(hero(weaponState({ makeshift: true, durability: 100, maxDurability: 100 })))
    expect(report.jamRisk).toBe(true)
    expect(report.issues.map((issue) => issue.id)).toContain('makeshift')
    const issue = report.issues.find((entry) => entry.id === 'makeshift')!
    expect(issue.text).toContain(String(JAM_CHANCE_MAKESHIFT))
    /* And it says the risk is not repairable, which is the actionable part. */
    expect(issue.advice).toContain('ремонт')
  })

  it('flags an empty magazine and empty reserve as critical', () => {
    /* Criterion 5: this state was startable with no warning at all, and its only exit was a rewardless retreat. */
    const report = missionReadiness(hero(weaponState({ magazine: 0, reserveAmmo: 0 })))
    expect(report.outOfAmmo).toBe(true)
    expect(report.level).toBe('critical')
    const issue = report.issues.find((entry) => entry.id === 'out-of-ammo')!
    expect(issue.advice).toContain('отступление')
  })

  it('separates an empty magazine with reserve from having nothing at all', () => {
    /* Different situations: one costs a reload, the other ends the mission. Collapsing them would make the
       warning useless exactly when it matters. */
    const report = missionReadiness(hero(weaponState({ magazine: 0, reserveAmmo: 8 })))
    expect(report.outOfAmmo).toBe(false)
    expect(report.level).toBe('warning')
    expect(report.issues.map((issue) => issue.id)).toContain('empty-magazine')
  })

  it('reports a jammed weapon and a missing weapon distinctly', () => {
    expect(missionReadiness(hero(weaponState({ malfunctioned: true }))).issues.map((i) => i.id)).toContain('jammed')
    /* Built by deletion rather than `hero(undefined)`: the helper defaults its parameter, so passing `undefined`
       would hand back a fully armed unit and the assertion would silently test nothing. */
    const unarmed = { ...hero(), weaponState: undefined }
    const none = missionReadiness(unarmed)
    expect(none.level).toBe('critical')
    expect(none.issues.map((issue) => issue.id)).toContain('no-weapon')
    expect(none.outOfAmmo).toBe(true)
    /* No hero at all is the same finding rather than a crash. */
    expect(missionReadiness(undefined).level).toBe('critical')
    expect(missionReadiness(undefined).issues.map((issue) => issue.id)).toContain('no-weapon')
  })

  it('warns that destroyed armour shows protection it no longer provides', () => {
    /*
     * `armorAt` zeroes the reduction at 0 durability while the combat screen still prints the reduction values
     * beside it. The invariant is right and the display is misleading, so the warning closes the gap.
     */
    const report = missionReadiness(hero(), armorInstance({ durability: 0 }))
    expect(report.issues.map((issue) => issue.id)).toContain('armor-destroyed')
    /* Intact armour raises nothing. */
    expect(missionReadiness(hero(), armorInstance({ durability: 100 })).issues.map((i) => i.id)).not.toContain(
      'armor-destroyed',
    )
  })

  it('says the gear is fine when it is, rather than staying blank', () => {
    /* "No issues" and "the panel failed to render" must not look the same. */
    const report = missionReadiness(hero(weaponState({ makeshift: false })), armorInstance())
    expect(report.level).toBe('ok')
    expect(report.issues).toEqual([])
    expect(report.summary).toContain('порядке')
  })

  it('gives every issue an actionable next step', () => {
    /* A warning without advice is just ominous. Asserted across a board that raises several at once. */
    const report = missionReadiness(
      hero(weaponState({ magazine: 0, reserveAmmo: 0, malfunctioned: true, makeshift: true })),
      armorInstance({ durability: 0 }),
    )
    expect(report.issues.length).toBeGreaterThan(2)
    for (const issue of report.issues) {
      expect(issue.text.length, issue.id).toBeGreaterThan(0)
      expect(issue.advice.length, issue.id).toBeGreaterThan(0)
    }
    /* Critical outranks warning in the overall level. */
    expect(report.level).toBe('critical')
  })
})
