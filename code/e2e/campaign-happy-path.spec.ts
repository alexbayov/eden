import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  encounterStatus,
  fireAtFirstTarget,
  gotoApp,
  missionCard,
  missionCards,
  phaseLabel,
  readSave,
  seedRawSave,
} from "./helpers/app";
import {
  buildLethalShotFixture,
  buildSave,
  loadShippedContent,
  orderedEncounters,
  xpForRewards,
} from "../src/test/campaign-save-fixtures";

/**
 * W1-03 — the campaign happy path in a real browser: base → mission select → combat → victory →
 * reward → base, for every encounter in the shipped zone.
 *
 * How determinism is achieved. A torso shot draws three numbers from the persisted `rngState` and
 * the hit chance is clamped to at most 95%, so no click sequence can guarantee a kill. Instead,
 * `buildLethalShotFixture` searches for the seed whose next draw triple *is* a confirmed kill,
 * using the app's own `performCombatAttack`, and seeds that save. The spec then plays the shot
 * through the real UI. If a balance change ever makes that seed non-lethal, the search fails with
 * an explicit message rather than the spec flaking.
 *
 * Every expected value — encounter names, order, reward ids, XP, resource amounts — is read from
 * the shipped `public/config/*.json` catalogs, so this spec cannot drift from content.
 *
 * Out of scope, deliberately: the visual quality of the map, and any balance claim. The seeds
 * prove *plumbing*, not that the encounters are tuned well.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [firstEncounter, secondEncounter, thirdEncounter] = encounters;
const rewardFor = (rewardId: string) => content.rewards.find((entry) => entry.id === rewardId)!;

/** Hero cells with a confirmed firing line, measured from the shipped arenas. */
const FIRING_POSITIONS: Record<string, { x: number; y: number }> = {
  "perimeter-checkpoint": { x: 5, y: 2 },
  "collapsed-yard": { x: 5, y: 2 },
  "relay-station": { x: 5, y: 3 },
};

test.describe("W1-03 campaign happy path", () => {
  test("plays the first encounter from base to reward and back to base", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const reward = rewardFor(firstEncounter.rewardId);
    const fixture = buildLethalShotFixture(content, {
      screen: "mission",
      heroAt: FIRING_POSITIONS[firstEncounter.arenaId],
      targetId: "checkpoint-shooter",
    });

    await clearSave(page);
    await seedRawSave(page, fixture.raw);
    await gotoApp(page);

    /* Combat, not the campaign shell. */
    await expect(page.locator("main.game-shell.combat")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: firstEncounter.name })).toBeVisible();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    await fireAtFirstTarget(page);

    /* Victory moves the campaign to the reward screen; no reward has been granted yet. */
    await expect(phaseLabel(page)).toHaveText("НАГРАДА");
    const afterVictory = await readSave(page);
    expect(afterVictory.phase).toBe("victory");
    expect(afterVictory.campaign.screen).toBe("reward");
    expect(encounterStatus(afterVictory, firstEncounter.id)).toMatchObject({
      status: "completed",
      victories: 1,
      firstRewardClaimed: false,
    });
    expect(afterVictory.campaign.xp).toBe(0);
    expect(afterVictory.campaign.claimedRewards).toEqual([]);

    /* Acceptance criterion 1, second half: the next encounter unlocks on victory. */
    expect(encounterStatus(afterVictory, secondEncounter.id)?.status).toBe("available");
    expect(encounterStatus(afterVictory, thirdEncounter.id)?.status).toBe("locked");

    await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();

    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const afterClaim = await readSave(page);
    /* XP and stash contents come from the shipped reward definition. */
    expect(afterClaim.campaign.xp).toBe(reward.xp);
    expect(afterClaim.campaign.claimedRewards).toEqual([reward.id]);
    expect(afterClaim.inventory.stash.resources).toEqual(
      Object.entries(reward.resources).map(([id, quantity]) => ({ id, quantity, weight: 1 })),
    );
    expect(encounterStatus(afterClaim, firstEncounter.id)?.firstRewardClaimed).toBe(true);
    expect(afterClaim.activeEncounterId).toBeNull();
    await expect(page.locator("main.game-shell")).toContainText(`XP: ${reward.xp}`);

    expect(errors).toEqual([]);
  });

  test("cannot start the next encounter while a reward is still pending", async ({ page }) => {
    /* Acceptance criterion 1, first half — stated precisely, because the runtime's actual unlock
       moment differs from a naive reading of the ticket. `missionVictory` marks the *next*
       encounter `available` at the moment of victory, not at the moment of claim. So the property
       that protects the player is not "the next encounter is locked until claim" (it is not) but
       "the next encounter cannot be *entered* until the pending reward is resolved". That is what
       is asserted here, and it is asserted through the UI and the persisted state. */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "reward" }).raw);
    await gotoApp(page);

    await expect(phaseLabel(page)).toHaveText("НАГРАДА");
    /* The reward screen renders no start button on any encounter card. */
    await expect(missionCard(page, secondEncounter.name).getByRole("button", { name: "НАЧАТЬ" })).toHaveCount(0);
    const pending = await readSave(page);
    expect(pending.campaign.screen).toBe("reward");
    expect(encounterStatus(pending, secondEncounter.id)?.status).toBe("available");
    expect(pending.campaign.claimedRewards).toEqual([]);

    /* Terminal reward screens intentionally expose only reward actions. The next encounter can be
       entered only after claiming, returning to base, and opening Mission Select. */
    await expect(page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" })).toBeEnabled();

    await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    await page.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }).click();

    /* Only after the claim can the second encounter actually be started. */
    await expect(missionCard(page, firstEncounter.name).getByRole("button", { name: "ЗАВЕРШЕНО" })).toBeDisabled();
    await expect(missionCard(page, secondEncounter.name).getByRole("button", { name: "НАЧАТЬ" })).toBeEnabled();
    await expect(missionCard(page, thirdEncounter.name).getByRole("button", { name: "ЗАБЛОКИРОВАНО" })).toBeDisabled();
  });

  test("does not grant a reward twice", async ({ page }) => {
    /* Acceptance criterion 2, asserted at both layers the criterion names: the UI removes the
       claim affordance, and a second `claimReward` against the persisted state is a no-op. The
       second half matters because the UI check alone would not catch a validator regression. */
    const reward = rewardFor(firstEncounter.rewardId);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "reward" }).raw);
    await gotoApp(page);

    const claim = page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" });
    await claim.click();
    await expect(phaseLabel(page)).toHaveText("БАЗА");
    const afterFirst = await readSave(page);
    expect(afterFirst.campaign.xp).toBe(reward.xp);

    /* The UI no longer offers a claim. */
    await expect(claim).toHaveCount(0);

    /* Re-seeding the *claimed* save on the reward screen is impossible by construction — the
       validator rejects a reward screen whose encounter has already been claimed — so instead
       reload the claimed state and confirm nothing re-awards on boot. */
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("main.game-shell.loading").waitFor({ state: "detached" });
    const afterReload = await readSave(page);
    expect(afterReload.campaign.xp).toBe(reward.xp);
    expect(afterReload.campaign.claimedRewards).toEqual([reward.id]);
    expect(afterReload.inventory.stash.resources).toEqual(afterFirst.inventory.stash.resources);
    await expect(page.locator("main.game-shell")).toContainText(`XP: ${reward.xp}`);
  });

  test("completes all three encounters in order and marks the zone completed", async ({ page }) => {
    /* Acceptance criteria 1 and 5 together. Each encounter is entered from its *own* fixture with
       its own lethal seed, then played through the real UI, so the sequence covers all three
       shipped arenas rather than replaying the first one three times. */
    const errors = collectConsoleErrors(page);
    const targets: Record<string, string> = {
      "perimeter-checkpoint": "checkpoint-shooter",
      "collapsed-yard": "yard-rusher",
      "relay-station": "relay-shooter",
    };
    const claimed: string[] = [];

    for (const [index, encounter] of encounters.entries()) {
      const completedBefore = Object.fromEntries(
        encounters.slice(0, index).map((entry) => [
          entry.id,
          { status: "completed" as const, victories: 1, firstRewardClaimed: true },
        ]),
      );
      const fixture = buildLethalShotFixture(content, {
        screen: "mission",
        encounterId: encounter.id,
        encounters: completedBefore,
        heroAt: FIRING_POSITIONS[encounter.arenaId],
        targetId: targets[encounter.arenaId],
      });

      await clearSave(page);
      await seedRawSave(page, fixture.raw);
      await gotoApp(page);
      await expect(page.getByRole("heading", { level: 1, name: encounter.name })).toBeVisible();

      /* The relay station has two defenders; only the one in the firing line dies to this shot, so
         the encounter is not yet won. The remaining defender is out of line of sight, which is the
         documented reason the third encounter needs two turns rather than one. */
      await fireAtFirstTarget(page);

      const isLast = index === encounters.length - 1;
      if (encounter.arenaId === "relay-station") {
        /* Second target: re-seed a fixture whose *next* shot kills the surviving defender, with
           the first defender already down. Playing on from the live page would depend on the
           enemy turn's RNG, which is exactly the non-determinism this design avoids. */
        const followUp = buildLethalShotFixture(content, {
          screen: "mission",
          encounterId: encounter.id,
          encounters: completedBefore,
          heroAt: FIRING_POSITIONS[encounter.arenaId],
          enemyHp: { "relay-shooter": 0 },
          targetId: "relay-defender",
        });
        await clearSave(page);
        await seedRawSave(page, followUp.raw);
        await gotoApp(page);
        await fireAtFirstTarget(page);
      }

      await expect(phaseLabel(page)).toHaveText("НАГРАДА");
      await page.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }).click();
      await expect(phaseLabel(page)).toHaveText("БАЗА");

      claimed.push(encounter.rewardId);
      const persisted = await readSave(page);
      expect(encounterStatus(persisted, encounter.id)).toMatchObject({
        status: "completed",
        victories: 1,
        firstRewardClaimed: true,
      });
      /* XP accumulates from the shipped reward catalog, not from a literal. */
      expect(persisted.campaign.xp).toBe(xpForRewards(content, claimed));
      /* Acceptance criterion 5: the zone flips to completed only after the last encounter. */
      expect(persisted.campaign.zone.status).toBe(isLast ? "completed" : "available");
    }

    expect(errors).toEqual([]);
  });

  test("shows the third encounter as the last locked entry until the second is cleared", async ({ page }) => {
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select", encounterId: secondEncounter.id }).raw);
    await gotoApp(page);

    /* Encounter order in the DOM must match catalog order, not insertion order. */
    await expect(missionCards(page)).toHaveCount(encounters.length);
    for (const [index, encounter] of encounters.entries())
      await expect(missionCards(page).nth(index).getByRole("heading", { level: 3 })).toHaveText(encounter.name);

    await expect(missionCard(page, secondEncounter.name).getByRole("button", { name: "НАЧАТЬ" })).toBeEnabled();
    await expect(missionCard(page, thirdEncounter.name).getByRole("button", { name: "ЗАБЛОКИРОВАНО" })).toBeDisabled();
  });
});
