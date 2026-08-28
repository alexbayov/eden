import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  clearSave,
  fireButton,
  gotoApp,
  missionCard,
  phaseLabel,
  retreatButton,
  seedRawSave,
  targetOptions,
} from "./helpers/app";
import {
  assertNoOverflow,
  assertTouchTargets,
  measureCta,
  MIN_TOUCH_TARGET_PX,
  resetScroll,
  VIEWPORTS,
  type ViewportSpec,
} from "./helpers/geometry";
import { buildSave, loadShippedContent, orderedEncounters } from "../src/test/campaign-save-fixtures";

/**
 * W1-05 — the first *measured* geometry assertions in this repository.
 *
 * Before this file, every geometry claim came from `responsive-css.test.ts`, which reads the
 * stylesheet as text. That proves a `min-height: 44px` rule was written; it cannot prove the rule
 * matched, or that a flex parent did not compress the control anyway. Here Chromium lays the page out
 * at five real viewport sizes and the numbers come from `getBoundingClientRect` and `scrollWidth`.
 *
 * Coverage: five viewports x **five** screens. `reward` and `return` were missing from the original
 * matrix, which mattered: they are the two screens a player is *forced* through after every
 * encounter, and their primary actions (`ЗАБРАТЬ НАГРАДУ`, `ВЕРНУТЬСЯ НА БАЗУ`) are the only way
 * out of them.
 *
 * Result summary, so a reader does not have to infer it from the assertions:
 *
 *   • No horizontal overflow at any of the five viewports, on any of the five screens.
 *   • No interactive element measures below 44x44 CSS px at any viewport.
 *   • All six body-part controls are present, correctly sized and operable at 390x844.
 *   • On the two phone-width viewports (360x640, 390x844) **every** primary CTA is within the fold
 *     and genuinely inside the viewport, because the `max-width: 760px` block promotes each screen's
 *     primary action to a `position: fixed` bottom bar. Both reward and return CTAs are additionally
 *     *operated* there, so "within the fold" is not merely a rectangle claim.
 *   • On the three wider viewports (768x1024, 1280x720, 800x400) only the base-screen CTA clears the
 *     fold, and at 800x400 not even that. See `documents the measured CTA fold position` for the
 *     numbers, the root cause and why this is recorded as a finding rather than asserted away.
 *
 * W5 UPDATE — the base screen's CTA is now pinned at phone widths too. The W5 base panel (stash
 * overview, node ladder, craft/upgrade/dismantle catalogs) pushed «ВЫБРАТЬ МИССИЮ» from y≈515 to
 * y≈745, so at 360x640 it left the fold; `.campaign.home .home-panel .primary-actions` now joins the
 * `max-width: 760px` fixed-bar group. The wide-viewport baseline moved in the other direction for two
 * cases and is updated there.
 *
 * SCOPE LIMIT, stated because it is easy to overclaim: these are headless-Chromium measurements at a
 * CSS viewport size. They are not device tests. Device pixel ratio, browser chrome, on-screen
 * keyboards, safe-area insets, touch input and WebKit are all untested here (W2-05, W2-06). Pixel
 * baselines are W1-08.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [firstEncounter] = encounters;

/** Every screen that owns a primary call to action. */
interface ScreenCase {
  name: "home" | "mission-select" | "combat" | "reward" | "return";
  raw: string;
  /** The screen's single most important action. */
  cta: (page: Page) => Locator;
  /** Combat mounts a canvas asynchronously; measuring before it lands would measure a shorter page. */
  waitForCanvas: boolean;
}

/**
 * The `reward` and `return` payloads come from the same `buildSave` the other cases use, so they are
 * checked by the runtime `validateSave` at fixture-build time (it throws on an impossible state) and
 * cannot describe a save the game would refuse to load. `buildSave` also mirrors the runtime's own
 * post-victory bookkeeping for the reward screen — encounter `completed`, next encounter unlocked,
 * reward still unclaimed — which is why the claim button renders enabled rather than locked out.
 */
const SCREENS: readonly ScreenCase[] = [
  {
    name: "home",
    raw: buildSave(content, { screen: "home" }).raw,
    cta: (page) => page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }),
    waitForCanvas: false,
  },
  {
    name: "mission-select",
    raw: buildSave(content, { screen: "mission-select" }).raw,
    cta: (page) => missionCard(page, firstEncounter.name).getByRole("button", { name: "НАЧАТЬ" }),
    waitForCanvas: false,
  },
  {
    name: "combat",
    raw: buildSave(content, { screen: "mission" }).raw,
    cta: (page) => fireButton(page),
    waitForCanvas: true,
  },
  {
    name: "reward",
    raw: buildSave(content, { screen: "reward" }).raw,
    cta: (page) => page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }),
    /* No canvas on the reward screen: the shell renders the campaign layout, not the battlefield. */
    waitForCanvas: false,
  },
  {
    name: "return",
    raw: buildSave(content, { screen: "return" }).raw,
    cta: (page) => page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }),
    waitForCanvas: false,
  },
] as const;

/** Looks a screen up by name, so index drift cannot silently repoint a test at another screen. */
const screenCase = (name: ScreenCase["name"]): ScreenCase => {
  const found = SCREENS.find((entry) => entry.name === name);
  if (!found) throw new Error(`unknown screen case: ${name}`);
  return found;
};

/**
 * Viewports narrow enough for the `@media (max-width: 760px)` block, which is what turns each
 * screen's primary action into a fixed bottom bar. The predicate is on *width* only, deliberately:
 * that is exactly what the stylesheet keys on, and it is why 800x400 does not get the bar.
 */
const STICKY_CTA_WIDTH_PX = 760;

/**
 * How far from the fold a measurement must sit before its *boolean* is treated as a fact.
 *
 * `withinFold` is a threshold on a measured page height, and that height depends on text metrics.
 * `index.css` asks for `Inter` and falls back to `ui-sans-serif`/`system-ui`, and **no webfont is
 * bundled**, so the shipped app genuinely lays out at different heights on different machines: the
 * campaign screens are mostly wrapped prose, and one extra wrapped line per paragraph moves the CTA
 * by tens of pixels. This is a real property of the build, not a test artefact, which is why it is
 * absorbed here rather than "fixed" by pinning a font that production does not ship.
 *
 * Measured evidence for the number: `768x1024/reward` sits 73px above the fold on a developer machine
 * and *below* it on the GitHub Actions runner — the same commit, no repository change, a shift of at
 * least 73px from fonts alone. 96px is chosen to cover that observed shift with room to spare while
 * staying well under the smallest genuinely-below-the-fold margin in the table (188px), so every other
 * case keeps its boolean as a gate.
 *
 * A case inside this band is **recorded, not asserted**: its margin is still measured and its
 * reachability still checked, but claiming to know which side of the fold it lands on would be
 * asserting the runner's font set as though it were the layout.
 */
const FOLD_STABILITY_MARGIN_PX = 96;

/** Boots one screen at one viewport and settles the layout before anything is measured. */
async function openScreen(page: Page, viewport: ViewportSpec, screen: ScreenCase): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await clearSave(page);
  await seedRawSave(page, screen.raw);
  await gotoApp(page);
  if (screen.waitForCanvas) await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
  /* Measure from the top of the document, never from wherever a previous action scrolled to. */
  await resetScroll(page);
}

/* Five viewports x five screens = 25 measured combinations. */
for (const viewport of VIEWPORTS) {
  test.describe(`W1-05 geometry at ${viewport.name} (${viewport.orientation}) — ${viewport.rationale}`, () => {
    for (const screen of SCREENS) {
      test(`${screen.name}: no horizontal overflow and every target at least ${MIN_TOUCH_TARGET_PX}px`, async ({
        page,
      }) => {
        await openScreen(page, viewport, screen);

        /* Acceptance criterion 2. */
        const overflow = await assertNoOverflow(page, `${viewport.name}/${screen.name}`);
        expect(overflow.documentClientWidth).toBe(viewport.width);

        /* Acceptance criterion 1, by measurement rather than by stylesheet text. */
        const measured = await assertTouchTargets(page, `${viewport.name}/${screen.name}`);
        expect(measured).toBeGreaterThan(0);
      });
    }
  });
}

test.describe("W1-05 primary CTA reachability", () => {
  test("base screen CTA is visible and clickable without scrolling in portrait", async ({ page }) => {
    /* Acceptance criterion 3, in the case where it holds. 360x640 is the criterion's own viewport;
       the other portrait sizes are included because a taller viewport cannot make it worse. */
    const home = screenCase("home");
    for (const viewport of VIEWPORTS.filter((entry) => entry.orientation === "portrait")) {
      await openScreen(page, viewport, home);
      const cta = home.cta(page);
      const measurement = await measureCta(page, cta, viewport);

      expect(
        measurement.withinFold,
        `${viewport.name}: base CTA at y=${measurement.y} must fit inside ${viewport.height}px`,
      ).toBe(true);
      expect(measurement.clickable).toBe(true);
      expect(measurement.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(measurement.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      /* Clickable where it sits, with no scrolling: Playwright fails the click otherwise. */
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await cta.click({ trial: true });
    }
  });

  test("every primary CTA is within the fold at phone widths", async ({ page }) => {
    /* THE ACTUAL REQUIREMENT, now met at phone widths.
     *
     * W1-05 acceptance criterion 3 asks that «главный CTA каждого экрана видим и кликабелен без
     * прокрутки на 360×640». At 360x640 and 390x844 that now holds for all five screens: the
     * `@media (max-width: 760px)` block promotes each screen's primary action to a fixed bottom bar,
     * so the CTA sits at y=584 (360x640) / y=788 (390x844) regardless of how tall the page is — and
     * the pages are now very tall indeed (the base screen measures ~4000px at 360x640 with the W5
     * catalogs), which is exactly why the base CTA had to join the bar rather than stay in flow.
     *
     * Asserted per case rather than as one snapshot object, so a failure names the screen that broke
     * instead of printing a fifteen-entry diff. `withinFold` is a rectangle test against the
     * unscrolled viewport, so it is paired with `toBeInViewport` — a fixed element could in principle
     * be within the fold geometrically while covered or clipped, and the two together rule that out. */
    for (const viewport of VIEWPORTS.filter((entry) => entry.width <= STICKY_CTA_WIDTH_PX)) {
      for (const screen of SCREENS) {
        await openScreen(page, viewport, screen);
        const cta = screen.cta(page);
        const measurement = await measureCta(page, cta, viewport);
        const label = `${viewport.name}/${screen.name}`;

        expect(
          measurement.withinFold,
          `${label}: CTA at y=${measurement.y} height=${measurement.height} must fit inside ${viewport.height}px without scrolling`,
        ).toBe(true);
        expect(measurement.height, `${label} CTA height`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(measurement.width, `${label} CTA width`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        /* No scrolling happened, and Chromium agrees the control is inside the viewport. */
        expect(await page.evaluate(() => window.scrollY), `${label}: measured from an unscrolled page`).toBe(0);
        await expect(cta, `${label}: CTA must be inside the viewport unscrolled`).toBeInViewport();
      }
    }
  });

  test("keeps the primary CTA above the fold at every width, not only phone widths", async ({
    page,
  }) => {
    /*
     * W2-F — this used to be a *record of a defect* and is now a requirement.
     *
     * The fixed bottom bar was keyed on `max-width: 760px`, so 768x1024, 1280x720 and 800x400 kept their CTA in normal
     * flow and lost the fold: measured overruns of 66 to 2178 px, the S2 defect in doc 24 §7.2. It is closed by a second,
     * narrow media block that repeats *only* the pinning for viewports that are `max-width: 1100px` (stacked layout) or
     * `max-height: 820px` (too short). Both conditions are needed and neither suffices: 1280x720 and 800x400 are short,
     * while 768x1024 is tall enough yet stacks its content into a ~3000 px page — keying on height alone left it broken,
     * which is how I found out.
     *
     * The mobile layout block stayed at 760px on purpose. It also restacks the battlefield, collapses the HUD and shrinks
     * type; dragging all of that onto a 1280x720 desktop to move one button would be an unrequested layout change.
     *
     * WHY THE MARGIN BAND SURVIVES. `withinFold` is a threshold on a measured page height, and that height depends on
     * text metrics: `index.css` asks for `Inter`, no webfont is bundled, so a machine without it lays the same DOM out at
     * a different height. The band is what stopped `1280x720/home` from being pinned as a comfortable pass when it was
     * 91 px from flipping — and it did flip, to −66 px, before this fix. Now every case is pinned by the fixed bar and
     * sits ~12 px from the fold by construction, so the band no longer excuses anything; it is kept because the reward
     * screen's CTA is not pinned on every viewport and its margin still comes from layout.
     */
    const foldByCase: Record<string, boolean> = {};
    const marginByCase: Record<string, number> = {};

    for (const viewport of VIEWPORTS.filter((entry) => entry.width > STICKY_CTA_WIDTH_PX)) {
      for (const screen of SCREENS) {
        await openScreen(page, viewport, screen);
        const cta = screen.cta(page);
        const measurement = await measureCta(page, cta, viewport);
        const label = `${viewport.name}/${screen.name}`;
        foldByCase[label] = measurement.withinFold;
        /* Signed distance from the fold: positive is room to spare, negative is how far past it sits. */
        marginByCase[label] = viewport.height - (measurement.y + measurement.height);

        /* Regardless of fold position, the control must be a legal target and actually reachable
           once scrolled to — that is what stops this from being an unusable screen. ОГОНЬ starts
           disabled by design (no target selected yet), so reachability is asserted by visibility
           after scrolling; the enabled-and-clickable path for combat is covered by
           `the combat action sequence is operable end to end at 360x640`. */
        expect(measurement.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(measurement.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        await cta.scrollIntoViewIfNeeded();
        await expect(cta).toBeVisible();
        await expect(cta).toBeInViewport();
      }
    }

    /* Measured, on the current build. Only the base screen clears the fold, and only where the
       viewport is tall enough to hold the header plus the home panel above the button.

       W5 UPDATE — `768x1024/reward` and `768x1024/return` were `true` before W5 and are now `false`.
       Nothing regressed in the fixed-bar rules: at 768px wide there is no bar to begin with, and both
       screens simply grew taller than 1024px. Reward gained the level/XP readout, and return gained
       the backpack-loss preview (`W5-05`), which is a multi-line list above the CTA by design. The
       table is updated to the measurement rather than the layout being changed to fit it, because
       W1-05's baseline is a record of where the CTA actually sits.

       Measured margins on a developer machine, recorded so the numbers below are checkable rather than
       asserted from memory: 768x1024 home +329, reward −73, return −188, mission-select −1788;
       1280x720 home +91, reward −311, return −385; 800x400 loses the fold by 295 or more everywhere.
       Two cases fall inside the font-stability band and are therefore deliberately **absent** from the
       table below: `768x1024/reward` (−73) and `1280x720/home` (+91). Both are measured and both keep
       their reachability checks; what is not claimed is which side of the fold they land on, because
       that answer belongs to the machine's fonts rather than to the layout. `1280x720/home` is the
       instructive one — it reads as a comfortable pass locally and is only 91px from flipping, so
       pinning it would have been the next version of the failure this band exists to stop. */
    /*
     * Every screen, on every viewport above the sticky breakpoint, must now clear the fold. Stated as one rule rather
     * than a per-case table: the table existed to record which cases were broken, and none are.
     */
    for (const [label, margin] of Object.entries(marginByCase)) {
      expect(margin, `${label}: expected a measurement`).toBeDefined();
      expect(
        foldByCase[label],
        `${label}: CTA sits ${margin.toFixed(0)}px from the fold — the primary action must be reachable without scrolling`,
      ).toBe(true);
      /* The margin's sign and the boolean are the same fact, so they must agree. */
      expect(margin > 0, `${label}: margin sign must agree with the measured fold value`).toBe(foldByCase[label]);
    }

    /*
     * Coverage floor, restated for the fixed state.
     *
     * The font-stability band was built for CTAs positioned by *flow*, whose distance from the fold is a function of the
     * page height and therefore of text metrics. A **pinned** CTA is 12 px from the fold by construction — `bottom:
     * calc(12px + env(safe-area-inset-bottom))` — so it sits inside the band permanently, and no font can move it. My
     * first version of this floor demanded 10 cases outside the band and failed with 0 of 15: the fix had made every case
     * pinned. That is the floor measuring the wrong thing, not a regression.
     *
     * So the floor now asserts what actually matters: that most cases are pinned, i.e. their margin is the *small,
     * deliberate* offset rather than a large layout-dependent one. A case drifting far from 12 px means it stopped being
     * pinned, which is the regression this guards.
     */
    const pinnedMargins = Object.entries(marginByCase).filter(([, margin]) => margin >= 0 && margin <= FOLD_STABILITY_MARGIN_PX);
    expect(
      pinnedMargins.length,
      `only ${pinnedMargins.length} of ${Object.keys(marginByCase).length} CTAs sit at the pinned offset; the rest are positioned by flow and could drift past the fold`,
    ).toBeGreaterThanOrEqual(10);
    /* Every viewport contributes at least one pinned case, so none can lose its bar unnoticed. */
    for (const viewport of VIEWPORTS.filter((entry) => entry.width > STICKY_CTA_WIDTH_PX))
      expect(
        pinnedMargins.some(([label]) => label.startsWith(`${viewport.name}/`)),
        `${viewport.name}: no CTA is pinned on this viewport, so its bar was lost`,
      ).toBe(true);
  });

  test("the combat action sequence is operable end to end at 360x640", async ({ page }) => {
    /* The practical version of criterion 3: even with the CTA below the fold, a player on the
       narrowest supported viewport can still select a target and fire. Without this, "below the
       fold" could hide a genuinely unusable screen. */
    const viewport = VIEWPORTS[0];
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: { x: 5, y: 2 } }).raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    const target = targetOptions(page).first();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeEnabled();
    await target.click();

    const fire = fireButton(page);
    await fire.scrollIntoViewIfNeeded();
    await expect(fire).toBeEnabled();
    const fireBox = await fire.boundingBox();
    expect(fireBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    /* The retreat exit is reachable on the same viewport — it is the only way out of a soft lock. */
    const retreat = retreatButton(page);
    await retreat.scrollIntoViewIfNeeded();
    await expect(retreat).toBeEnabled();

    await fire.click();
    /* Firing resolved: either the encounter continues or it was won. Both leave a usable screen. */
    await expect(phaseLabel(page)).toHaveText(/ВАШ ХОД|НАГРАДА/);
    await assertNoOverflow(page, `${viewport.name}/combat after firing`);
  });

  test("the reward CTA is operable where it sits at 360x640", async ({ page }) => {
    /* Proves the reward fixture is a *live* state and not just a validator-legal rectangle: the CTA
       is clicked without any scrolling, the claim actually resolves, and the shell leaves the reward
       screen. Without this, "within the fold" could describe a fixed bar that is inert or covered. */
    const viewport = VIEWPORTS[0];
    const reward = screenCase("reward");
    await openScreen(page, viewport, reward);
    await expect(phaseLabel(page)).toHaveText("НАГРАДА");

    const cta = reward.cta(page);
    await expect(cta).toBeInViewport();
    await expect(cta).toBeEnabled();
    /* No `scrollIntoViewIfNeeded`: the click has to land from the unscrolled position. */
    await cta.click();

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    await assertNoOverflow(page, `${viewport.name}/reward after claiming`);
  });

  test("the return CTA is operable where it sits at 360x640", async ({ page }) => {
    /* The same proof for the defeat exit — the only way off the return screen. */
    const viewport = VIEWPORTS[0];
    const returnScreen = screenCase("return");
    await openScreen(page, viewport, returnScreen);
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");

    const cta = returnScreen.cta(page);
    await expect(cta).toBeInViewport();
    await expect(cta).toBeEnabled();
    await cta.click();

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    await assertNoOverflow(page, `${viewport.name}/return after returning to base`);
  });
});

test.describe("W1-05 combat controls at the primary mobile target", () => {
  test("all six body parts are present, correctly sized and selectable at 390x844", async ({ page }) => {
    /* Acceptance criterion 4, measured and exercised: presence alone would not catch a control that
       is laid out but unusable. */
    const viewport = VIEWPORTS.find((entry) => entry.name === "390x844")!;
    await openScreen(page, viewport, screenCase("combat"));

    const parts = page.locator(".action-tray .actions button");
    await expect(parts).toHaveCount(6);

    const expectedLabels = ["Голова", "Торс", "Рука", "Нога", "Глаз", "Пах"];
    for (const [index, label] of expectedLabels.entries()) {
      const part = parts.nth(index);
      await expect(part).toContainText(label);
      await part.scrollIntoViewIfNeeded();
      const box = await part.boundingBox();
      expect(box!.width, `body part ${label} width`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.height, `body part ${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      /* Selecting it marks it active, so the control is wired and not decorative. */
      await part.click();
      await expect(part).toHaveClass(/active/);
    }

    await assertNoOverflow(page, "390x844/combat body parts");
  });

  test("the tactical panel and weapon controls stay on screen at 360x640", async ({ page }) => {
    /* The tactical panel holds the only reload and clear-malfunction controls, so it must survive
       the narrowest viewport rather than being clipped. */
    const viewport = VIEWPORTS[0];
    await openScreen(page, viewport, screenCase("combat"));

    await expect(page.getByRole("heading", { name: "Тактическое управление" })).toBeVisible();
    const maintenance = page.getByRole("group", { name: "Обслуживание оружия" });
    await maintenance.scrollIntoViewIfNeeded();
    await expect(maintenance).toBeVisible();

    for (const control of ["reload", "clear-jam"]) {
      const button = page.locator(`[data-control="${control}"]`);
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box!.width, `${control} width`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.height, `${control} height`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      /* Inside the viewport horizontally, which is what "not clipped" means here. */
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    await assertNoOverflow(page, "360x640/combat tactical panel");
  });

  test("the canvas never forces horizontal scrolling on a short landscape phone", async ({ page }) => {
    /* 800x400 is the viewport the `max-height: 480px and (orientation: landscape)` rule exists for.
       The canvas is the widest element on the combat screen, so it is the likeliest overflow source. */
    const viewport = VIEWPORTS.find((entry) => entry.name === "800x400")!;
    await openScreen(page, viewport, screenCase("combat"));

    const canvas = page.locator(".canvas-wrap canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);

    await assertNoOverflow(page, "800x400/combat canvas");
    await assertTouchTargets(page, "800x400/combat canvas");
  });
});

test.describe("W1-05 recovery screen geometry", () => {
  test("the recovery screen fits and keeps its reset control tappable at 360x640", async ({ page }) => {
    /* Recovery is the one screen a player reaches involuntarily, so an unusable reset button there
       would strand them. Not in the original criteria list; included because the cost is one test. */
    const viewport = VIEWPORTS[0];
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await clearSave(page);
    await seedRawSave(page, "{ not valid json");
    await gotoApp(page, { expect: "recovery" });
    await resetScroll(page);

    const reset = page.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" });
    const measurement = await measureCta(page, reset, viewport);
    expect(measurement.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(measurement.withinFold, "the recovery reset button must not require scrolling").toBe(true);

    await assertNoOverflow(page, "360x640/recovery");
    await assertTouchTargets(page, "360x640/recovery");
  });
});
