/**
 * W1-02 — shared harness for the jsdom DOM tests.
 *
 * The shell fetches its catalogs from `/config/*.json` during boot. In jsdom there is no
 * server, so `stubShippedContent()` answers those requests from the *shipped* files in
 * `public/config/`. That keeps the DOM tests honest: they render the same catalog the browser
 * would load, and a broken content file fails here as well as in E2E.
 *
 * `renderApp()` returns after boot has settled, so a test never asserts against the loading
 * screen by accident. `renderBootingApp()` is the deliberate exception used by the
 * loading-screen test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor, type RenderResult } from "@testing-library/preact";
import { h } from "preact";
import { vi } from "vitest";
import { App } from "../app";
import { SAVE_BACKUP_KEY, SAVE_STORAGE_KEY } from "../game/save";

/**
 * Phaser never enters the jsdom module graph.
 *
 * W1-02 puts canvas testing out of scope by design (jsdom cannot provide a WebGL or 2D
 * context), and importing the real `combat-runtime` pulls Phaser's 1.4 MB bundle through Vite's
 * transform on every DOM run — about 3.2 s, which is most of the suite's wall time and would
 * break the acceptance criterion capping `npm test` growth.
 *
 * The stub keeps the shell's contract intact: `createCombatRuntime` resolves to an object with
 * `updateState`/`destroy`, so the combat DOM mounts and the canvas host element is created, but
 * nothing draws. The real runtime boundary is asserted separately by
 * `combat-runtime-boundary.test.ts` (lazy-import contract) and by `e2e/smoke.spec.ts`, which
 * proves in Chromium that a canvas with non-zero dimensions actually appears.
 */
vi.mock("../game/combat-runtime", () => ({
  createCombatRuntime: vi.fn(() =>
    Promise.resolve({
      updateState: () => {},
      destroy: () => {},
    }),
  ),
}));

/**
 * Config directory resolved through `node:path`, not through
 * `new URL("../../public/…", import.meta.url)`.
 *
 * Vite statically rewrites a *literal* `new URL(..., import.meta.url)` into an asset URL, and
 * under jsdom that resolves against `http://localhost:3000/`, so `readFileSync` would get
 * `/public/config/...` and fail with ENOENT. Keeping the path out of that pattern makes the
 * lookup a plain filesystem read in both environments.
 */
const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "config");

/** Reads a shipped config file from `public/config`. */
export const shippedConfig = (name: string): unknown =>
  JSON.parse(readFileSync(join(CONFIG_DIR, name), "utf8")) as unknown;

/**
 * Raw file text, cached per worker. The shell parses the response body itself, so the stub can
 * serve the original text and skip a parse+stringify round trip; every test in a file boots the
 * shell at least once, and this is read seven times per boot.
 */
const rawCache = new Map<string, string>();
const shippedConfigText = (name: string): string => {
  const cached = rawCache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(CONFIG_DIR, name), "utf8");
  rawCache.set(name, text);
  return text;
};

/**
 * Routes every `/config/x.json` fetch to `public/config/x.json`. Overrides let a test replace
 * one file (for the content-recovery case) without hand-building the other six; an override
 * set to `undefined` produces a 404, which is how a missing catalog is simulated.
 */
export function stubShippedContent(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      const name = href.replace(/^.*\/config\//, "");
      const overridden = Object.prototype.hasOwnProperty.call(overrides, name);
      if (overridden && overrides[name] === undefined)
        return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
      const body = overridden ? JSON.stringify(overrides[name]) : shippedConfigText(name);
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }),
  );
}

/** Removes both save keys so each test starts from a known storage state. */
export function clearStoredSave(): void {
  window.localStorage.removeItem(SAVE_STORAGE_KEY);
  window.localStorage.removeItem(SAVE_BACKUP_KEY);
}

/** Writes a raw payload under the save key before the shell boots. */
export const seedRawSave = (raw: string): void => window.localStorage.setItem(SAVE_STORAGE_KEY, raw);

/** Reads the raw persisted payload, or null when absent. */
export const readRawSave = (): string | null => window.localStorage.getItem(SAVE_STORAGE_KEY);

/** Reads the corrupt-save backup payload, or null when absent. */
export const readBackup = (): string | null => window.localStorage.getItem(SAVE_BACKUP_KEY);

/** Mounts the shell without waiting for boot: the loading screen is still on screen. */
export const renderBootingApp = (): RenderResult => render(h(App, {}));

/**
 * `waitFor` with a 5 ms poll instead of the library default of 50 ms. Every wait in the DOM
 * tests follows a synchronous click whose re-render lands within a frame, so the default
 * interval spends most of its time idle and inflates `npm test`. The generous timeout is kept
 * for CI headroom.
 */
export const settle = (assertion: () => void): Promise<void> =>
  waitFor(assertion, { timeout: 5_000, interval: 5 });

/**
 * Structural query, not a control query: identifies *which* screen the shell mounted.
 * `main.game-shell` carries no accessible name, so there is no role-based equivalent.
 */
export const shellElement = (container: Element): HTMLElement => {
  const element = container.querySelector<HTMLElement>("main.game-shell");
  if (!element) throw new Error("no main.game-shell rendered");
  return element;
};

/** The campaign/phase readout. Also unnamed, and also a screen indicator rather than a control. */
export const phaseLabel = (container: Element): string | null | undefined =>
  container.querySelector(".turn strong")?.textContent;

/** Parsed persisted save. Throws when nothing is stored, so a test cannot assert on `null`. */
export function persistedSave(): {
  phase: string;
  turn: number;
  arenaId: string;
  units: Array<{ id: string; hp: number; ap: number }>;
  campaign: { screen: string; xp: number; claimedRewards: string[] };
  inventory: { stash: { resources: Array<{ id: string; quantity: number; weight: number }> } };
} {
  const raw = readRawSave();
  if (raw === null) throw new Error("no save persisted");
  return JSON.parse(raw);
}

/**
 * Lets Preact's effect queue drain.
 *
 * Preact schedules `useEffect` callbacks on a `requestAnimationFrame` tick, so a microtask
 * flush is not enough. This matters for the shell's global keydown effect specifically: it has
 * no dependency array, so it re-registers on every render and the *currently registered*
 * handler belongs to the previously committed render. Without this wait, the first simulated
 * keypress after boot is still handled by the loading render's closure — where `campaign.screen`
 * is `home` — and a combat hotkey test would pass for the wrong reason.
 */
export const flushEffects = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/**
 * Mounts the shell, waits until the loading screen is gone, then drains pending effects. Boot
 * resolves seven fetches and a `structuredClone`, so this waits on the DOM rather than on a
 * fixed timeout.
 */
export async function renderApp(): Promise<RenderResult> {
  const result = render(h(App, {}));
  await waitFor(
    () => {
      if (result.container.querySelector("main.game-shell.loading"))
        throw new Error("still on the loading screen");
    },
    { timeout: 5_000, interval: 5 },
  );
  await flushEffects();
  return result;
}

export { SAVE_BACKUP_KEY, SAVE_STORAGE_KEY };
