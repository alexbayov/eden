import { expect, test } from "@playwright/test";
import { clearSave, gotoApp, readBackup, readRawSave, seedRawSave } from "./helpers/app";

/**
 * W1-01 — corrupt save recovery in a real browser.
 *
 * The contract implemented in src/app.tsx and src/game/save.ts is: a save that
 * fails validation must never be silently discarded. The shell copies the
 * original payload to a backup key, shows the recovery screen and only then
 * offers an explicit reset. These specs assert that in the browser rather than
 * through the pure validator.
 */

test.describe("corrupt save recovery", () => {
  test("malformed JSON shows recovery, preserves the payload and backs it up", async ({ page }) => {
    const corrupt = "{ not valid json";
    await clearSave(page);
    await seedRawSave(page, corrupt);

    await gotoApp(page, { expect: "recovery" });

    await expect(page.getByText("SAVE RECOVERY")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Сохранение не загружено" })).toBeVisible();

    /* The original payload is still there — recovery is non-destructive. */
    expect(await readRawSave(page)).toBe(corrupt);
    expect(await readBackup(page)).toBe(corrupt);

    /* Base and combat screens must not render behind the recovery screen. */
    await expect(page.locator("main.game-shell.recovery")).toBeVisible();
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toHaveCount(0);
    await expect(page.locator(".canvas-wrap canvas")).toHaveCount(0);
  });

  test("schema-invalid save recovers only after an explicit reset", async ({ page }) => {
    /* Structurally valid JSON, wrong schema version: exercises the validator
       path rather than the JSON.parse path. */
    const corrupt = JSON.stringify({ schemaVersion: 99, arenaId: "perimeter-checkpoint" });
    await clearSave(page);
    await seedRawSave(page, corrupt);

    await gotoApp(page, { expect: "recovery" });

    const reset = page.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" });
    await expect(reset).toBeVisible();

    /* Reset is gated behind a successful backup. */
    expect(await readBackup(page)).toBe(corrupt);

    await reset.click();

    /* Recovery screen is replaced by a playable base screen. */
    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();

    const persisted = await readRawSave(page);
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toMatchObject({ schemaVersion: 5, campaign: { screen: "home" } });

    /* The corrupt original stays in the backup key after the reset. */
    expect(await readBackup(page)).toBe(corrupt);
  });
});
