import { expect, test } from "@playwright/test";
import {
  clearSave,
  collectConsoleErrors,
  encounterStatus,
  gotoApp,
  missionCard,
  missionCards,
  phaseLabel,
  readSave,
  reloadApp,
  seedRawSave,
} from "./helpers/app";
import { buildSave, loadShippedContent, orderedEncounters } from "../src/test/campaign-save-fixtures";

/**
 * W7-01 criterion 4 + D-03 — walking **two zones** in a real browser.
 *
 * This is the QA the W7-01 ticket asks for by name ("E2E прохождения двух зон подряд") and the half that could not be
 * written before decision D-03, because until it landed the build shipped a single zone and there was no second zone to
 * walk into.
 *
 * What it establishes that no unit test can. Zone unlocking is spread across four layers that each hold their own copy
 * of "what order is the campaign in": `zones.json`, the campaign transitions, the save validator and the mission-select
 * screen. Every one of those was wrong for a multi-zone build until D-03, in ways that agreed with each other while one
 * zone shipped:
 *
 *   - the campaign sequenced encounters by mission `order` alone, which repeats per zone, so two zones **interleaved**
 *     (`zone1-1, zone2-1, zone1-2, …`) and clearing zone one's opener unlocked zone two's;
 *   - the save validator required every stored encounter to belong to the *active* zone, which no two-zone save can
 *     satisfy, so a zone-two save was rejected as malformed.
 *
 * Both are invisible to a single-zone walkthrough and both are load-bearing for a player, which is why this spec asserts
 * the *whole* ladder rather than a single screen.
 *
 * Determinism: no combat is played here. Encounter outcomes are the business of `campaign-happy-path.spec.ts`; this spec
 * seeds progress states and asserts what the shell shows and persists, so it cannot flake on a dice roll.
 *
 * Every expected value is read from the shipped catalogs, so the spec cannot drift from content.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const zones = [...content.zones].sort((left, right) => left.order - right.order);

const encountersOf = (zoneId: string) => encounters.filter((mission) => mission.zoneId === zoneId);

test.describe("W7-01 two zones, walked in order", () => {
  test("ships at least two zones, each with its own encounters numbered from 1", async () => {
    /* The premise of every assertion below. Stated as a test rather than assumed, so that a content change which drops
       zone two fails here with a clear reason instead of making the rest of this file vacuously pass. */
    expect(zones.length, "D-03 ships more than one zone").toBeGreaterThanOrEqual(2);
    zones.forEach((zone, index) => expect(zone.order, `zone ${zone.id} order`).toBe(index + 1));
    for (const zone of zones) {
      const own = encountersOf(zone.id);
      expect(own.length, `zone ${zone.id} has encounters`).toBeGreaterThanOrEqual(3);
      /* `order` restarts at 1 in every zone — the property that made sorting by `order` alone interleave the zones. */
      own.forEach((mission, index) => expect(mission.order, `${mission.id} order`).toBe(index + 1));
    }
    /* The campaign sequence is zone by zone, not interleaved: every encounter of zone one precedes zone two's. */
    const zoneSequence = encounters.map((mission) => mission.zoneId);
    expect(zoneSequence).toEqual([...zoneSequence].sort((left, right) => {
      const orderOf = (id: string) => zones.findIndex((zone) => zone.id === id);
      return orderOf(left) - orderOf(right);
    }));
  });

  test("shows only the first zone's encounters as reachable on a fresh save", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select" }).raw);
    await gotoApp(page);

    /* Every catalog encounter is listed, including zone two's: mission select is a map of the campaign, not only of the
       reachable part. What differs is which ones can be entered. */
    await expect(missionCards(page)).toHaveCount(encounters.length);

    const save = await readSave(page);
    const firstZone = encountersOf(zones[0].id);
    const laterZones = encounters.filter((mission) => mission.zoneId !== zones[0].id);

    expect(encounterStatus(save, firstZone[0].id)?.status).toBe("available");
    for (const mission of firstZone.slice(1)) expect(encounterStatus(save, mission.id)?.status).toBe("locked");
    /* The defect this pins: with the zones interleaved, zone two's opener was `available` from the start. */
    for (const mission of laterZones)
      expect(encounterStatus(save, mission.id)?.status, `${mission.id} must stay locked behind zone one`).toBe("locked");

    /* The ladder agrees: zone one open, everything after it closed. */
    expect(save.campaign.zones.map((zone) => zone.status)).toEqual(
      zones.map((_zone, index) => (index === 0 ? "available" : "locked")),
    );
    expect(save.campaign.zone).toEqual({ id: zones[0].id, status: "available" });
    expect(errors).toEqual([]);
  });

  test("opens the second zone only after the first one's last encounter, and keeps it after a reload", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const firstZone = encountersOf(zones[0].id);
    const secondZone = encountersOf(zones[1].id);

    /*
     * Positioned on the first encounter of zone two, which is only a valid save if the whole of zone one is completed —
     * `buildSave` derives that plan, and `validateSave` refuses the fixture otherwise. So seeding this state at all is
     * already the assertion that the ladder and the encounter list agree; a rejected fixture throws before the browser
     * opens. This is the state the save validator used to reject outright.
     */
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select", encounterId: secondZone[0].id }).raw);
    await gotoApp(page);

    const save = await readSave(page);
    for (const mission of firstZone) expect(encounterStatus(save, mission.id)?.status).toBe("completed");
    expect(encounterStatus(save, secondZone[0].id)?.status).toBe("available");
    for (const mission of secondZone.slice(1)) expect(encounterStatus(save, mission.id)?.status).toBe("locked");

    /* Zone one is closed, zone two is the active one, and `zone` follows the ladder rather than lagging behind it. */
    expect(save.campaign.zones[0]).toMatchObject({ id: zones[0].id, status: "completed" });
    expect(save.campaign.zones[1]).toMatchObject({ id: zones[1].id, status: "available" });
    expect(save.campaign.zone).toEqual({ id: zones[1].id, status: "available" });

    /* The player can actually enter it: the second zone's opener offers a start control, not a locked card. */
    await expect(missionCard(page, secondZone[0].name).getByRole("button")).toBeEnabled();

    /* Criterion 3: the whole ladder survives a reload, byte for byte. */
    await reloadApp(page);
    expect(await readSave(page)).toEqual(save);
    await expect(phaseLabel(page)).toHaveText("МИССИЯ");
    expect(errors).toEqual([]);
  });

  test("reports the campaign as finished once the last zone's last encounter is done", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const last = encounters.at(-1)!;
    await clearSave(page);
    await seedRawSave(
      page,
      buildSave(content, {
        screen: "home",
        encounterId: last.id,
        encounters: { [last.id]: { status: "completed", victories: 1, firstRewardClaimed: true } },
        zoneStatus: "completed",
      }).raw,
    );
    await gotoApp(page);

    const save = await readSave(page);
    /* No zone is left open, and the active zone says so instead of staying `available` — the state the ladder's
       reachability rule exists to make expressible. */
    expect(save.campaign.zones.every((zone) => zone.status === "completed")).toBe(true);
    expect(save.campaign.zone.status).toBe("completed");
    expect(errors).toEqual([]);
  });
});
