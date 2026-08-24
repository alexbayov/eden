import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  clearSave,
  collectConsoleErrors,
  encounterStatus,
  endTurnButton,
  gotoApp,
  LEGACY_SAVE_STORAGE_KEY,
  missionCard,
  phaseLabel,
  progressionReadout,
  readBackup,
  readRawSave,
  readSave,
  reloadApp,
  seedLegacyRawSave,
  seedRawSave,
  SAVE_STORAGE_KEY,
} from "./helpers/app";
import {
  buildSave,
  loadShippedContent,
  orderedEncounters,
  toLegacyV4Save,
  xpForRewards,
} from "../src/test/campaign-save-fixtures";
import { levelForXp, skillPointsGranted, xpToNextLevel } from "../src/game/progression";

/**
 * W1-04 — the save contract against real `localStorage`, not the in-memory adapter.
 *
 * Reload is the interesting axis here. `save.test.ts` already proves `validateSave` accepts and
 * rejects the right payloads, but it cannot prove that the *browser* rehydrates the same screen and
 * the same numbers after F5, because that path runs through the shell's boot effect, the async
 * catalog fetches and the storage adapter. Each stage below is reloaded and compared field by field
 * plus screen-text by screen-text.
 *
 * Fixtures live in `src/test/campaign-save-fixtures.ts` and are validated by the runtime
 * `validateSave` at build time, satisfying the doc 23 §5 requirement that fixtures share the
 * runtime validator rather than a test-local copy.
 *
 * KNOWN LIMITATION, recorded deliberately (acceptance criterion 5): nothing here protects against a
 * player hand-editing `localStorage`. The validator rejects *malformed* saves, but any payload that
 * satisfies the schema is accepted, so a hand-crafted save with inflated XP or a pre-completed zone
 * loads normally. That is a known limitation of a client-only save, not a defect, and anti-tamper is
 * explicitly out of W1-04's scope.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [firstEncounter, secondEncounter, thirdEncounter] = encounters;

/** Text of the whole shell, used to compare a screen before and after a reload. */
const screenText = (page: import("@playwright/test").Page) => page.locator("main.game-shell").innerText();

test.describe("W1-04 reload at every campaign stage", () => {
  test("restores an available encounter at base, with identical screen and XP", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const before = await readSave(page);
    const textBefore = await screenText(page);
    expect(encounterStatus(before, firstEncounter.id)?.status).toBe("available");

    await reloadApp(page);

    const after = await readSave(page);
    expect(await screenText(page)).toBe(textBefore);
    expect(after).toEqual(before);
    expect(after.campaign.xp).toBe(before.campaign.xp);
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    /* Criterion 4: never a white screen. */
    await expect(page.getByRole("heading", { name: "Бункер у периметра" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("restores an active encounter mid-combat, with the same turn, HP and position", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission", heroAt: { x: 5, y: 2 }, turn: 3 }).raw);
    await gotoApp(page);

    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    /* Wait for the canvas so the reload happens from a fully mounted combat screen. */
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    const before = await readSave(page);
    const textBefore = await screenText(page);
    const heroBefore = before.units.find((unit) => unit.id === "hero")!;

    await reloadApp(page);

    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    await expect(page.locator(".canvas-wrap canvas")).toBeVisible();
    const after = await readSave(page);
    expect(await screenText(page)).toBe(textBefore);
    expect(after).toEqual(before);
    const heroAfter = after.units.find((unit) => unit.id === "hero")!;
    expect({ hp: heroAfter.hp, ap: heroAfter.ap, x: heroAfter.x, y: heroAfter.y }).toEqual({
      hp: heroBefore.hp,
      ap: heroBefore.ap,
      x: heroBefore.x,
      y: heroBefore.y,
    });
    expect(after.turn).toBe(3);
    await expect(page.locator(".turn span")).toHaveText("ФАЗА / ХОД 3");
    expect(errors).toEqual([]);
  });

  test("restores a completed zone, keeping XP and every claimed reward", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const allCompleted = Object.fromEntries(
      encounters.map((entry) => [entry.id, { status: "completed" as const, victories: 1, firstRewardClaimed: true }]),
    );
    const expectedXp = xpForRewards(
      content,
      encounters.map((entry) => entry.rewardId),
    );
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "home", encounterId: thirdEncounter.id, encounters: allCompleted }).raw,
    );
    await gotoApp(page);

    const before = await readSave(page);
    const textBefore = await screenText(page);
    expect(before.campaign.zone.status).toBe("completed");
    expect(before.campaign.xp).toBe(expectedXp);
    await expect(page.locator("main.game-shell")).toContainText(`XP: ${expectedXp}`);

    await reloadApp(page);

    const after = await readSave(page);
    expect(await screenText(page)).toBe(textBefore);
    expect(after).toEqual(before);
    expect(after.campaign.zone.status).toBe("completed");
    expect(after.campaign.xp).toBe(expectedXp);
    expect(after.campaign.claimedRewards.sort()).toEqual(encounters.map((entry) => entry.rewardId).sort());
    await expect(page.locator("main.game-shell")).toContainText(`XP: ${expectedXp}`);
    expect(errors).toEqual([]);
  });

  test("restores the reward screen with the reward still claimable", async ({ page }) => {
    /* The riskiest reload point: a pending reward must survive F5 without being granted twice and
       without being lost. */
    const reward = content.rewards.find((entry) => entry.id === firstEncounter.rewardId)!;
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "reward" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("НАГРАДА");

    await reloadApp(page);

    await expect(phaseLabel(page)).toHaveText("НАГРАДА");
    const afterReload = await readSave(page);
    expect(afterReload.campaign.xp).toBe(0);
    expect(afterReload.campaign.claimedRewards).toEqual([]);

    await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    /* Claimed exactly once across the reload boundary. */
    const claimed = await readSave(page);
    expect(claimed.campaign.xp).toBe(reward.xp);
    expect(claimed.campaign.claimedRewards).toEqual([reward.id]);
  });

  test("restores the return screen after a failure, still without a reward", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "return" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    const textBefore = await screenText(page);

    await reloadApp(page);

    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    expect(await screenText(page)).toBe(textBefore);
    const after = await readSave(page);
    expect(encounterStatus(after, firstEncounter.id)?.status).toBe("failed");
    expect(after.campaign.xp).toBe(0);
    await expect(page.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" })).toBeEnabled();
  });

  test("persists real in-session progress across a reload", async ({ page }) => {
    /* The stages above are seeded. This one earns its state through the UI first — mission select,
       then an encounter start — and only then reloads, so the assertion covers what the *app* wrote
       rather than what the fixture wrote. */
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await gotoApp(page);

    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    await missionCard(page, firstEncounter.name).getByRole("button", { name: "НАЧАТЬ" }).click();
    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    const earned = await readSave(page);
    expect(earned.campaign.screen).toBe("mission");
    expect(earned.activeEncounterId).toBe(firstEncounter.id);

    await reloadApp(page);

    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: firstEncounter.name })).toBeVisible();
    expect(await readSave(page)).toEqual(earned);
    expect(errors).toEqual([]);
  });

  test("resolves a persisted enemy phase on the next boot instead of stalling", async ({ page }) => {
    /* An interrupted enemy transition — the browser closed between `persistEnemyPhase` and the
       resolution timer — must not resume as a frozen enemy turn. The shell resolves it during boot.
       Reached by suppressing the timer, which is the only way to observe a persisted `enemy` phase
       without racing the app. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission" }).raw);
    await gotoApp(page);
    await page.evaluate(() => {
      window.setTimeout = (() => 0) as unknown as typeof window.setTimeout;
    });
    await endTurnButton(page).click();
    await expect(phaseLabel(page)).toHaveText("ПРОТИВНИК");
    expect((await readSave(page)).phase).toBe("enemy");

    await reloadApp(page);

    /* Boot resolved the stored enemy phase; the player is in control again. */
    const resumed = await readSave(page);
    expect(resumed.phase).not.toBe("enemy");
    expect(["player", "defeat"]).toContain(resumed.phase);
    if (resumed.phase === "player") {
      await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
      expect(resumed.turn).toBe(2);
      await expect(page.locator("p.save-status")).toContainText("Сохранённый ход противника разрешён и записан.");
    } else {
      await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    }
    /* Criterion 4: no white screen on either branch. */
    await expect(page.locator("main.game-shell")).toBeVisible();
  });
});

test.describe("W4-05 schema upgrade and W4-01 level progress across a reload", () => {
  const curve = content.progression.curve;

  test("continues a save created before the upgrade, raising it to v5 with a derived level", async ({ page }) => {
    /* W4-05 acceptance criterion 6, and the reason `LEGACY_SAVE_STORAGE_KEYS` exists: the payload
       sits under the *old* key, in the *old* shape, exactly as a player's browser would have it
       after the app updates underneath them. Nothing may be lost and nothing may be invented. */
    const errors = collectConsoleErrors(page);
    const xp = curve.thresholds[0];
    const legacy = toLegacyV4Save(buildSave(content, { screen: "home", xp, claimedRewards: [] }));
    expect(legacy.save.schemaVersion).toBe(4);
    expect("character" in legacy.save).toBe(false);

    await clearSave(page);
    await seedLegacyRawSave(page, legacy.raw);
    await gotoApp(page);

    /* Not recovery: the old save loads and the campaign continues. */
    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const migrated = await readSave(page);
    expect(migrated.schemaVersion).toBe(5);
    /* XP is carried, and the level/points are derived from the curve rather than reset. */
    expect(migrated.campaign.xp).toBe(xp);
    expect(migrated.character).toEqual({
      level: levelForXp(xp, curve),
      xp,
      unspentSkillPoints: skillPointsGranted(levelForXp(xp, curve), curve),
    });
    await expect(progressionReadout(page)).toContainText(`Уровень ${levelForXp(xp, curve)}`);

    /* The upgraded payload is written under the new key; the old one is left intact rather than
       deleted, so a downgrade is still possible. */
    expect(await page.evaluate((key: string) => window.localStorage.getItem(key), SAVE_STORAGE_KEY)).not.toBeNull();
    expect(await page.evaluate((key: string) => window.localStorage.getItem(key), LEGACY_SAVE_STORAGE_KEY)).toBe(legacy.raw);

    /* And the upgraded save is itself durable. */
    await reloadApp(page);
    expect(await readSave(page)).toEqual(migrated);
    await expect(progressionReadout(page)).toContainText(`Уровень ${levelForXp(xp, curve)}`);
    expect(errors).toEqual([]);
  });

  test("refuses an invalid pre-upgrade save instead of migrating it into a valid-looking v5", async ({ page }) => {
    /* The other half of the migration contract: the invalid source is rejected *before* the rewrite,
       so a broken v4 cannot become a plausible v5 with fabricated progression. */
    const legacy = toLegacyV4Save(buildSave(content, { screen: "home" }));
    const broken = { ...legacy.save, campaign: { ...(legacy.save.campaign as object), xp: -5 } };

    await clearSave(page);
    await seedLegacyRawSave(page, JSON.stringify(broken));
    await gotoApp(page, { expect: "recovery" });

    await expect(page.getByText("SAVE RECOVERY")).toBeVisible();
    await expect(page.locator("p.log")).toContainText("$.campaign.xp");
    /* Non-destructive: the original payload survives under its own key and is backed up. */
    expect(await page.evaluate((key: string) => window.localStorage.getItem(key), LEGACY_SAVE_STORAGE_KEY)).toBe(
      JSON.stringify(broken),
    );
    expect(await readBackup(page)).toBe(JSON.stringify(broken));
  });

  test("keeps a level gained through the UI after a reload", async ({ page }) => {
    /* W4-01/W4-05 together, through the real reward flow rather than a seeded level: claim a reward
       that crosses a threshold, then F5 and check the level is still there. */
    const errors = collectConsoleErrors(page);
    const reward = content.rewards.find((entry) => entry.id === firstEncounter.rewardId)!;
    await clearSave(page);
    /* Seed 15 XP below L2 so the real first reward crosses the shipped 40 XP threshold. */
    const startingXp = curve.thresholds[0] - 15;
    const seeded = buildSave(content, { screen: "reward", xp: startingXp }).raw;
    await seedRawSave(page, seeded);
    await gotoApp(page);
    expect((await readSave(page)).character).toEqual({ level: 1, xp: startingXp, unspentSkillPoints: 0 });
    const resultingXp = startingXp + reward.xp;
    const expectedLevel = levelForXp(resultingXp, curve);
    expect(expectedLevel).toBeGreaterThan(1);

    await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    const levelled = await readSave(page);
    expect(levelled.character).toEqual({
      level: expectedLevel,
      xp: resultingXp,
      unspentSkillPoints: skillPointsGranted(expectedLevel, curve),
    });
    await expect(progressionReadout(page)).toContainText(`Уровень ${expectedLevel}`);
    await expect(progressionReadout(page)).toContainText(`до уровня ${expectedLevel + 1}: ${xpToNextLevel(resultingXp, curve)} XP`);
    /* Unspent points persist even though nothing spends them yet (W4-03 is out of scope). */
    await expect(progressionReadout(page)).toContainText("нераспределённых очков");

    await reloadApp(page);

    /* The level survives the reload, byte for byte, and is still rendered. */
    expect(await readSave(page)).toEqual(levelled);
    await expect(progressionReadout(page)).toContainText(`Уровень ${expectedLevel}`);
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    expect(errors).toEqual([]);
  });

  test("charges the stated death penalty and keeps the result after a reload", async ({ page }) => {
    /* W4-02: the number the return screen shows is the number that is taken, and it persists. */
    const xp = curve.thresholds[0] + 20;
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, { screen: "return", xp, claimedRewards: [], firstDeathReturnUsed: true }).raw,
    );
    await gotoApp(page);

    await expect(phaseLabel(page)).toHaveText("ВОЗВРАТ");
    const notice = page.locator("p.death-penalty");
    await expect(notice).toBeVisible();
    const stated = Number(await notice.getAttribute("data-penalty"));
    expect(stated).toBeGreaterThan(0);

    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    const charged = await readSave(page);
    expect(charged.campaign.xp).toBe(xp - stated);
    expect(charged.character.level).toBe(levelForXp(xp, curve));

    await reloadApp(page);
    expect(await readSave(page)).toEqual(charged);
  });

  test("first defeat is free, and retreat costs no XP at all", async ({ page }) => {
    const xp = curve.thresholds[0] + 20;
    /* First defeat: nothing taken, allowance consumed. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "return", xp, claimedRewards: [] }).raw);
    await gotoApp(page);
    await expect(page.locator("p.death-penalty")).toContainText("Первое поражение");
    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const afterFirst = await readSave(page);
    expect(afterFirst.campaign.xp).toBe(xp);
    expect(afterFirst.campaign.firstDeathReturnUsed).toBe(true);

    /* Retreat, with the allowance already spent: still no XP cost, and a different message. */
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, {
        screen: "return",
        returnReason: "retreat",
        xp,
        claimedRewards: [],
        firstDeathReturnUsed: true,
      }).raw,
    );
    await gotoApp(page);
    await expect(page.locator("p.death-penalty")).toContainText("XP не теряется");
    await page.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    expect((await readSave(page)).campaign.xp).toBe(xp);
  });
});

test.describe("W1-04 rejection and recovery", () => {
  test("keys used by the fixtures still match src/game/save.ts", async () => {
    /* The specs address `localStorage` through duplicated literals; this fails the run if the app
       renames a key. */
    const source = await readFile(new URL("../src/game/save.ts", import.meta.url), "utf8");
    expect(source).toContain(`export const SAVE_STORAGE_KEY = "${SAVE_STORAGE_KEY}"`);
  });

  test("rejects a save referencing an encounter that is not in the catalog", async ({ page }) => {
    /* Acceptance criterion 3. Built by tampering with a *valid* fixture so the only difference is
       the dangling reference. */
    const valid = JSON.parse(buildSave(content, { screen: "home" }).raw);
    valid.campaign.encounters[0].id = "no-such-encounter";
    valid.campaign.mission.id = "no-such-encounter";
    const tampered = JSON.stringify(valid);

    await clearSave(page);
    await seedRawSave(page, tampered);
    await gotoApp(page, { expect: "recovery" });

    await expect(page.getByText("SAVE RECOVERY")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Сохранение не загружено" })).toBeVisible();
    /* The message names the offending paths rather than failing opaquely. It reports the *catalog*
       encounter that has gone missing from the save, not the bogus id that replaced it, which is
       the more useful direction for a player-facing message. */
    await expect(page.locator("p.log")).toContainText("$.campaign.encounters");
    await expect(page.locator("p.log")).toContainText(firstEncounter.id);
    /* Non-destructive: the payload survives and is backed up. */
    expect(await readRawSave(page)).toBe(tampered);
    expect(await readBackup(page)).toBe(tampered);
    /* Criterion 4: the app is still usable — an explicit reset is offered. */
    await expect(page.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" })).toBeEnabled();
    await expect(page.locator("main.game-shell.recovery")).toBeVisible();
  });

  test("rejects an unknown arena on an active encounter", async ({ page }) => {
    /* While an encounter is active, `activeEncounterId` and `arenaId` must agree with the catalog,
       so a tampered arena is caught. */
    const valid = JSON.parse(buildSave(content, { screen: "mission" }).raw);
    valid.arenaId = "no-such-arena";
    await clearSave(page);
    await seedRawSave(page, JSON.stringify(valid));
    await gotoApp(page, { expect: "recovery" });

    await expect(page.locator("main.game-shell.recovery")).toBeVisible();
    await expect(page.locator("p.log")).toContainText("$.activeEncounterId");
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toHaveCount(0);
  });

  test("accepts an unknown arena outside an active encounter — a gap worth recording", async ({ page }) => {
    /* Finding, not a specification. On `home`/`mission-select` there is no active encounter, so the
       cross-field rule that ties `arenaId` to `activeEncounterId` does not apply and `validateSave`
       never checks the bare `arenaId` against `campaignCatalog.arenaIds`. A save naming a
       non-existent arena therefore loads, and the value survives in storage until the next write
       replaces it with a catalog arena.
     *
     * Player impact today is nil: no screen reads `arenaId` before an encounter starts, and starting
     * one overwrites it. It is recorded as an executable assertion so that (a) the W1-04 claim
     * "unknown catalog references are rejected" is not overstated, and (b) if the validator is
     * tightened later, this test fails and the change is noticed deliberately. Fixing it would mean
     * editing `validateSave`, which is a gameplay-adjacent change W1-04 does not authorise. */
    const valid = JSON.parse(buildSave(content, { screen: "home" }).raw);
    valid.arenaId = "no-such-arena";
    await clearSave(page);
    await seedRawSave(page, JSON.stringify(valid));
    await gotoApp(page);

    /* Loaded, not recovered. */
    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();
    expect((await readSave(page)).arenaId).toBe("no-such-arena");

    /* The stale value is replaced by a catalog arena on the next persisted transition. */
    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    await expect(phaseLabel(page)).toHaveText("МИССИЯ");
    const after = await readSave(page);
    expect(content.arenas.all.map((arena) => arena.id)).toContain(after.arenaId);
    /* Criterion 4: no white screen at any point in this path. */
    await expect(page.locator("main.game-shell")).toBeVisible();
  });

  test("recovers to a playable base screen and then survives a reload", async ({ page }) => {
    /* Recovery is only useful if the *recovered* save is itself durable. */
    const corrupt = JSON.stringify({ schemaVersion: 99, arenaId: firstEncounter.arenaId });
    await clearSave(page);
    await seedRawSave(page, corrupt);
    await gotoApp(page, { expect: "recovery" });

    await page.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" }).click();
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();
    const recovered = await readSave(page);
    expect(recovered.campaign.screen).toBe("home");
    expect(recovered.campaign.xp).toBe(0);
    /* The corrupt original stays in the backup key. */
    expect(await readBackup(page)).toBe(corrupt);

    await reloadApp(page);

    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeEnabled();
    expect(await readSave(page)).toEqual(recovered);
    expect(await readBackup(page)).toBe(corrupt);
  });

  test("survives an unwritable storage quota without losing the screen", async ({ page }) => {
    /* Acceptance criteria: quota unavailable must not crash the app (criterion 4). `setItem` is
       replaced only *after* boot, so the app starts from a valid save and then meets a storage that
       refuses writes — the realistic ordering. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "home" }).raw);
    await page.addInitScript(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      let armed = false;
      (window as unknown as { __edenArmQuota: () => void }).__edenArmQuota = () => {
        armed = true;
      };
      window.localStorage.setItem = (key: string, value: string) => {
        if (armed) throw new DOMException("quota exceeded", "QuotaExceededError");
        original(key, value);
      };
    });
    await gotoApp(page);

    const before = await readSave(page);
    await page.evaluate(() => (window as unknown as { __edenArmQuota: () => void }).__edenArmQuota());

    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();

    /* The write failed, the failure is surfaced, and a retry is offered. */
    await expect(page.locator("p.save-status").first()).toContainText("Ошибка сохранения");
    await expect(page.getByRole("button", { name: "ПОВТОРИТЬ" }).first()).toBeVisible();
    /* No white screen, and the last durable save is untouched. */
    await expect(page.getByRole("heading", { name: "Бункер у периметра" })).toBeVisible();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    expect(await readSave(page)).toEqual(before);
  });

  test("does not silently discard a corrupt payload when the backup write also fails", async ({ page }) => {
    /* The shell must refuse to offer a reset it cannot make safe: with no backup, the single
       remaining copy of the player's data would be destroyed. */
    await clearSave(page);
    await seedRawSave(page, "{ not valid json");
    await page.addInitScript(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      window.localStorage.setItem = (key: string, value: string) => {
        if (key.includes("corrupt-backup")) throw new DOMException("quota exceeded", "QuotaExceededError");
        original(key, value);
      };
    });
    await gotoApp(page, { expect: "recovery" });

    await expect(page.getByText("SAVE RECOVERY")).toBeVisible();
    expect(await readBackup(page)).toBeNull();
    /* Reset is withheld and the reason is stated. */
    await expect(page.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" })).toHaveCount(0);
    await expect(page.locator("main.game-shell.recovery")).toContainText("Сброс заблокирован");
    /* The corrupt original is still exactly as the player left it. */
    expect(await readRawSave(page)).toBe("{ not valid json");
  });

  test("loads a schema-valid but hand-edited save — the documented anti-tamper limitation", async ({ page }) => {
    /* Acceptance criterion 5, asserted rather than only written down. A save with a completed zone
       and inflated XP that still satisfies every cross-field rule is accepted, because there is no
       integrity check on a client-only save. Anti-tamper is out of scope for W1-04; this test
       exists so the limitation is visible in the suite instead of living only in prose. */
    const allCompleted = Object.fromEntries(
      encounters.map((entry) => [entry.id, { status: "completed" as const, victories: 1, firstRewardClaimed: true }]),
    );
    const handEdited = buildSave(content, {
      screen: "home",
      encounterId: thirdEncounter.id,
      encounters: allCompleted,
      /* Not the catalog total: a value no legitimate playthrough produces. */
      xp: 9_999,
    });
    expect(handEdited.save.campaign.xp).not.toBe(
      xpForRewards(
        content,
        encounters.map((entry) => entry.rewardId),
      ),
    );

    await clearSave(page);
    await seedRawSave(page, handEdited.raw);
    await gotoApp(page);

    await expect(page.locator("main.game-shell.recovery")).toHaveCount(0);
    await expect(page.locator("main.game-shell")).toContainText("XP: 9999");
    expect((await readSave(page)).campaign.xp).toBe(9_999);
    expect((await readSave(page)).campaign.zone.status).toBe("completed");
    /* Every encounter shows as finished, so the tampered progress is fully honoured. */
    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();
    for (const encounter of encounters)
      await expect(missionCard(page, encounter.name).getByRole("button", { name: "ЗАВЕРШЕНО" })).toBeDisabled();
    /* Named here so the claim in the docs is traceable to an executable assertion. */
    expect(secondEncounter.id).toBeTruthy();
  });
});
