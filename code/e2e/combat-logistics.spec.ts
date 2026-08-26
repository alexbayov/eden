import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  gotoApp,
  persistedHero,
  readSave,
  seedRawSave,
  stackQuantity,
} from "./helpers/app";
import { MIN_TOUCH_TARGET_PX } from "./helpers/geometry";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";

/**
 * W6-05 in a real browser — restocking ammunition and the pre-mission gear check.
 *
 * The transaction is the part that could not be tested before because it did not exist:
 * `grep reserveAmmo src/game/base.ts` returned nothing, so mission-start ammunition was whatever survived the
 * last fight, and an empty reserve was a soft lock whose only exit was a rewardless retreat.
 *
 * Everything is read from the shipped catalogs or from the page's own reported state, so a balance change
 * updates both sides of an assertion rather than leaving this spec stale.
 */

const content = loadShippedContent();
/** Rounds one 9×18 bundle yields, from `item-effects.json`. */
const PISTOL_BUNDLE = (() => {
  const definition = content.itemEffects.find((entry) => entry.itemId === "pistol-rounds");
  if (!definition || definition.effect.kind !== "restore-ammo")
    throw new Error("shipped pistol-rounds effect missing");
  return definition.effect;
})();

test.describe("W6-05 restocking ammunition at the base", () => {
  test("moves a stashed bundle into the reserve and spends exactly one", async ({ page }) => {
    /* Criterion 1. The reserve rises by the catalog amount and the stash falls by one bundle, in one save. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "home", stashItems: [{ id: "pistol-rounds", quantity: 2 }] }).raw,
    );
    await gotoApp(page);

    const before = await readSave(page);
    const heroWeapon = persistedHero(before).weaponState!;
    const instanceId = heroWeapon.weaponInstanceId;
    const reserveBefore = heroWeapon.reserveAmmo;

    const button = page.locator(`button[data-restock="${instanceId}"]`);
    await expect(button).toBeVisible();
    /* Doc 14's tap-target floor applies to this control too. */
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await button.click();

    await expect
      .poll(async () => persistedHero(await readSave(page)).weaponState!.reserveAmmo)
      .toBe(reserveBefore + PISTOL_BUNDLE.amount);
    const after = await readSave(page);
    /* One bundle, not the whole stack: the reserve has no cap, so "fill it up" would decide how much a player
       should carry. */
    expect(stackQuantity(after.inventory.stash.items, "pistol-rounds")).toBe(1);
    /* The persistent instance and the live unit agree, or `syncEquipmentInstances` would overwrite one. */
    const instance = after.inventory.equipment.find((entry) => entry.instanceId === instanceId)!;
    expect(instance.durability).toBe(before.inventory.equipment.find((e) => e.instanceId === instanceId)!.durability);
    expect(errors).toEqual([]);
  });

  test("refuses when the stash holds no matching bundle, without changing anything", async ({ page }) => {
    /* The hero carries a 9×18 weapon, so rifle rounds are the wrong calibre. The refusal must be explained
       rather than silent. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "home", stashItems: [{ id: "rifle-rounds", quantity: 3 }] }).raw,
    );
    await gotoApp(page);

    const before = await readSave(page);
    const instanceId = persistedHero(before).weaponState!.weaponInstanceId;
    await page.locator(`button[data-restock="${instanceId}"]`).click();

    await expect(page.locator("p.log")).toContainText("нет подходящих боеприпасов");
    const after = await readSave(page);
    expect(stackQuantity(after.inventory.stash.items, "rifle-rounds")).toBe(3);
    expect(persistedHero(after).weaponState!.reserveAmmo).toBe(persistedHero(before).weaponState!.reserveAmmo);
  });

  test("survives a reload, so the restocked reserve is really persisted", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "home", stashItems: [{ id: "pistol-rounds", quantity: 1 }] }).raw,
    );
    await gotoApp(page);
    const instanceId = persistedHero(await readSave(page)).weaponState!.weaponInstanceId;
    await page.locator(`button[data-restock="${instanceId}"]`).click();
    await expect.poll(async () => stackQuantity((await readSave(page)).inventory.stash.items, "pistol-rounds")).toBe(0);
    const restocked = persistedHero(await readSave(page)).weaponState!.reserveAmmo;

    await page.reload();
    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);

    expect(persistedHero(await readSave(page)).weaponState!.reserveAmmo).toBe(restocked);
  });
});

test.describe("W6-05 the pre-mission gear check", () => {
  const readiness = (page: import("@playwright/test").Page) => page.locator(".readiness");

  test("warns that the shipped starter weapon jams, even at full durability", async ({ page }) => {
    /* The most common cause of a lost encounter: `hornet` is `makeshift`, so it jams at 15% per shot with a
       pristine weapon. Nothing said so before this ticket. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select" }).raw);
    await gotoApp(page);

    const panel = readiness(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-readiness", "warning");
    const makeshift = panel.locator('li[data-issue="makeshift"]');
    await expect(makeshift).toBeVisible();
    await expect(makeshift).toContainText("15%");
    /* Actionable: it says repair will not help, which is the non-obvious part. */
    await expect(makeshift).toContainText("ремонт");
  });

  test("flags an empty magazine and empty reserve as critical before departure", async ({ page }) => {
    /*
     * Criterion 5. This state was startable with no warning at all, and its only exit was a rewardless retreat —
     * `campaign-failure.spec.ts` documents that as the ammo soft lock. The warning does not block departure;
     * leaving anyway is a legitimate choice, leaving *unaware* was the defect.
     */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission-select", heroAmmo: { magazine: 0, reserveAmmo: 0 } }).raw,
    );
    await gotoApp(page);

    const panel = readiness(page);
    await expect(panel).toHaveAttribute("data-readiness", "critical");
    const issue = panel.locator('li[data-issue="out-of-ammo"]');
    await expect(issue).toBeVisible();
    await expect(issue).toContainText("отступление");
    /* Reporting, not blocking: the mission is still startable. */
    await expect(page.getByRole("button", { name: "НАЧАТЬ" })).toBeEnabled();
  });

  test("separates an empty magazine with reserve from having nothing at all", async ({ page }) => {
    /* One costs a reload, the other ends the mission. Collapsing them would make the warning useless exactly
       when it matters most. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission-select", heroAmmo: { magazine: 0, reserveAmmo: 8 } }).raw,
    );
    await gotoApp(page);

    const panel = readiness(page);
    await expect(panel).toHaveAttribute("data-readiness", "warning");
    await expect(panel.locator('li[data-issue="empty-magazine"]')).toBeVisible();
    await expect(panel.locator('li[data-issue="out-of-ammo"]')).toHaveCount(0);
  });

  test("marks a worn weapon at the threshold the combat rule actually uses", async ({ page }) => {
    /* Durability was already visible as a percentage; what was missing was any indication of the 30% line where
       `malfunctionEligible` starts jamming. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission-select", heroWeaponDurability: 10 }).raw,
    );
    await gotoApp(page);

    const panel = readiness(page);
    await expect(panel).toHaveAttribute("data-readiness", "warning");
    /* The shipped weapon is makeshift, so that issue dominates; the panel must still report the wear. */
    await expect(panel).toContainText("10%");
  });
});
