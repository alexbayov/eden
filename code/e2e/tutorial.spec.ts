import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  gotoApp,
  phaseLabel,
  seedRawSave,
  targetOptions,
} from "./helpers/app";
import { MIN_TOUCH_TARGET_PX, VIEWPORTS } from "./helpers/geometry";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";
import { TUTORIAL_STORAGE_KEY } from "../src/game/tutorial";

/**
 * W7-05 in a real browser — onboarding hints.
 *
 * `tutorial.test.ts` proves the sequence has no gaps. Two things only a browser can show:
 *
 *   - **criterion 2, that hints never block.** In jsdom "the control is reachable" is a DOM fact; here it is
 *     measured by actually clicking through the game *with a hint on screen* and checking the action went through;
 *   - **criterion 4, keyboard and 360×640.** jsdom has no layout, so tap-target size and the narrow viewport are
 *     not claims it can make.
 *
 * The tutorial lives outside the save, so these specs clear its own storage key explicitly — a `clearSave` alone
 * would leave a previous run's progress behind and the hints would not appear.
 */

const content = loadShippedContent();
const FIRING_POSITION = { x: 5, y: 2 };
const tutorial = (page: import("@playwright/test").Page) => page.locator(".tutorial");

/**
 * Clears both the save and the tutorial preference, which is what a genuinely first session looks like.
 *
 * The returned disposer **must** be called before any `page.reload()` in a spec that reloads. `addInitScript` runs
 * before *every* navigation, so an undisposed handle re-deletes the preference on reload and the tutorial reappears
 * — which looks exactly like a persistence bug. `helpers/app.ts` disposes its own seeding scripts for the same
 * reason, and this is the second time that trap has cost a debugging session.
 */
async function freshPlayer(page: import("@playwright/test").Page): Promise<{ dispose: () => void }> {
  await clearSave(page);
  return page.addInitScript((key: string) => window.localStorage.removeItem(key), TUTORIAL_STORAGE_KEY);
}

test.describe("W7-05 a first session is guided", () => {
  test("greets a brand-new player on the base screen", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    const hint = tutorial(page);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute("data-tutorial-step", "welcome");
    /* Numbered, so the player can see how much is left rather than facing an open-ended drip. */
    await expect(hint).toContainText("1/");
    await expect(hint).toContainText("ВЫБРАТЬ МИССИЮ");
    expect(errors).toEqual([]);
  });

  test("moves through the combat lessons as the player acts", async ({ page }) => {
    /* The derived-position design, observed end to end: the hint follows the board rather than a stored counter, so
       it cannot describe a state the player has already left. */
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    /* Untouched hero: the lesson is movement. */
    await expect(tutorial(page)).toHaveAttribute("data-tutorial-step", "move");

    /* Selecting a target with full AP moves the lesson on to the body part and the breakdown. */
    await targetOptions(page).first().click();
    await expect(tutorial(page)).toHaveAttribute("data-tutorial-step", "body-part");
  });

  test("explains the reward screen and then crafting back at base", async ({ page }) => {
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "reward" }).raw);
    await gotoApp(page);
    await expect(tutorial(page)).toHaveAttribute("data-tutorial-step", "claim-reward");

    await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    /* With a win banked there are resources to spend, so the base lesson changes. */
    await expect(tutorial(page)).toHaveAttribute("data-tutorial-step", "craft");
  });
});

test.describe("W7-05 hints never block the game (criterion 2)", () => {
  test("lets the player act while a hint is on screen", async ({ page }) => {
    /*
     * The property that matters most. A tutorial that must be dismissed before the player can do anything is worse
     * than none in a genre whose players expect to poke at things. Here the hint is left untouched and the game is
     * played through it.
     */
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await expect(tutorial(page)).toBeVisible();

    /* No overlay intercepting pointer events: the target list is clickable with the hint still up. */
    await targetOptions(page).first().click();
    await expect(page.locator(".breakdown")).toBeVisible();
    await expect(tutorial(page)).toBeVisible();

    /* And the keyboard path is equally unobstructed — `1` selects a body part. */
    await page.keyboard.press("1");
    await expect(page.locator(".breakdown")).toBeVisible();
  });

  test("switches hints off for good, everywhere, and can switch them back on", async ({ page }) => {
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    await page.locator("button.tutorial-dismiss").click();
    await expect(tutorial(page)).toHaveCount(0);

    /* Off on other screens too, not merely on the one where the button was pressed. */
    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    await expect(tutorial(page)).toHaveCount(0);

    /* Reversible: dismissing is a preference, not a trap. */
    await page.getByRole("button", { name: "НАЗАД НА БАЗУ" }).click();
    await page.locator("button.tutorial-resume").click();
    await expect(tutorial(page)).toBeVisible();
  });

  test("remembers the preference across a reload, and across a save reset", async ({ page }) => {
    /*
     * Criteria 3 and 5 together. The tutorial lives under its own key precisely so that wiping a campaign does not
     * re-teach a returning player the controls — checked here by clearing the *save* and confirming the preference
     * survives.
     */
    const fresh = await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await page.locator("button.tutorial-dismiss").click();
    await expect(tutorial(page)).toHaveCount(0);

    /* Disposed before reloading: otherwise the init script wipes the preference again on every navigation and the
       reappearing hint reads as a persistence bug rather than a harness artefact. */
    fresh.dispose();
    await page.reload();
    await expect(tutorial(page)).toHaveCount(0);

    /* Save gone, preference kept. */
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage))
        if (key.startsWith("eden.save")) window.localStorage.removeItem(key);
    });
    await page.reload();
    await expect(page.locator("main.game-shell")).toBeVisible();
    await expect(tutorial(page)).toHaveCount(0);
  });

  test("survives a malformed preference instead of failing to boot", async ({ page }) => {
    /* A broken preference must never stop the game: it falls back to showing the tutorial. */
    await clearSave(page);
    await page.addInitScript((key: string) => window.localStorage.setItem(key, "{ not json"), TUTORIAL_STORAGE_KEY);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    const errors = collectConsoleErrors(page);
    await gotoApp(page);

    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(tutorial(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("W7-05 hints are usable on the narrowest supported screen (criterion 4)", () => {
  test("fits 360x640 with tappable controls and no horizontal overflow", async ({ page }) => {
    /* doc 14's minimum width. jsdom cannot make this claim: it has no layout. */
    const narrow = VIEWPORTS[0];
    expect(narrow.width).toBe(360);
    await page.setViewportSize({ width: narrow.width, height: narrow.height });
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    const hint = tutorial(page);
    await expect(hint).toBeVisible();
    for (const control of ["button.tutorial-advance", "button.tutorial-dismiss"]) {
      const box = await page.locator(control).boundingBox();
      expect(box!.height, control).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.width, control).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    /* The panel must not push the page sideways. */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("is reachable and operable from the keyboard alone", async ({ page }) => {
    /* Criterion 4's other half. Both controls are real buttons, so they take focus and respond to Enter. */
    await freshPlayer(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    const advance = page.locator("button.tutorial-advance");
    await advance.focus();
    await expect(advance).toBeFocused();
    const dismiss = page.locator("button.tutorial-dismiss");
    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expect(tutorial(page)).toHaveCount(0);
  });
});
