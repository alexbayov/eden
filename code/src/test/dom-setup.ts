/**
 * W1-02 — jsdom project setup.
 *
 * Three responsibilities:
 *
 * 1. Unmount every Preact tree after each test. `@testing-library/preact` renders into a
 *    container appended to `document.body`; without cleanup, a second test in the same file
 *    would query a stale tree and `getByRole` would match twice.
 * 2. Provide `matchMedia`, which jsdom 30 still does not implement. The shell does not use it
 *    today; stubbing it means a future media query cannot crash boot in jsdom.
 * 3. Silence exactly one expected jsdom limitation — `HTMLCanvasElement.getContext` — instead of
 *    installing the native `canvas` package. The shell renders the combat DOM and then asks
 *    Phaser for a WebGL/2D context; jsdom cannot provide one, so the shell takes its documented
 *    "боевая сцена не загрузилась" path. That is a *real* branch worth testing in jsdom, and the
 *    canvas itself is covered in a real browser by the W1-01 E2E specs. Only this message is
 *    filtered, by exact match: any other jsdom error still fails loudly.
 */
import { cleanup } from "@testing-library/preact";
import { afterEach, beforeAll, afterAll } from "vitest";

afterEach(() => {
  cleanup();
});

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** The single jsdom limitation this project accepts. Matched narrowly on purpose. */
const EXPECTED_JSDOM_NOISE = "Not implemented: HTMLCanvasElement's getContext()";

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
    if (text.includes(EXPECTED_JSDOM_NOISE)) return;
    originalConsoleError(...args);
  };
});

afterAll(() => {
  console.error = originalConsoleError;
});
