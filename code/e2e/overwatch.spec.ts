import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  combatLog,
  gotoApp,
  phaseLabel,
  readRawSave,
  readSave,
  reloadApp,
  seedRawSave,
  targetOptions,
} from "./helpers/app";
import { MIN_TOUCH_TARGET_PX } from "./helpers/geometry";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";
import { ATTACKS, OVERWATCH_ACTIVATION_AP, OVERWATCH_HIT_MODIFIER } from "../src/game/combat";

/**
 * W6-04 — Overwatch in a real browser. **The first E2E coverage this mechanic has ever had**:
 * `grep -rn overwatch e2e/` returned nothing before this spec.
 *
 * The mechanic worked and was covered at the domain level. What no test could show is the part the ticket is
 * actually about — that the reservation and the accuracy penalty are *visible* — plus criterion 5, that the
 * state survives a reload mid-enemy-phase, which needs a real browser and real storage.
 *
 * Every number is read from `combat.ts` rather than restated, so a repricing updates both sides at once.
 */

const content = loadShippedContent();
/** The hero cell with a firing line to `checkpoint-shooter`, shared with the other combat specs. */
const FIRING_POSITION = { x: 5, y: 2 };
/** Total AP the control requires: activation plus the torso shot the reserve has to pay for. */
const TOTAL_AP = OVERWATCH_ACTIVATION_AP + ATTACKS.torso.apCost;

const overwatchButton = (page: import("@playwright/test").Page) => page.locator("button.overwatch");

test.describe("W6-04 the reservation and the penalty are visible", () => {
  test("prices Overwatch before it is committed", async ({ page }) => {
    /* Criterion 1. Overwatch spends a whole turn on a bet about the enemy phase, so both numbers have to be
       readable in advance — and before this ticket neither appeared anywhere in the UI. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();

    const button = overwatchButton(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("data-overwatch-active", "false");
    await expect(button).toHaveAttribute("data-overwatch-total-ap", String(TOTAL_AP));
    await expect(button).toHaveAttribute("data-overwatch-modifier", String(OVERWATCH_HIT_MODIFIER));
    /* The reserve that would be held back, stated rather than implied. */
    const hero = (await readSave(page)).units.find((unit) => unit.id === "hero")!;
    await expect(button).toHaveAttribute(
      "data-overwatch-reserved",
      String(hero.ap - OVERWATCH_ACTIVATION_AP),
    );
    await expect(button).toContainText(String(OVERWATCH_HIT_MODIFIER));
    /* Doc 14's tap-target floor applies to this control too. */
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(errors).toEqual([]);
  });

  test("shows the reaction chance once a target is selected", async ({ page }) => {
    /* Priced through the same call the reaction makes, so the figure is the one rolled against. It must be
       strictly worse than an ordinary shot, since the reaction takes the −15. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await targetOptions(page).first().click();

    const ordinary = Number(await page.locator(".breakdown").getAttribute("data-hit-final"));
    await expect(overwatchButton(page)).toContainText("шанс реакции");
    const text = (await overwatchButton(page).textContent())!;
    const reaction = Number(text.match(/шанс реакции (\d+)%/)![1]);
    expect(reaction).toBeLessThan(ordinary);
  });

  test("marks itself unavailable below the AP threshold instead of refusing on click", async ({ page }) => {
    /*
     * The defect: the button was gated on `phase` alone, so at 5 AP it looked available and refused when
     * pressed. `force` because it is `aria-disabled` rather than `disabled` — kept reachable so the reason is
     * announced — and forcing the press proves the *handler* refuses too.
     */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", heroAt: FIRING_POSITION, heroAp: TOTAL_AP - 1 }).raw,
    );
    await gotoApp(page);

    const button = overwatchButton(page);
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("data-blocked", "insufficient-ap");
    /* The refusal names the requirement and what the hero has, not a generic sentence. */
    await expect(button).toContainText(String(TOTAL_AP));

    const before = await readRawSave(page);
    await button.click({ force: true });

    await expect(combatLog(page)).toContainText(String(TOTAL_AP));
    /* Nothing was committed: still the player's turn, same stored state. */
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    expect(await readRawSave(page)).toBe(before);
  });

  test("is available exactly at the threshold", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", heroAt: FIRING_POSITION, heroAp: TOTAL_AP }).raw,
    );
    await gotoApp(page);
    await expect(overwatchButton(page)).toHaveAttribute("aria-disabled", "false");
    await expect(overwatchButton(page)).toHaveAttribute("data-blocked", "");
  });
});

test.describe("W6-04 activation reserves what it advertised", () => {
  test("holds back exactly the stated AP and survives a reload mid-enemy-phase", async ({ page }) => {
    /*
     * Criterion 5, which only a browser can show: the reservation is persisted and the enemy phase resumes
     * from storage on the next boot. The enemy-phase timer is suppressed so the intermediate state is pinned
     * rather than raced — the same technique `input-gating.spec.ts` uses.
     */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    const apBefore = (await readSave(page)).units.find((unit) => unit.id === "hero")!.ap;
    const advertised = Number(await overwatchButton(page).getAttribute("data-overwatch-reserved"));
    expect(advertised).toBe(apBefore - OVERWATCH_ACTIVATION_AP);

    await page.evaluate(() => {
      window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
    });
    await overwatchButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");

    /* The persisted reserve is the number the control showed, and the hero is spent down to 0 AP. */
    const armed = await readSave(page);
    const armedHero = armed.units.find((unit) => unit.id === "hero")!;
    expect(armedHero.overwatch).toEqual({ reservedAp: advertised });
    expect(armedHero.ap).toBe(0);
    expect(armed.phase).toBe("enemy");

    /* And the payload the browser wrote is one the validator accepts on the next boot. */
    await reloadApp(page, { expect: "ready" });
    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    const resumed = await readSave(page);
    /* The suppressed timer is gone after navigation, so boot resolves the pending enemy phase. */
    expect(resumed.phase).toBe("player");
    /* Overwatch is consumed by the phase whether or not it fired, so it must not persist into the new turn. */
    expect(resumed.units.find((unit) => unit.id === "hero")!.overwatch).toBeUndefined();
  });

  test("refuses to arm twice, because the reaction is one per enemy phase", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: FIRING_POSITION }).raw);
    await gotoApp(page);
    await page.evaluate(() => {
      window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
    });
    await overwatchButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");

    const button = overwatchButton(page);
    await expect(button).toHaveAttribute("data-overwatch-active", "true");
    /* Blocked as "not the player's turn" here: the enemy phase owns the board while the reaction waits. */
    await expect(button).toHaveAttribute("aria-disabled", "true");
    const before = await readRawSave(page);
    await button.click({ force: true });
    expect(await readRawSave(page)).toBe(before);
  });
});

test.describe("W6-04 a tampered reservation does not load", () => {
  test("refuses a hand-edited reserve instead of granting a free super-reaction", async ({ page }) => {
    /*
     * `overwatch` was not validated at all before this ticket, so `reservedAp: 9999` loaded cleanly and armed a
     * reaction stronger than any turn can grant. Asserted through the real boot path, which is where it would
     * have mattered — the save layer, not a unit test's idea of it.
     *
     * This is the documented anti-tamper limitation narrowing, not disappearing: localStorage is still
     * editable, but a payload the game could never write is now rejected.
     */
    const fixture = buildSave(content, { screen: "mission", heroAt: FIRING_POSITION });
    const tampered = JSON.parse(fixture.raw);
    tampered.units = tampered.units.map((unit: { id: string }) =>
      unit.id === "hero" ? { ...unit, overwatch: { reservedAp: 9999 } } : unit,
    );

    await clearSave(page);
    await seedRawSave(page, JSON.stringify(tampered));
    await gotoApp(page, { expect: "recovery" });

    /* Recovery rather than a silent load: the shell reports the offending path. */
    await expect(page.locator("main.game-shell.recovery")).toBeVisible();
    await expect(page.locator("p.log")).toContainText("overwatch");
  });
});
