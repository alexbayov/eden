import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  combatLog,
  encounterStatus,
  endTurnButton,
  fireButton,
  gotoApp,
  missionCard,
  phaseLabel,
  readSave,
  retreatButton,
  seedRawSave,
  targetOptions,
} from "./helpers/app";
import {
  buildDefeatFixture,
  buildSave,
  loadShippedContent,
  orderedEncounters,
} from "../src/test/campaign-save-fixtures";

/**
 * W1-03, failure half — defeat, retreat and retry in a real browser.
 *
 * The defeat path is made deterministic the same way the victory path is: `buildDefeatFixture`
 * searches for the `rngState` whose enemy turn kills the hero, using the runtime `runEnemyTurn`,
 * and seeds it. Nothing here depends on a lucky roll, and nothing here changes gameplay — the hero
 * is weakened through save state that the game itself can produce.
 *
 * Retreat is the only safe exit from a combat soft lock (no ammo, no legal attack), so its two
 * gates matter: available during the player phase, unavailable once an enemy transition is in
 * flight. The second gate is checked by *stopping* the transition from resolving rather than by
 * racing its 300 ms timer, which would be flaky by construction.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [firstEncounter, secondEncounter] = encounters;

test.describe("W1-03 campaign failure and retreat", () => {
  test("marks the encounter failed on defeat, offers retry and grants no reward", async ({ page }) => {
    /* Acceptance criterion 3. */
    const errors = collectConsoleErrors(page);
    const fixture = buildDefeatFixture(content, {
      screen: "mission",
      heroHp: 2,
      heroAt: { x: 5, y: 2 },
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await endTurnButton(page).click();

    /* The enemy turn resolves and the campaign moves to the return screen. */
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    const afterDefeat = await readSave(page);
    expect(afterDefeat.phase).toBe("defeat");
    expect(afterDefeat.campaign.screen).toBe("return");
    expect(afterDefeat.units.find((unit) => unit.id === "hero")?.hp).toBe(0);
    expect(encounterStatus(afterDefeat, firstEncounter.id)).toMatchObject({
      status: "failed",
      victories: 0,
      firstRewardClaimed: false,
    });
    /* No reward, no XP, and the next encounter stays locked. */
    expect(afterDefeat.campaign.xp).toBe(0);
    expect(afterDefeat.campaign.claimedRewards).toEqual([]);
    expect(encounterStatus(afterDefeat, secondEncounter.id)?.status).toBe("locked");
    expect(afterDefeat.inventory.stash.resources).toEqual([]);
    await expect(page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" })).toHaveCount(0);

    /* Retry is offered alongside returning to base. */
    await expect(page.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" })).toBeEnabled();

    expect(errors).toEqual([]);
  });

  test("retry restarts the failed encounter from a clean first turn", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "return" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");

    await page.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" }).click();

    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    const afterRetry = await readSave(page);
    expect(afterRetry.campaign.screen).toBe("mission");
    expect(afterRetry.campaign.mission.status).toBe("active");
    /* Turn counter and hero state come from the encounter template again, per M3-D's contract that
       a retry after defeat restores template HP rather than carrying 0 HP forward. */
    expect(afterRetry.turn).toBe(1);
    const hero = afterRetry.units.find((unit) => unit.id === "hero")!;
    expect(hero.hp).toBe(hero.maxHp);
    expect(hero.ap).toBe(10);
    /* Still no reward from the failed attempt. */
    expect(afterRetry.campaign.xp).toBe(0);
    expect(afterRetry.campaign.claimedRewards).toEqual([]);
  });

  test("returning to base after a failure keeps the encounter retryable", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "return" }).raw);
    await gotoApp(page);

    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const atBase = await readSave(page);
    expect(atBase.activeEncounterId).toBeNull();
    expect(encounterStatus(atBase, firstEncounter.id)?.status).toBe("failed");
    expect(atBase.campaign.xp).toBe(0);

    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    /* A failed encounter is offered as ПОВТОРИТЬ, not as ЗАБЛОКИРОВАНО. */
    await expect(missionCard(page, firstEncounter.name).getByRole("button", { name: "ПОВТОРИТЬ" })).toBeEnabled();
  });

  test("retreat fails the encounter without a reward", async ({ page }) => {
    /* Acceptance criterion from W1-03's scope list: «Отступить без награды». */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);

    const retreat = retreatButton(page);
    await expect(retreat).toBeEnabled();
    await expect(retreat).toHaveText("ОТСТУПИТЬ БЕЗ НАГРАДЫ");
    await retreat.click();

    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    const afterRetreat = await readSave(page);
    expect(afterRetreat.phase).toBe("defeat");
    expect(afterRetreat.campaign.screen).toBe("return");
    expect(encounterStatus(afterRetreat, firstEncounter.id)).toMatchObject({
      status: "failed",
      victories: 0,
      firstRewardClaimed: false,
    });
    /* The whole point of the control: no reward, no XP, nothing added to the stash. */
    expect(afterRetreat.campaign.xp).toBe(0);
    expect(afterRetreat.campaign.claimedRewards).toEqual([]);
    expect(afterRetreat.inventory.stash.resources).toEqual([]);
    expect(afterRetreat.inventory.stash.items).toEqual([]);
    await expect(page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" })).toHaveCount(0);

    /* Unlike a defeat, retreat evacuates the operative alive. */
    expect(afterRetreat.units.find((unit) => unit.id === "hero")!.hp).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("retreat is the documented way out of an ammo soft lock", async ({ page }) => {
    /* An empty magazine and empty reserve leaves no ranged attack and no reload. The UI must state
       the reason and point at the exit rather than leaving the player stuck. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission", heroAmmo: { magazine: 0, reserveAmmo: 0 } }).raw,
    );
    await gotoApp(page);

    await expect(fireButton(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Перезарядить оружие/ })).toBeDisabled();
    await expect(page.locator("p.combat-warning")).toContainText("Боеприпасы закончились");
    await expect(page.locator("p.combat-warning")).toContainText("Отступите, чтобы выйти без награды");
    await expect(retreatButton(page)).toBeEnabled();

    await retreatButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    expect((await readSave(page)).campaign.xp).toBe(0);
  });

  test("retreat is unavailable while an enemy transition is in flight", async ({ page }) => {
    /* Acceptance criterion 4, second half.
     *
     * The shell resolves the enemy phase on a 300 ms `window.setTimeout`, so asserting on the
     * disabled state during that window would be a race. Replacing `setTimeout` with a no-op
     * *before* ending the turn pins the app in the enemy phase, which turns a timing race into a
     * deterministic state assertion. The app's own resolution path is covered by the defeat and
     * hotkey specs, which let the timer fire normally. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);

    /* Precondition: available in the player phase. */
    await expect(retreatButton(page)).toBeEnabled();

    await page.evaluate(() => {
      window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
    });
    await endTurnButton(page).click();

    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");
    expect((await readSave(page)).phase).toBe("enemy");
    /* Every player action is closed off, retreat included. */
    await expect(retreatButton(page)).toBeDisabled();
    await expect(fireButton(page)).toBeDisabled();
    await expect(endTurnButton(page)).toBeDisabled();
    await expect(combatLog(page)).toHaveText("Ход противника…");
  });

  test("retreat is unavailable outside an active encounter", async ({ page }) => {
    /* Acceptance criterion 4, first half, stated as the complement: the control only exists while
       an encounter is active. On the campaign screens there is no combat shell at all. */
    for (const screen of ["home", "mission-select", "reward", "return"] as const) {
      await clearSave(page);
      await seedRawSave(page, buildSave(content, { screen }).raw);
      await gotoApp(page);
      await expect(page.locator("main.game-shell.combat")).toHaveCount(0);
      await expect(retreatButton(page)).toHaveCount(0);
    }
  });

  test("a failed encounter cannot be re-entered as a fresh unlock", async ({ page }) => {
    /* Guards the transition the validator cares about: a failed encounter goes back to `active`
       through retry, and never silently to `completed`. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "mission-select", encounters: { [firstEncounter.id]: { status: "failed" } } }).raw,
    );
    await gotoApp(page);

    await missionCard(page, firstEncounter.name).getByRole("button", { name: "ПОВТОРИТЬ" }).click();

    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    const persisted = await readSave(page);
    expect(encounterStatus(persisted, firstEncounter.id)).toMatchObject({ status: "active", victories: 0 });
    expect(persisted.campaign.xp).toBe(0);
    /* Targets are live again, so the retry is a real encounter and not a stale screen. */
    await expect(targetOptions(page).first()).toBeVisible();
  });
});
