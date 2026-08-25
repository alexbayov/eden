import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  dismantleButton,
  gotoApp,
  lossNotice,
  persistedHero,
  phaseLabel,
  quickSlotButton,
  readSave,
  reloadApp,
  retreatButton,
  seedRawSave,
  stackQuantity,
} from "./helpers/app";
import { buildDefeatFixture, buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";

/**
 * W5 in a real browser — the two QA scenarios the work packages name explicitly.
 *
 * `docs/22` asks for exactly two E2E runs in W5: «применение расходника в бою» (W5-03) and an
 * «E2E-сценарий поражения» for the loot penalty (W5-05). `w5-shell.dom.test.tsx` covers both flows in
 * jsdom, which has no layout, no canvas and a mocked Phaser runtime; what it cannot show is that the
 * controls exist and work in a browser that actually rendered the combat screen. That is the gap this
 * file closes, and it is deliberately narrow: the domain rules are pinned by the unit tests, so
 * nothing here re-derives a number.
 *
 * Every expectation is read off the shipped catalogs (`item-effects.json`, `return-tables.json`), so a
 * balance edit updates both sides of an assertion at once instead of quietly invalidating the spec.
 *
 * The defeat path is made deterministic the same way `campaign-failure.spec.ts` does it —
 * `buildDefeatFixture` searches for the `rngState` whose enemy turn kills the hero using the runtime's
 * own `runEnemyTurn`. Nothing here depends on a lucky roll.
 */

const content = loadShippedContent();

/** Effect definition for an item, from content. Fails loudly rather than defaulting. */
const effectFor = (itemId: string) => {
  const definition = content.itemEffects.find((entry) => entry.itemId === itemId);
  if (!definition) throw new Error(`no shipped item effect for ${itemId}`);
  return definition;
};

const bandage = effectFor("field-bandage");
const bandageHeal = (bandage.effect as { kind: "heal"; amount: number }).amount;
const pistolRounds = effectFor("pistol-rounds");
const roundsRestored = (pistolRounds.effect as { kind: "restore-ammo"; amount: number }).amount;

test.describe("W5-03 quick-slot consumables in combat", () => {
  test("applies a bandage from the quick slot: heals, charges AP and consumes the item", async ({ page }) => {
    /* W5-03 criterion 1, in a browser: «использование бинта в бою лечит героя, списывает предмет и AP
       атомарно». The hero is seeded wounded by more than the bandage restores, so the heal is a full
       `amount` and cannot be confused with a clamp at maxHp. */
    const errors = collectConsoleErrors(page);
    const woundedBy = bandageHeal + 4;
    const fixture = buildSave(content, {
      screen: "mission",
      heroHp: 24 - woundedBy,
      backpackItems: [{ id: "field-bandage", quantity: 2 }],
      quickSlots: { 0: "field-bandage" },
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    const before = await readSave(page);
    const heroBefore = persistedHero(before);
    const slot = quickSlotButton(page, 1);
    /* The control states its price before it is used, from content rather than from a constant. */
    await expect(slot).toContainText(`${bandage.apCost} ОЧ`);
    await expect(slot).toBeEnabled();
    await expect(slot).toHaveAttribute("aria-disabled", "false");

    await slot.click();

    await expect
      .poll(async () => persistedHero(await readSave(page)).hp)
      .toBe(heroBefore.hp + bandageHeal);
    const after = await readSave(page);
    const heroAfter = persistedHero(after);
    /* One atomic save: HP, AP and the backpack all moved together. */
    expect(heroAfter.ap).toBe(heroBefore.ap - bandage.apCost);
    expect(stackQuantity(after.inventory.backpack.items, "field-bandage")).toBe(1);
    /* Still slotted, because a unit remains; the stash is untouched by a field use. */
    expect(after.inventory.quickSlots[0]).toBe("field-bandage");
    expect(stackQuantity(after.inventory.stash.items, "field-bandage")).toBe(0);
    /* Healing is not repair: durability is unchanged (the base rule, held in combat too). */
    expect(heroAfter.weaponState?.durability).toBe(heroBefore.weaponState?.durability);
    expect(errors).toEqual([]);
  });

  test("clears the slot when the last unit is spent, and survives a reload", async ({ page }) => {
    /* W5-03 criteria 3 and 4: `pruneQuickSlots` empties the slot, and the persisted save stays
       loadable — the validator requires every slotted item to be carried in the backpack, so a stale
       slot would make the next boot fail rather than merely look wrong. */
    const fixture = buildSave(content, {
      screen: "mission",
      heroHp: 10,
      backpackItems: [{ id: "field-bandage", quantity: 1 }],
      quickSlots: { 0: "field-bandage" },
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    await quickSlotButton(page, 1).click();

    await expect.poll(async () => (await readSave(page)).inventory.quickSlots[0]).toBeNull();
    const after = await readSave(page);
    expect(stackQuantity(after.inventory.backpack.items, "field-bandage")).toBe(0);
    /* The now-empty slot is still rendered and still reachable, and explains itself. */
    await expect(quickSlotButton(page, 1)).toHaveAttribute("aria-disabled", "true");
    await expect(quickSlotButton(page, 1)).toContainText("назначьте расходник на базе");

    /* The real point of the criterion: this state boots. */
    await reloadApp(page, { expect: "ready" });
    const reloaded = await readSave(page);
    expect(reloaded.inventory.quickSlots[0]).toBeNull();
    expect(persistedHero(reloaded).hp).toBe(persistedHero(after).hp);
  });

  test("refuses a full-HP heal without consuming the bandage", async ({ page }) => {
    /* W5-03 criterion 2 for the refusal that protects loot rather than state: a bandage spent at full
       HP would be an unobservable, unrecoverable loss. */
    const fixture = buildSave(content, {
      screen: "mission",
      backpackItems: [{ id: "field-bandage", quantity: 1 }],
      quickSlots: { 0: "field-bandage" },
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    const before = await readSave(page);
    expect(persistedHero(before).hp).toBe(persistedHero(before).maxHp);

    const slot = quickSlotButton(page, 1);
    /* Announced as unavailable *before* the click, so the refusal is not a surprise. */
    await expect(slot).toHaveAttribute("aria-disabled", "true");
    await expect(slot).toHaveAttribute("data-blocked", "not-wounded");
    /* `force` because the control is `aria-disabled`, not `disabled` — deliberately reachable for
       keyboard and screen-reader users, which Playwright's actionability check reads as "not enabled".
       Forcing the click is the point of the test: the handler itself must refuse, so the guard cannot
       be a styling accident that a real key press would bypass. */
    await slot.click({ force: true });

    /* Nothing was consumed and no AP was charged. */
    const after = await readSave(page);
    expect(stackQuantity(after.inventory.backpack.items, "field-bandage")).toBe(1);
    expect(persistedHero(after).ap).toBe(persistedHero(before).ap);
    expect(after.inventory.quickSlots[0]).toBe("field-bandage");
  });

  test("restores reserve ammo from a quick slot without touching the magazine", async ({ page }) => {
    /* The `restore-ammo` effect exists so an ammo-starved run has an exit that is not retreat. Reserve
       is refilled; the magazine is `reloadWeapon`'s business, and conflating the two would let one
       item both resupply and reload. */
    const fixture = buildSave(content, {
      screen: "mission",
      heroAmmo: { magazine: 1, reserveAmmo: 0 },
      backpackItems: [{ id: "pistol-rounds", quantity: 1 }],
      quickSlots: { 0: "pistol-rounds" },
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    await quickSlotButton(page, 1).click();

    await expect
      .poll(async () => persistedHero(await readSave(page)).weaponState?.reserveAmmo)
      .toBe(roundsRestored);
    const hero = persistedHero(await readSave(page));
    expect(hero.weaponState?.magazine).toBe(1);
    expect(hero.ap).toBe(10 - pistolRounds.apCost);
  });

  test("the quick-slot bar does not exist outside an active encounter", async ({ page }) => {
    /* The gating M3-D established, extended to the W5 controls: a consumable is a combat action, so
       the bar must not be reachable from the base at all. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, {
        screen: "home",
        backpackItems: [{ id: "field-bandage", quantity: 1 }],
        quickSlots: { 0: "field-bandage" },
      }).raw,
    );
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    await expect(page.locator("[data-quick-slot]")).toHaveCount(0);
    /* And the hotkey is inert here, rather than merely unbound to a visible button. */
    const before = await readSave(page);
    await page.keyboard.press("Shift+Digit1");
    expect(await readSave(page)).toEqual(before);
  });
});

test.describe("W5-04 dismantle in a real browser", () => {
  test("refuses to destroy the gear the hero is using, and the next mission still starts", async ({
    page,
  }) => {
    /*
     * The soft-lock regression, asserted where it actually bit. The shipped arenas hardcode the hero's
     * loadout (`hero-hornet`, `starter-vest`), and `hydrateArenaUnits` rebuilds `weaponState`/`armor`
     * from that template at mission start. When worn gear could be dismantled, mission start therefore
     * re-created a reference to an instance that no longer existed, `validateSave` rejected the
     * payload, and — with no equip system and no spare gear in any shipped reward — the run was over.
     * Both presses are exercised, so a regression cannot pass by only checking the first.
     */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    const worn = dismantleButton(page, "hero-hornet");
    await expect(worn).toHaveAttribute("data-blocked", "equipped");
    await expect(worn).toHaveAttribute("data-equipped", "true");
    /* Reachable so the reason is announced, but permanently unavailable. */
    await expect(worn).toHaveAttribute("aria-disabled", "true");

    const before = await readSave(page);
    /* `force` because the row is `aria-disabled` rather than `disabled`: it stays reachable so the
       reason is announced, and forcing the press is what proves the *handler* refuses instead of the
       protection resting on Playwright's actionability check. */
    await worn.click({ force: true });
    await worn.click({ force: true });

    /* No confirmation was ever armed and nothing was written. */
    await expect(page.locator("p.dismantle-confirm")).toHaveCount(0);
    expect(await readSave(page)).toEqual(before);

    /* The symptom the refusal prevents: the mission still starts and the save is still accepted. */
    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    await page.getByRole("button", { name: "НАЧАТЬ" }).click();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    const inMission = await readSave(page);
    expect(inMission.campaign.screen).toBe("mission");
    expect(persistedHero(inMission).weaponState?.weaponInstanceId).toBe("hero-hornet");
    await expect(page.locator(".save-status")).not.toContainText("Ошибка сохранения");
    expect(errors).toEqual([]);
  });

  test("destroys a spare only after an explicit second press, and pays the shipped table", async ({
    page,
  }) => {
    /* W5-04 criteria 2 and 3: the return is shown before anything is destroyed, and the destruction is
       irreversible so it cannot happen on one click. */
    const returns = content.returnTables.find((entry) => entry.itemId === "repair-kit");
    if (!returns) throw new Error("no shipped return table for repair-kit");

    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home", stashItems: [{ id: "repair-kit", quantity: 2 }] }).raw);
    await gotoApp(page);

    const kit = dismantleButton(page, "repair-kit");
    for (const [id, amount] of Object.entries(returns.returns)) {
      /* The preview names the payout, so it cannot disagree with what is paid. */
      await expect(kit).toContainText(`×${amount}`);
      expect(amount, id).toBeGreaterThan(0);
    }

    const before = await readSave(page);
    await kit.click();
    /* First press only arms; the save is untouched. */
    await expect(page.locator("p.dismantle-confirm")).toBeVisible();
    expect(await readSave(page)).toEqual(before);

    await dismantleButton(page, "repair-kit").click();

    await expect
      .poll(async () => stackQuantity((await readSave(page)).inventory.stash.items, "repair-kit"))
      .toBe(1);
    const after = await readSave(page);
    for (const [id, amount] of Object.entries(returns.returns))
      expect(stackQuantity(after.inventory.stash.resources, id), id).toBe(amount);
  });
});

test.describe("W5-05 backpack loss on defeat", () => {
  /** Backpack the loss specs start from: enough units for a 30% rate to reach whole units. */
  const carrying = { backpackMetal: 6, backpackItems: [{ id: "field-bandage", quantity: 4 }] } as const;

  test("lists what will be lost before the return is confirmed, then takes exactly that", async ({
    page,
  }) => {
    /* W5-05 criteria 1, 2 and 4 in one pass: the free first death is already spent
       (`firstDeathReturnUsed`), the player reads the list *before* pressing the CTA, and what is taken
       is what was listed. The stash is asserted separately because criterion 2 is absolute. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, {
        screen: "return",
        returnReason: "defeat",
        firstDeathReturnUsed: true,
        stashMetal: 20,
        ...carrying,
      }).raw,
    );
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");

    const notice = lossNotice(page);
    await expect(notice).toHaveAttribute("data-loss-applies", "true");
    /* The rule is labelled as an unapproved proposal while decision D-01 is open. */
    await expect(notice).toHaveAttribute("data-proposed", "true");
    await expect(notice).toContainText("D-01");
    /* And it states what is *not* taken, so the screen cannot be read as "the base was raided". */
    await expect(notice).toContainText("Stash");

    const previewed = await notice.locator("span.loss-line").evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute("data-loss-id"),
        lost: Number(node.getAttribute("data-loss-lost")),
      })),
    );
    expect(previewed.length).toBeGreaterThan(0);
    const before = await readSave(page);
    const carriedBefore = new Map<string, number>([
      ...before.inventory.backpack.resources.map((stack) => [stack.id, stack.quantity] as const),
      ...before.inventory.backpack.items.map((stack) => [stack.id, stack.quantity] as const),
    ]);
    const stashMetalBefore = stackQuantity(before.inventory.stash.resources, "metal");

    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    /* Returning deposits the surviving backpack into the stash, so the loss is measured as the
       difference between what was carried and what arrived — which is exactly the previewed list. */
    const after = await readSave(page);
    expect(after.inventory.backpack.resources).toEqual([]);
    expect(after.inventory.backpack.items).toEqual([]);
    for (const line of previewed) {
      const carried = carriedBefore.get(line.id!) ?? 0;
      const deposited = line.id === "metal"
        ? stackQuantity(after.inventory.stash.resources, line.id) - stashMetalBefore
        : stackQuantity(after.inventory.stash.items, line.id!);
      expect(deposited, `${line.id} arrived at the stash`).toBe(carried - line.lost);
    }
    expect(errors).toEqual([]);
  });

  test("takes nothing on the free first defeat, and says so", async ({ page }) => {
    /* W5-05 criterion 1. Driven through a real defeat rather than a seeded return screen, so the
       free-death bookkeeping is the runtime's own. */
    const fixture = buildDefeatFixture(content, {
      screen: "mission",
      heroHp: 2,
      heroAt: { x: 5, y: 2 },
      ...carrying,
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await page.locator("button.end").first().click();
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");

    const notice = lossNotice(page);
    await expect(notice).toHaveAttribute("data-loss-applies", "false");
    await expect(notice).toContainText("Первое поражение");
    await expect(notice).toHaveAttribute("data-loss-units", "0");

    const before = await readSave(page);
    expect(before.campaign.firstDeathReturnUsed).toBe(false);
    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    /* Everything carried arrived, and the free death is now spent. */
    const after = await readSave(page);
    expect(stackQuantity(after.inventory.stash.resources, "metal")).toBe(carrying.backpackMetal);
    expect(stackQuantity(after.inventory.stash.items, "field-bandage")).toBe(
      carrying.backpackItems[0].quantity,
    );
    expect(after.campaign.firstDeathReturnUsed).toBe(true);
  });

  test("takes nothing on a retreat, whose consequence is the forfeited reward", async ({ page }) => {
    /* W5-05 criterion 5: retreat and defeat must have visibly different consequences. Retreat already
       pays with the reward, so charging it loot as well would make the only exit from a soft-locked
       encounter the most expensive one. `firstDeathReturnUsed` is spent, so a loss would apply here if
       the reason were not checked. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", firstDeathReturnUsed: true, ...carrying }).raw,
    );
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    await retreatButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");

    const notice = lossNotice(page);
    await expect(notice).toHaveAttribute("data-loss-applies", "false");
    await expect(notice).toContainText("Отступление");
    await expect(notice).toHaveAttribute("data-loss-units", "0");

    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const after = await readSave(page);
    expect(stackQuantity(after.inventory.stash.resources, "metal")).toBe(carrying.backpackMetal);
    expect(stackQuantity(after.inventory.stash.items, "field-bandage")).toBe(
      carrying.backpackItems[0].quantity,
    );
    /* The retreat's actual price: no reward and no XP. */
    expect(after.campaign.claimedRewards).toEqual([]);
    expect(after.campaign.xp).toBe(0);
  });

  test("never touches worn equipment, whatever the backpack loses", async ({ page }) => {
    /* W5-05's out-of-scope list: «потеря экипировки» is explicitly excluded, and it is the loss that
       would be unrecoverable given the dismantle refusal above. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, {
        screen: "return",
        returnReason: "defeat",
        firstDeathReturnUsed: true,
        heroWeaponDurability: 40,
        ...carrying,
      }).raw,
    );
    await gotoApp(page);

    const before = await readSave(page);
    await expect(lossNotice(page)).toHaveAttribute("data-loss-applies", "true");
    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    /* Same instances, same durability: the penalty is a backpack rule and nothing else. */
    const after = await readSave(page);
    expect(after.inventory.equipment).toEqual(before.inventory.equipment);
    expect(persistedHero(after).weaponState?.durability).toBe(
      persistedHero(before).weaponState?.durability,
    );
  });
});
