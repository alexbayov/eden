import { expect, test } from "@playwright/test";
import { clearSave, collectConsoleErrors, gotoApp, phaseLabel, readSave, seedRawSave } from "./helpers/app";
import { buildSave, loadShippedContent, orderedEncounters } from "../src/test/campaign-save-fixtures";

/**
 * W10-02 criteria 3 and 4 — the game makes no outbound request and sends no player data anywhere.
 *
 * Why this has to be an E2E test. `platform.test.ts` proves the no-op implementation touches no transport, but that is a
 * statement about one module. The claim the ticket actually makes is about the *application*: nothing in the shipped
 * bundle — not analytics, not a font, not a stray SDK script — talks to a third party. Only a real browser with every
 * request intercepted can establish that, and it is the difference between "we did not write a fetch" and "the page
 * makes none".
 *
 * The check is a whitelist, not a blocklist: every request is recorded and anything not served by the local preview
 * origin fails the test. A blocklist of known trackers would pass a domain nobody thought to list.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);

/** Requests to the app's own origin are the bundle loading itself; anything else is off-device traffic. */
const isLocal = (url: string, baseURL: string) => url.startsWith(baseURL) || url.startsWith("data:") || url.startsWith("blob:");

test.describe("W10-02 the game runs with no platform and no network", () => {
  test("issues no request outside its own origin while playing", async ({ page, baseURL }) => {
    const errors = collectConsoleErrors(page);
    const external: string[] = [];
    /* Every request the page makes, including ones the service worker or a lazy chunk would trigger. */
    page.on("request", (request) => {
      if (!isLocal(request.url(), baseURL!)) external.push(`${request.method()} ${request.url()}`);
    });

    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select" }).raw);
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("МИССИЯ");

    /* Enter an encounter, which is what loads the lazy Phaser chunk — the largest and most likely place for an
       unexpected remote asset to hide. */
    await page.getByRole("button", { name: "НАЧАТЬ" }).first().click();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");

    expect(external, `unexpected outbound requests: ${external.join(", ")}`).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("plays a full encounter path with no platform present, and keeps progress locally", async ({ page, baseURL }) => {
    /* Criteria 1 and 2: no game path is blocked by the absence of a platform, and progress lives in local storage where
       a missing cloud save cannot touch it. */
    const errors = collectConsoleErrors(page);
    const external: string[] = [];
    page.on("request", (request) => {
      if (!isLocal(request.url(), baseURL!)) external.push(request.url());
    });

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
    await expect(phaseLabel(page)).toHaveText("БАЗА");

    /* The campaign can be finished without a platform: the terminal state is reached and persisted locally. */
    const save = await readSave(page);
    expect(save.campaign.zones.every((zone) => zone.status === "completed")).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("exposes no platform global that a page script could have injected", async ({ page }) => {
    /* Nothing in the bundle may register a platform SDK by side effect. If a real adapter is added later it must be
       wired explicitly through `withPlatform`, and this test is what makes an accidental global fail. */
    await clearSave(page);
    await gotoApp(page);
    const globals = await page.evaluate(() => ({
      ysdk: "ysdk" in window,
      ya: "ya" in window,
      gtag: "gtag" in window,
      dataLayer: "dataLayer" in window,
    }));
    expect(globals).toEqual({ ysdk: false, ya: false, gtag: false, dataLayer: false });
  });
});
