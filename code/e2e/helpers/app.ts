import { expect, type Locator, type Page, type ConsoleMessage } from "@playwright/test";

/**
 * Storage keys are duplicated here on purpose: importing from `src/game/save.ts`
 * would pull the app's module graph (and its `vite/client` types) into the
 * Playwright tsconfig project. `smoke.spec.ts` reads `src/game/save.ts` and
 * asserts these literals still match, so drift fails the E2E run instead of
 * silently turning `clearSave`/`seedSave` into no-ops.
 */
export const SAVE_STORAGE_KEY = "eden.save.v5";
export const SAVE_BACKUP_KEY = "eden.save.v5.corrupt-backup";
/** The previous key, kept so the W4-05 migration spec can seed a pre-upgrade payload. */
export const LEGACY_SAVE_STORAGE_KEY = "eden.save.v4";

/**
 * Boot phases exposed by the shell's loading screen via `data-boot-phase`.
 * `selectBootView` in `src/game/boot-view.ts` is the single source of truth.
 */
export type BootPhase = "loading" | "recovery" | "ready";

/**
 * Init scripts registered for the *next* navigation only, keyed by page.
 *
 * `page.addInitScript` re-executes before every navigation, including `page.reload()`. Left
 * registered, a seeded payload would be re-applied on reload and silently overwrite whatever the
 * app had written since — which would make the W1-04 reload specs assert against the fixture
 * instead of against real persisted progress. `gotoApp`/`reloadApp` therefore dispose these
 * handles once the navigation they were queued for has happened, so seeding is strictly a
 * first-navigation operation and a reload observes exactly what the running app stored.
 */
const pendingInitScripts = new WeakMap<Page, Array<{ dispose: () => void }>>();

const queueInitScript = async (
  page: Page,
  script: (arg: never) => void,
  arg: unknown,
): Promise<void> => {
  /* `addInitScript`'s `Unboxed<Arg>` mapping cannot be satisfied by a generic parameter, so the
     serialisable payload is passed through `unknown` and narrowed inside each caller's callback. */
  const handle = await page.addInitScript(script as (arg: unknown) => void, arg);
  const queued = pendingInitScripts.get(page) ?? [];
  queued.push(handle);
  pendingInitScripts.set(page, queued);
};

/** Drops the seeding scripts so the next navigation does not re-apply them. */
const consumeInitScripts = (page: Page): void => {
  for (const handle of pendingInitScripts.get(page) ?? []) handle.dispose();
  pendingInitScripts.delete(page);
};

/**
 * Installs an init script that runs *before any page script* on the next navigation, so the app's
 * first `localStorage.getItem` already sees the value we want. Doing this after `page.goto` would
 * race the app's boot effect.
 */
async function seedStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await queueInitScript(
    page,
    (payload: Record<string, string>) => {
      for (const [key, value] of Object.entries(payload)) {
        window.localStorage.setItem(key, value);
      }
    },
    entries,
  );
}

/**
 * Guarantees a fresh-install state: no save, no corrupt backup. Must be called before
 * `gotoApp()`. A test that skips this inherits whatever the previous test wrote, because
 * Playwright reuses the browser process across tests in a file even though contexts are isolated.
 *
 * Like `seedRawSave`, this applies to the next navigation only — a reload must not wipe progress.
 */
export async function clearSave(page: Page): Promise<void> {
  await queueInitScript(
    page,
    (keys: string[]) => {
      for (const key of keys) window.localStorage.removeItem(key);
    },
    [SAVE_STORAGE_KEY, SAVE_BACKUP_KEY],
  );
}

/**
 * Writes a raw string under the save key before the next navigation. Accepts a
 * string (not an object) so tests can seed deliberately malformed payloads for
 * the recovery path.
 */
export async function seedRawSave(page: Page, raw: string): Promise<void> {
  await seedStorage(page, { [SAVE_STORAGE_KEY]: raw });
}

/** Writes a payload under the *previous* schema's key, for the W4-05 upgrade spec. */
export async function seedLegacyRawSave(page: Page, raw: string): Promise<void> {
  await seedStorage(page, { [LEGACY_SAVE_STORAGE_KEY]: raw });
}

/** Reads whatever is stored under the pre-upgrade key. */
export async function readLegacyRawSave(page: Page): Promise<string | null> {
  return page.evaluate((key: string) => window.localStorage.getItem(key), LEGACY_SAVE_STORAGE_KEY);
}

/** The base/reward progression readout (`Уровень N · XP …`), introduced by W4-01. */
export const progressionReadout = (page: Page): Locator => page.locator("p.progression").first();

/** The pre-return penalty notice on the return screen, introduced by W4-02. */
export const penaltyNotice = (page: Page): Locator => page.locator("p.death-penalty");

/** Writes a structured save under the save key before first navigation. */
export async function seedSave(page: Page, save: unknown): Promise<void> {
  await seedRawSave(page, JSON.stringify(save));
}

/** Reads the persisted save payload as a raw string, or null when absent. */
export async function readRawSave(page: Page): Promise<string | null> {
  return page.evaluate((key: string) => window.localStorage.getItem(key), SAVE_STORAGE_KEY);
}

/** Reads the corrupt-save backup payload as a raw string, or null when absent. */
export async function readBackup(page: Page): Promise<string | null> {
  return page.evaluate((key: string) => window.localStorage.getItem(key), SAVE_BACKUP_KEY);
}

/**
 * Shape of the persisted save, narrowed to the fields the specs assert on. Deliberately not
 * imported from `src/game/save.ts`: these specs must observe what is actually *in storage*, so a
 * structural type keeps the assertion independent of the app's own types.
 */
export interface PersistedSave {
  schemaVersion: number;
  arenaId: string;
  activeEncounterId: string | null;
  phase: "player" | "enemy" | "victory" | "defeat";
  turn: number;
  rngState: number;
  units: Array<{
    id: string;
    hp: number;
    maxHp: number;
    ap: number;
    team: string;
    x: number;
    y: number;
    /** Read by the W5-03 specs: a quick-slot use must move reserve ammo/durability, not the magazine. */
    weaponState?: { weaponInstanceId: string; magazine: number; reserveAmmo: number; durability: number };
    armor?: { armorInstanceId: string; durability: number };
  }>;
  campaign: {
    screen: string;
    activeMissionId: string | null;
    xp: number;
    claimedRewards: string[];
    firstDeathReturnUsed: boolean;
    /** Added by save v5 (W4-02): why the return screen was reached. */
    returnReason: "defeat" | "retreat" | null;
    zone: { id: string; status: string };
    mission: { id: string; status: string; victories: number; firstRewardClaimed: boolean };
    encounters: Array<{ id: string; status: string; victories: number; firstRewardClaimed: boolean }>;
  };
  /** Added by save v5 (W4-05). */
  character: { level: number; xp: number; unspentSkillPoints: number };
  inventory: {
    stash: { resources: Array<{ id: string; quantity: number }>; items: Array<{ id: string; quantity: number }> };
    backpack: { resources: Array<{ id: string; quantity: number }>; items: Array<{ id: string; quantity: number }> };
    /** W5-03: a spent stack must clear its slot; W5-05: a taken stack must clear it too. */
    quickSlots: Array<string | null>;
    equipment: Array<{ instanceId: string; itemId: string; durability: number }>;
  };
}

/** Units of `id` in one pool, or 0 when the stack is absent. `quantity` is never asserted directly. */
export const stackQuantity = (
  stacks: Array<{ id: string; quantity: number }>,
  id: string,
): number => stacks.find((stack) => stack.id === id)?.quantity ?? 0;

/** The hero unit as persisted. Fails the test when the save has none. */
export const persistedHero = (save: PersistedSave) => {
  const hero = save.units.find((unit) => unit.id === "hero");
  expect(hero, "expected a hero unit in the persisted save").toBeDefined();
  return hero!;
};

/** The quick-slot button for a 1-based slot number. */
export const quickSlotButton = (page: Page, slotNumber: number): Locator =>
  page.locator(`button[data-quick-slot="${slotNumber}"]`);

/** The dismantle control for an instance or stacked item id. */
export const dismantleButton = (page: Page, id: string): Locator =>
  page.locator(`button[data-dismantle="${id}"]`);

/** The W5-05 backpack-loss block on the return screen. */
export const lossNotice = (page: Page): Locator => page.locator("p.backpack-loss");

/** Reads and parses the persisted save. Fails the test when nothing is stored. */
export async function readSave(page: Page): Promise<PersistedSave> {
  const raw = await readRawSave(page);
  expect(raw, "expected a persisted save in localStorage").not.toBeNull();
  return JSON.parse(raw!) as PersistedSave;
}

/** Status of one encounter as persisted, by encounter id. */
export const encounterStatus = (save: PersistedSave, encounterId: string) =>
  save.campaign.encounters.find((entry) => entry.id === encounterId);

/**
 * Collects console errors and page errors for the lifetime of the page.
 *
 * W1-01 requires the allowlist to be empty, so this returns every error
 * verbatim and lets the spec assert an empty array. Attach it before
 * `gotoApp()` or boot-time errors are missed.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error: Error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  return errors;
}

/**
 * Navigates to the app root and waits for the shell to leave the loading
 * screen. The loading screen is the only element carrying `data-boot-phase`, so
 * its detachment is the boot signal; `expected: "recovery"` instead waits for
 * the recovery heading.
 */
export async function gotoApp(page: Page, options: { expect?: "ready" | "recovery" } = {}): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  /* The seeding scripts have served their navigation; a later reload must not re-run them. */
  consumeInitScripts(page);
  await waitForBoot(page, options.expect);
}

/** Reloads the page and waits for boot to settle again. Used by the W1-04 reload matrix. */
export async function reloadApp(page: Page, options: { expect?: "ready" | "recovery" } = {}): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  consumeInitScripts(page);
  await waitForBoot(page, options.expect);
}

async function waitForBoot(page: Page, expected: "ready" | "recovery" = "ready"): Promise<void> {
  if (expected === "recovery") {
    await page.locator("main.game-shell.recovery").waitFor({ state: "visible" });
    return;
  }
  await page.locator("main.game-shell.loading").waitFor({ state: "detached" });
}

/* ------------------------------------------------------------------ screen accessors */

/**
 * The campaign/phase readout (`БАЗА` / `МИССИЯ` / `ВАШ ХОД` / `НАГРАДА` / `ВОЗВРАТ` / …).
 * It has no accessible name, and it is the shell's own indication of which screen is mounted,
 * so it is addressed structurally rather than by role.
 */
export const phaseLabel = (page: Page): Locator => page.locator(".turn strong");

/** The visible battle log paragraph on the combat screen. */
export const combatLog = (page: Page): Locator => page.locator(".card.log p");

/** Encounter cards on the mission-select screen, in catalog order. */
export const missionCards = (page: Page): Locator => page.locator("article.mission-card");

/** The encounter card whose heading matches `name`. */
export const missionCard = (page: Page, name: string): Locator =>
  page.locator("article.mission-card").filter({ has: page.getByRole("heading", { name }) });

/** Target buttons in the tactical panel's «Видимые цели» group. */
export const targetOptions = (page: Page): Locator =>
  page.locator('.tactical-options[aria-labelledby="tactical-targets-title"] button');

/** The primary combat action. */
export const fireButton = (page: Page): Locator => page.getByRole("button", { name: "ОГОНЬ" });

/** The explicit no-reward exit from an active encounter. */
export const retreatButton = (page: Page): Locator => page.locator("button.retreat");

/** The end-turn control. */
export const endTurnButton = (page: Page): Locator => page.locator("button.end").first();

/**
 * Selects the first available target and fires once.
 *
 * Determinism comes from the seeded `rngState` in the save, not from this helper: the fixture
 * decides whether the shot lands. See `src/test/campaign-save-fixtures.ts`.
 */
export async function fireAtFirstTarget(page: Page): Promise<void> {
  const target = targetOptions(page).first();
  await expect(target).toBeEnabled();
  await target.click();
  const fire = fireButton(page);
  await expect(fire).toBeEnabled();
  await fire.click();
}
