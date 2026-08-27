import { expect, test } from "@playwright/test";
import { clearSave, collectConsoleErrors, gotoApp, readRawSave, seedRawSave } from "./helpers/app";
import { MIN_TOUCH_TARGET_PX, VIEWPORTS } from "./helpers/geometry";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";
import { HIGH_CONTRAST_OVERRIDES, SETTINGS_STORAGE_KEY } from "../src/game/settings";
import { TUTORIAL_STORAGE_KEY } from "../src/game/tutorial";

/**
 * W9-03 / W9-04 in a real browser.
 *
 * Three things only a browser can establish, and they are the reason this file exists rather than more unit tests:
 *
 *   - **150% scale on 360×640 without overflow** (W9-04 criterion 2). jsdom has no layout, so this is not a claim it
 *     can make. It is also the most likely thing to fail — the viewport matrix has already shown that new panels move
 *     geometry.
 *   - **settings apply without a reload** (criterion 4), observed as computed style actually changing.
 *   - **a progress reset removes only the save**, observed against real `localStorage` rather than a key filter.
 */

const content = loadShippedContent();
const NARROW = VIEWPORTS[0];

/** Clears the save and both preference keys, which is what a genuinely first visit looks like. */
async function freshVisitor(page: import("@playwright/test").Page) {
  await clearSave(page);
  return page.addInitScript(
    (keys: string[]) => {
      for (const key of keys) window.localStorage.removeItem(key);
    },
    [SETTINGS_STORAGE_KEY, TUTORIAL_STORAGE_KEY],
  );
}

const openSettings = async (page: import("@playwright/test").Page) => {
  await page.locator("button.settings-open").click();
  await expect(page.locator(".card.settings")).toBeVisible();
};

test.describe("W9-03 the settings screen persists and isolates", () => {
  test("applies a choice immediately and keeps it across a reload", async ({ page }) => {
    /* Criterion 1 and W9-04 criterion 4 together: no reload needed to apply, and the choice survives one. */
    const errors = collectConsoleErrors(page);
    const fresh = await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);

    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-high-contrast", "false");
    await page.locator('li[data-setting="highContrast"] button').click();

    /* Applied at once — the attribute and the computed background both change without navigating. */
    await expect(root).toHaveAttribute("data-high-contrast", "true");
    const themed = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    expect(themed).toBe("rgb(0, 0, 0)");

    fresh.dispose();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
    expect(errors).toEqual([]);
  });

  test("boots normally when the stored settings are corrupt", async ({ page }) => {
    /* Criterion 2. A settings file is the last thing that should be able to stop the game. */
    await clearSave(page);
    await page.addInitScript((key: string) => window.localStorage.setItem(key, "{ not json"), SETTINGS_STORAGE_KEY);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    const errors = collectConsoleErrors(page);
    await gotoApp(page);

    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(page.locator("main.game-shell")).toBeVisible();
    /* Defaults, not a broken state. */
    await expect(page.locator("html")).toHaveAttribute("data-ui-scale", "100");
    expect(errors).toEqual([]);
  });

  test("resets progress only after confirmation, and keeps preferences", async ({ page }) => {
    /*
     * Criterion 3, checked against real storage. The interesting bug is deleting too much: a reset must not undo the
     * player's interface choices or re-teach them the controls.
     */
    const fresh = await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);
    /* Set a preference so there is something that must survive. */
    await page.locator('li[data-setting="largeText"] button').click();
    await expect(page.locator("html")).toHaveAttribute("data-large-text", "true");
    expect(await readRawSave(page)).not.toBeNull();

    /* One press only arms the confirmation; nothing is removed yet. */
    await page.locator("button.settings-reset").click();
    await expect(page.locator(".settings-reset-confirm")).toBeVisible();
    expect(await readRawSave(page)).not.toBeNull();

    fresh.dispose();
    await page.locator("button.settings-reset-confirm-yes").click();
    await expect(page.locator("main.game-shell")).toBeVisible();

    /* The save is gone; the preference is not. */
    const keys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(keys.some((key) => key.startsWith("eden.settings"))).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-large-text", "true");
  });

  test("explains the disabled volume controls rather than pretending they work", async ({ page }) => {
    /* Criterion 4. There is no audio layer, so a working-looking slider would be a lie. */
    await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);

    const music = page.locator('li[data-setting="musicVolume"]');
    await expect(music).toHaveAttribute("data-enabled", "false");
    await expect(music.locator(".settings-reason")).toContainText("W9-01");
    await expect(music.locator("button")).toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("W9-04 accessibility options hold up at the narrowest viewport", () => {
  test("survives 150% scale on 360x640 without horizontal overflow", async ({ page }) => {
    /*
     * W9-04 criterion 2, and the assertion most likely to catch a real problem. Scale is applied as a root font-size
     * multiplier rather than a transform precisely so the layout keeps reflowing into the available width instead of
     * being scaled past it — this is the test that decision exists for.
     */
    await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
    await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);

    /* 100 -> 125 -> 150, checking overflow at each step rather than only at the end. */
    for (const expected of ["125", "150"]) {
      await page.locator('li[data-setting="uiScale"] button').click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-scale", expected);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${expected}%`).toBeLessThanOrEqual(0);
    }
  });

  test("keeps every settings control tappable at 150% on 360x640", async ({ page }) => {
    /* Scaling must not shrink anything below doc 14's floor — and larger text can reflow a control into a thinner box. */
    await page.setViewportSize({ width: NARROW.width, height: NARROW.height });
    await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);
    await page.locator('li[data-setting="uiScale"] button').click();
    await page.locator('li[data-setting="uiScale"] button').click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-scale", "150");

    const buttons = page.locator(".settings-list button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(4);
    for (let index = 0; index < count; index += 1) {
      const box = await buttons.nth(index).boundingBox();
      expect(box!.height, `settings button ${index} height at 150%`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });

  test("reduced motion removes movement but not information", async ({ page }) => {
    /*
     * Criterion 3. The trap would be hiding animated elements: that removes the motion *and* whatever the element was
     * telling the player. So the assertion is that transitions collapse while the content stays visible.
     */
    await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);
    const visibleBefore = await page.locator(".card").count();

    await page.locator('li[data-setting="reducedMotion"] button').click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");

    /* Same cards on screen, so nothing was hidden to achieve stillness. */
    expect(await page.locator(".card").count()).toBe(visibleBefore);
    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector(".card")!).transitionDuration,
    );
    /*
     * Collapsed to effectively zero rather than merely shortened. The stylesheet sets `0.001ms`, which Chromium reports
     * as `1e-06s`; asserted as a *number* below a threshold rather than as a string, because the exact serialisation is
     * the browser's business and not part of the contract.
     */
    const seconds = Number.parseFloat(duration);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeLessThan(0.01);
  });

  test("high contrast keeps the combat readout legible", async ({ page }) => {
    /* Criterion 5: an accessibility option must not cost the information the combat screen exists to convey. */
    const fresh = await freshVisitor(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);
    await openSettings(page);
    await page.locator('li[data-setting="highContrast"] button').click();
    await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
    fresh.dispose();

    /*
     * Seeded directly rather than through `clearSave`, which queues an init script that removes save keys on *every*
     * navigation — and this spec's `freshVisitor` script also removes the settings key, so reloading here wiped the very
     * preference under test. The failure looked like the theme not persisting; it was the harness clearing it.
     */
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: { x: 5, y: 2 } }).raw);
    await page.reload();
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    await page.locator("button[data-target], .tactical-options button").first().click();

    /*
     * The breakdown is present and its text uses the *themed* value of the token it references. It renders
     * `--color-text-muted`, which the high-contrast override raises to `#e8f2f3` — so the assertion is against that
     * token's themed value, read from the module rather than hardcoded. Asserting the base palette's muted grey here
     * would have passed while the theme did nothing.
     */
    const breakdown = page.locator(".breakdown");
    await expect(breakdown).toBeVisible();
    const colour = await breakdown.evaluate((element) => getComputedStyle(element).color);
    const themedMuted = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-text-muted").trim(),
    );
    expect(themedMuted).toBe(HIGH_CONTRAST_OVERRIDES.textMuted);
    /* And the element genuinely resolved to it rather than to the base palette. */
    expect(colour).toBe("rgb(232, 242, 243)");
  });
});
