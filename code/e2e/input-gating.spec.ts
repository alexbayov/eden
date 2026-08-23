import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  combatLog,
  endTurnButton,
  gotoApp,
  phaseLabel,
  readRawSave,
  readSave,
  seedRawSave,
} from "./helpers/app";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";

/**
 * Combat hotkey gating, asserted in a real browser.
 *
 * This is the third layer of coverage for the same rule, and each layer proves something the others
 * cannot:
 *
 *   1. `input-gating.test.ts` — `resolveCombatShortcut` returns null outside an active player phase.
 *      A pure function; says nothing about whether the shell consults it.
 *   2. `combat-shell.dom.test.tsx` (W1-02) — the shell's own `window` keydown listener is gated, in
 *      jsdom, with `vi.getTimerCount()` proving no transition was even scheduled.
 *   3. This file — the same property in Chromium, against real `localStorage` and the real event
 *      loop, with a real 300 ms timer that is allowed to run.
 *
 * Layer 3 exists because layers 1 and 2 both run in synthetic event environments. `fireEvent.keyDown`
 * constructs and dispatches an event object directly; a real browser keypress travels through
 * Chromium's input pipeline, focus handling and default-action logic. A gating bug that depends on
 * `event.target` (the shell's `isTextEntryTarget` check reads it) or on focus could pass in jsdom and
 * fail here.
 *
 * The headline assertion is the one the ticket asks for: pressing `E` on the base screen does not
 * start combat. It is asserted as *nothing observable changed at all* — byte-identical save, unchanged
 * hero HP and AP, unchanged turn, no combat shell, no canvas — rather than only checking one field.
 */

const content = loadShippedContent();

test.describe("combat hotkeys are gated to an active encounter", () => {
  test("E on the base screen does not start combat", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const before = await readRawSave(page);
    const heroBefore = (await readSave(page)).units.find((unit) => unit.id === "hero")!;

    /* A real keypress, not a synthesised event object. */
    await page.keyboard.press("e");
    /* The shell's enemy transition uses a 300 ms timer; wait past it so a *delayed* start would be
       caught rather than merely not-yet-visible. */
    await page.waitForTimeout(600);

    /* Nothing changed: the strongest available statement. */
    expect(await readRawSave(page), "pressing E on the base screen must not write a new save").toBe(before);
    const after = await readSave(page);
    const heroAfter = after.units.find((unit) => unit.id === "hero")!;
    expect(after.phase).toBe("player");
    expect(after.campaign.screen).toBe("home");
    expect(after.turn).toBe(1);
    expect(heroAfter.hp).toBe(heroBefore.hp);
    expect(heroAfter.ap).toBe(heroBefore.ap);

    /* And the UI never entered combat: no combat shell, no canvas host, no Phaser canvas. */
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    await expect(page.locator("main.game-shell.combat")).toHaveCount(0);
    await expect(page.locator(".canvas-wrap")).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test("O and the body-part digits are equally inert on the base screen", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    const before = await readRawSave(page);
    /* Upper case included: the resolver lower-cases the key, so `E` must be gated too. */
    for (const key of ["E", "o", "O", "1", "2", "3", "4", "5", "6"]) await page.keyboard.press(key);
    await page.waitForTimeout(600);

    expect(await readRawSave(page)).toBe(before);
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    await expect(page.locator("main.game-shell.combat")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("mission select, reward and return screens ignore combat hotkeys", async ({ page }) => {
    for (const [screen, label] of [
      ["mission-select", "МИССИЯ"],
      ["reward", "НАГРАДА"],
      ["return", "ВОЗВРАТ"],
    ] as const) {
      await clearSave(page);
      await seedRawSave(page, buildSave(content, { screen }).raw);
      await gotoApp(page);
      await expect(phaseLabel(page)).toHaveText(label);

      const before = await readRawSave(page);
      await page.keyboard.press("e");
      await page.keyboard.press("o");
      await page.waitForTimeout(600);

      expect(await readRawSave(page), `screen ${screen} must ignore combat hotkeys`).toBe(before);
      await expect(phaseLabel(page)).toHaveText(label);
      await expect(page.locator("main.game-shell.combat")).toHaveCount(0);
    }
  });

  test("E during an active encounter does end the turn", async ({ page }) => {
    /* The control case. Without it, every assertion above could be satisfied by a listener that was
       never attached — which would make this whole file vacuous. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await page.keyboard.press("e");

    /* The enemy phase is entered and its snapshot is persisted synchronously. */
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");
    await expect(combatLog(page)).toHaveText("Ход противника…");
    expect((await readSave(page)).phase).toBe("enemy");

    /* Then the 300 ms timer resolves it and the turn counter advances. */
    await expect(page.locator(".turn span")).toHaveText("ФАЗА / ХОД 2");
    const resolved = await readSave(page);
    expect(resolved.phase).toBe("player");
    expect(resolved.turn).toBe(2);
    expect(errors).toEqual([]);
  });

  test("digits select a body part only during an active encounter", async ({ page }) => {
    /* Same shape as the E control case, for the 1–6 shortcuts. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);

    const activePart = page.locator(".action-tray .actions button.active");
    await expect(activePart).toContainText("Торс");

    await page.keyboard.press("1");
    await expect(activePart).toContainText("Голова");

    await page.keyboard.press("5");
    await expect(activePart).toContainText("Глаз");
  });

  test("hotkeys are inert while an enemy transition is in flight", async ({ page }) => {
    /* The gate is `screen === mission && phase === player`, so the enemy phase must reject input as
       firmly as the base screen does. The transition is pinned by suppressing its timer, turning a
       300 ms race into a deterministic state. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);
    await page.evaluate(() => {
      window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
    });
    await endTurnButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");

    const during = await readRawSave(page);
    for (const key of ["e", "o", "1", "6"]) await page.keyboard.press(key);

    /* No second transition was started and no body part changed the persisted state. */
    expect(await readRawSave(page)).toBe(during);
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");
  });

  test("typing into a focused text field never triggers a combat action", async ({ page }) => {
    /* `isTextEntryTarget` exists precisely for this, and it reads `event.target` — a property that a
       synthesised jsdom event sets differently from a real browser keypress. The shell ships no text
       input today, so one is injected to exercise the branch in Chromium. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "text";
      input.id = "eden-test-input";
      document.body.appendChild(input);
      input.focus();
    });

    const before = await readRawSave(page);
    await page.locator("#eden-test-input").type("eo16");
    await page.waitForTimeout(600);

    /* The characters landed in the field, and the turn did not end. */
    expect(await page.locator("#eden-test-input").inputValue()).toBe("eo16");
    expect(await readRawSave(page)).toBe(before);
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
  });
});
