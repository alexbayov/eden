import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  gotoApp,
  phaseLabel,
  readSave,
  seedRawSave,
  targetOptions,
} from "./helpers/app";
import { MIN_TOUCH_TARGET_PX } from "./helpers/geometry";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";
import { ATTACKS } from "../src/game/combat";

/**
 * W6-03 in a real browser — the combat readout the ticket asks for as QA.
 *
 * `combat-readout.test.ts` pins the arithmetic and `combat-readout.dom.test.tsx` proves the shell renders it;
 * what neither can show is the property criterion 5 is actually about: **the information is available without
 * hover**. jsdom has no layout and no pointer, so "visible without hovering" is not a claim it can make.
 * Here it is measured — the terms are asserted visible on an untouched page, and the numbers are read from
 * rendered geometry rather than from the DOM alone.
 *
 * Deliberately narrow. Every expectation is derived from the shipped catalogs or from the page's own reported
 * total, so a balance change updates both sides of an assertion instead of turning this spec stale.
 */

const content = loadShippedContent();
/** The hero cell with a firing line to `checkpoint-shooter`, shared with the other combat specs. */
const FIRING_POSITION = { x: 5, y: 2 };

const breakdown = (page: import("@playwright/test").Page) => page.locator(".breakdown");

/** Term values as `{ id: value }`, read from the rendered table. */
const readTerms = async (page: import("@playwright/test").Page, attribute = "data-term") =>
  Object.fromEntries(
    await page.locator(`tr[${attribute}]`).evaluateAll((rows) =>
      rows.map((row) => [
        row.getAttribute(row.hasAttribute("data-term") ? "data-term" : "data-crit-term") ?? "",
        Number(row.querySelector("td")!.getAttribute("data-term-value")),
      ]),
    ),
  ) as Record<string, number>;

test.describe("W6-03 hit breakdown in the browser", () => {
  test("shows every term and a total the terms add up to, with no hover", async ({ page }) => {
    /* Criteria 1, 2 and 5 together. The page is never hovered: the assertion is that the table is simply
       there, which is what makes the information reachable by touch and by screen reader as well. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await targetOptions(page).first().click();
    const block = breakdown(page);
    await expect(block).toBeVisible();

    const final = Number(await block.getAttribute("data-hit-final"));
    const raw = Number(await block.getAttribute("data-hit-raw"));
    const terms = await readTerms(page);
    /* All eight addends of `HitBreakdown`, including the zeroes. */
    expect(Object.keys(terms).sort()).toEqual(
      [
        "base",
        "coverPenalty",
        "partModifier",
        "postureModifier",
        "rangePenalty",
        "skillModifier",
        "statusModifier",
        "weaponModifier",
      ].sort(),
    );
    expect(Object.values(terms).reduce((sum, value) => sum + value, 0)).toBe(raw);
    /* No clamp on an ordinary torso shot, so the displayed total is the sum exactly. */
    await expect(page.locator(".breakdown-clamp")).toHaveCount(0);
    expect(raw).toBe(final);
    await expect(block).toContainText(`ШАНС ПОПАДАНИЯ ${final}%`);

    /* Every row is genuinely rendered, not merely present in the accessibility tree. */
    const rows = page.locator("tr[data-term]");
    await expect(rows).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) await expect(rows.nth(index)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("shows the crit chance, which had no UI at all before this ticket", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await targetOptions(page).first().click();

    const crit = page.locator(".crit-chance");
    await expect(crit).toBeVisible();
    const final = Number(await crit.getAttribute("data-crit-final"));
    expect(final).toBeGreaterThan(0);
    const terms = await readTerms(page, "data-crit-term");
    expect(Object.values(terms).reduce((sum, value) => sum + value, 0)).toBe(final);
    /* And what a critical does beyond the chance itself. */
    await expect(page.locator(".crit-effect")).toContainText("×1.5");
  });

  test("explains the floor when the terms sum below the minimum", async ({ page }) => {
    /* Without the note, a column summing to a negative number beside a shown 5% reads as a bug in the game.
       Blinded (−50) plus an eye shot (−40) is comfortably past the floor. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", heroAt: FIRING_POSITION, heroStatuses: { blind: 3 } }).raw,
    );
    await gotoApp(page);
    await targetOptions(page).first().click();
    await page.getByRole("button", { name: /5\. Глаз/ }).click();

    const note = page.locator(".breakdown-clamp");
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("data-clamp", "min");
    const block = breakdown(page);
    expect(Number(await block.getAttribute("data-hit-final"))).toBe(5);
    expect(Number(await block.getAttribute("data-hit-raw"))).toBeLessThan(5);
  });

  test("tracks the selected body part rather than caching one shot", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await targetOptions(page).first().click();
    const torso = Number(await breakdown(page).getAttribute("data-hit-final"));

    await page.getByRole("button", { name: /1\. Голова/ }).click();

    await expect
      .poll(async () => Number(await breakdown(page).getAttribute("data-hit-final")))
      .not.toBe(torso);
    const head = await readTerms(page);
    /* Read off the shipped attack catalog rather than restated, so a balance change updates both sides. */
    expect(head.partModifier).toBe(ATTACKS.head.aimModifier);
    /* And the AP price follows the selection too. */
    await expect(breakdown(page)).toContainText(`${ATTACKS.head.apCost} ОЧ`);
  });
});

test.describe("W6-03 statuses and posture in the browser", () => {
  test("lists active statuses with their remaining turns", async ({ page }) => {
    /* Before this the only status display was raw English keys drawn on the canvas at 9px, with the turn
       counters never shown at all. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", heroAt: FIRING_POSITION, heroStatuses: { arm: 2, blind: 3 } }).raw,
    );
    await gotoApp(page);

    const statuses = page.locator(".statuses");
    await expect(statuses).toHaveAttribute("data-status-count", "2");
    const arm = statuses.locator('li[data-status="arm"]');
    await expect(arm).toBeVisible();
    await expect(arm).toHaveAttribute("data-status-turns", "2");
    await expect(arm).toContainText("осталось ходов: 2");
    /* Described in the player's language rather than by field name. */
    await expect(statuses).toContainText("Слепота");
    await expect(statuses).not.toContainText("blind");
  });

  test("prices each posture before the press and keeps the controls tappable", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);

    const crouch = page.locator('button[data-posture="crouch"]');
    await expect(crouch).toBeVisible();
    await expect(crouch).toHaveAttribute("data-posture-cost", "1");
    await expect(crouch).toContainText("1 ОЧ");
    /* The illegal transition advertises no price and says why, rather than failing on click. */
    const prone = page.locator('button[data-posture="prone"]');
    await expect(prone).toHaveAttribute("aria-disabled", "true");
    await expect(prone).toContainText("недоступно");

    /* Doc 14's floor applies to the new controls too. */
    for (const control of [crouch, prone]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });

  test("charges exactly the advertised AP and moves the posture term", async ({ page }) => {
    /* Ties the halves together: the posture bonus is one of the breakdown terms, so a posture change must be
       visible in the hit chance rather than only in the unit state. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await targetOptions(page).first().click();
    const before = await readSave(page);
    const apBefore = before.units.find((unit) => unit.id === "hero")!.ap;
    const termBefore = (await readTerms(page)).postureModifier;

    const crouch = page.locator('button[data-posture="crouch"]');
    const cost = Number(await crouch.getAttribute("data-posture-cost"));
    await crouch.click();

    await expect.poll(async () => (await readSave(page)).units.find((u) => u.id === "hero")!.posture).toBe("crouch");
    const after = await readSave(page);
    expect(after.units.find((unit) => unit.id === "hero")!.ap).toBe(apBefore - cost);
    /* Crouching grants +5 accuracy per `POSTURES`, so the term must have moved. */
    expect((await readTerms(page)).postureModifier).toBeGreaterThan(termBefore);
  });

  test("refuses standing to prone with the rule, not with a shortage of AP", async ({ page }) => {
    /*
     * Both refusals used to be «Смена позы сейчас недоступна.», so a permanent rule was indistinguishable
     * from being two AP short. `force` because the control is `aria-disabled` rather than `disabled` — kept
     * reachable so a screen-reader user hears the reason — and forcing the press proves the *handler* refuses.
     */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    const before = await readSave(page);

    await page.locator('button[data-posture="prone"]').click({ force: true });

    await expect(page.locator(".card.log")).toContainText("присед");
    const after = await readSave(page);
    expect(after.units.find((unit) => unit.id === "hero")!.posture ?? "stand").toBe("stand");
    expect(after.units.find((unit) => unit.id === "hero")!.ap).toBe(
      before.units.find((unit) => unit.id === "hero")!.ap,
    );
  });
});
