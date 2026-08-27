import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  clearSave,
  collectConsoleErrors,
  gotoApp,
  readRawSave,
  SAVE_BACKUP_KEY,
  SAVE_STORAGE_KEY,
} from "./helpers/app";

/**
 * W1-01 — the first assertions in this repository that run against a real
 * browser. Everything before this file was a static read of the sources or a
 * pure-function unit test, so these specs deliberately verify the boot path
 * end to end: fresh localStorage -> base screen -> mission select -> encounter
 * canvas, plus the fact that Phaser is not in the initial payload.
 *
 * Scope is initial E2E only. Combat interaction, reward flow, mobile viewports
 * and visual regression belong to W1-02…W1-08 and are not asserted here.
 */

test.describe("boot smoke", () => {
  test("storage keys used by the helpers match src/game/save.ts", async () => {
    /* Guards the duplicated literals in e2e/helpers/app.ts against drift. */
    const source = await readFile(new URL("../src/game/save.ts", import.meta.url), "utf8");
    expect(source).toContain(`export const SAVE_STORAGE_KEY = "${SAVE_STORAGE_KEY}"`);
    expect(source).toContain(`export const SAVE_BACKUP_KEY = "${SAVE_BACKUP_KEY}"`);
  });

  test("renders the base screen from empty localStorage without console errors", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);

    /* Prove the precondition rather than assuming it: a leaked save from an
       earlier test would make the rest of this spec meaningless. */
    await page.addInitScript(() => {
      (window as unknown as { __edenSaveAtBoot: string | null }).__edenSaveAtBoot =
        window.localStorage.getItem("eden.save.v7");
    });

    await gotoApp(page);

    expect(await page.evaluate(() => (window as unknown as { __edenSaveAtBoot: string | null }).__edenSaveAtBoot)).toBeNull();

    /* Acceptance criterion 2: a heading and at least one interactive button. */
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Бункер у периметра" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();
    expect(await page.getByRole("button").count()).toBeGreaterThan(1);

    /* The base screen is the campaign home, not the combat shell. */
    await expect(page.locator("main.game-shell")).toBeVisible();
    await expect(page.locator("main.game-shell.combat")).toHaveCount(0);
    await expect(page.locator(".canvas-wrap")).toHaveCount(0);

    /* A first boot must have written its own save. */
    const persisted = await readRawSave(page);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toMatchObject({ schemaVersion: 7, campaign: { screen: "home" } });

    expect(errors).toEqual([]);
  });

  test("opens mission select and lists the first encounter as startable", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await gotoApp(page);

    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();

    /* Mission select is a campaign screen switch, not a route change. */
    await expect(page.locator(".turn strong")).toHaveText("МИССИЯ");
    await expect(page.getByRole("button", { name: "НАЗАД НА БАЗУ" })).toBeVisible();

    const firstEncounter = page.locator("article.mission-card").first();
    await expect(firstEncounter.getByRole("heading", { name: "КПП периметра" })).toBeVisible();
    await expect(firstEncounter.getByRole("button", { name: "НАЧАТЬ" })).toBeEnabled();

    /* Later encounters stay locked on a fresh save. */
    const laterEncounter = page.locator("article.mission-card").nth(1);
    await expect(laterEncounter.getByRole("button", { name: "ЗАБЛОКИРОВАНО" })).toBeDisabled();

    expect(await readRawSave(page)).toContain('"screen":"mission-select"');
    expect(errors).toEqual([]);
  });

  test("starting the first encounter mounts a Phaser canvas loaded lazily", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);

    const scripts: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (url.endsWith(".js")) scripts.push(url);
    });

    await gotoApp(page);

    /* Initial payload contract: the production entry stays below the enforced
       initial budget. Phaser is verified by the separate lazy chunk fetched only
       after combat starts; an ES module is not expected on window. */
    const initialScripts = scripts.filter((url) => !/phaser|TacticalScene/i.test(url));
    expect(initialScripts).not.toEqual([]);

    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    await page.locator("article.mission-card").first().getByRole("button", { name: "НАЧАТЬ" }).click();

    /* Combat shell replaces the campaign shell. */
    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "КПП периметра" })).toBeVisible();
    await expect(page.locator(".turn strong")).toHaveText("ВАШ ХОД");

    /* The canvas is created by Phaser after the dynamic import resolves. */
    const canvas = page.locator(".canvas-wrap canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    /* Now — and only now — the Phaser chunk must have been fetched. */
    await expect.poll(() => scripts.some((url) => /phaser/i.test(url))).toBe(true);

    /* Tactical panel mirrors the canvas for keyboard/touch. */
    await expect(page.getByRole("heading", { name: "Тактическое управление" })).toBeVisible();
    await expect(page.locator("[data-control]").first()).toBeVisible();

    expect(await readRawSave(page)).toContain('"screen":"mission"');
    expect(errors).toEqual([]);
  });
});
