/**
 * Static assertions for the M3-C responsive/accessibility CSS contract.
 *
 * Source-level checks, not rendered-layout checks. What is verified here is that the stylesheet
 * ships, is actually imported by the shell, declares the breakpoints and grid areas it claims to,
 * keeps the tactical panel visible on desktop, and never *declares* a target below the 44px floor.
 *
 * W1-05 UPDATE — these static checks are now complemented by actual measurements. Rendered geometry
 * is asserted in `e2e/viewport-geometry.spec.ts`, which lays the app out in Chromium at 360x640,
 * 390x844, 768x1024, 1280x720 and 800x400 and reads real `getBoundingClientRect` / `scrollWidth`
 * values: no horizontal overflow on any screen at any of those sizes, and no interactive element
 * measuring below 44x44 CSS px.
 *
 * Both layers are kept because neither subsumes the other. A declared `min-height: 44px` says
 * nothing about whether the rule matched or whether a flex parent compressed the control anyway,
 * which is what the measured suite catches. Conversely, these checks run in milliseconds on every
 * `npm test`, cover rules for states the E2E matrix does not enter (`prefers-reduced-motion`,
 * `:focus-visible`), and pin the intent of the stylesheet rather than one rendering of it.
 *
 * Neither layer is a device test: real device pixel ratios, touch input, safe-area insets and WebKit
 * remain unverified (W2-05, W2-06).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");
/** Stylesheet with comments stripped, so prose about :hover cannot satisfy or break a rule check. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const shell = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

/** Extracts the body of the first media query whose condition contains `needle`. */
const mediaBlock = (needle: string) => {
  const start = rules.indexOf(`@media ${needle}`);
  expect(start, `missing @media ${needle}`).toBeGreaterThan(-1);
  const open = rules.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < rules.length; i += 1) {
    if (rules[i] === "{") depth += 1;
    if (rules[i] === "}") {
      depth -= 1;
      if (depth === 0) return rules.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced @media ${needle}`);
};

describe("M3-C stylesheet is actually loaded", () => {
  it("is imported by the app shell so combat styles ship in the bundle", () => {
    expect(shell).toContain('import "./app.css"');
  });
});

describe("M3-C touch targets and hover independence", () => {
  it("sets a 44px floor for every shell button", () => {
    expect(rules).toMatch(/\.game-shell button\s*\{[^}]*min-height:\s*44px/);
    expect(rules).toMatch(/\.game-shell button\s*\{[^}]*min-width:\s*44px/);
  });

  it("never declares a target smaller than 44px", () => {
    const heights = [...rules.matchAll(/min-height:\s*(\d+(?:\.\d+)?)px/g)].map(
      (match) => Number(match[1]),
    );
    expect(heights.length).toBeGreaterThan(4);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  });

  it("keeps tactical and disclosure controls at or above 44px", () => {
    expect(rules).toMatch(/\.tactical-options button\s*\{[^}]*min-height:\s*44px/);
    expect(rules).toMatch(/\.disclosure\s*\{[^}]*min-height:\s*44px/);
  });

  it("uses no :hover rule for any affordance", () => {
    expect(rules).not.toContain(":hover");
  });

  it("marks recommended destinations with a persistent, non-hover style", () => {
    expect(rules).toContain(".tactical-options button.recommended");
    expect(rules).toMatch(
      /\.tactical-options button\.recommended\s*\{[^}]*border-color/,
    );
  });

  it("keeps a visible focus outline for keyboard users", () => {
    const base = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(base).toContain("button:focus-visible");
    expect(base).toContain("outline");
  });
});

describe("M3-C desktop layout", () => {
  it("renders the tactical command panel on desktop instead of hiding it", () => {
    expect(rules).toMatch(/\.tactical-command-panel\s*\{[^}]*display:\s*block/);
    expect(rules).not.toMatch(/\.tactical-command-panel\s*\{[^}]*display:\s*none/);
  });

  it("gives the panel its own grid area beside the canvas and hud", () => {
    expect(rules).toMatch(/\.battlefield\s*\{[^}]*grid-template-areas/);
    expect(rules).toContain('"canvas hud"');
    expect(rules).toContain('"panel hud"');
  });

  it("widens tactical option columns on wide desktop viewports", () => {
    const desktop = mediaBlock("(min-width: 1101px)");
    expect(desktop).toContain(".tactical-options");
    expect(desktop).toMatch(/minmax\(2\d\dpx/);
  });

  it("stacks canvas, panel and hud on tablet widths", () => {
    const tablet = mediaBlock("(max-width: 1100px)");
    expect(tablet).toContain('"canvas"');
    expect(tablet).toContain('"panel"');
    expect(tablet).toContain('"hud"');
  });
});

describe("M3-C mobile layout for 390x844", () => {
  it("declares a breakpoint that covers a 390px-wide viewport", () => {
    const mobile = mediaBlock("(max-width: 430px)");
    expect(mobile.length).toBeGreaterThan(50);
    expect(mobile).toContain(".tactical-options button");
    expect(mobile).toMatch(/min-height:\s*5\dpx/);
  });

  it("uses a single-column control grid on phones", () => {
    const phone = mediaBlock("(max-width: 760px)");
    expect(phone).toMatch(/\.tactical-options\s*\{[^}]*grid-template-columns:\s*1fr/);
    /* The battlefield collapses to one column. Matched on `.combat .battlefield` rather than the
       older bare `.battlefield,` group selector, which no longer exists: the phone block now scopes
       the rule to the combat shell and gives it explicit grid areas. */
    expect(phone).toMatch(/\.combat\s+\.battlefield\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("promotes each screen's primary action to a fixed bottom bar on phones", () => {
    /* This is the declaration behind the measured result in `e2e/viewport-geometry.spec.ts`: at
       360x640 and 390x844 every primary CTA is within the fold *because* of these rules. Asserted
       here too so the intent is pinned cheaply on every `npm test`, and so deleting the rule fails
       fast rather than only in the browser suite.

       Note the breakpoint this lives in: `max-width: 760px`. That is why 800x400 — 800 px wide and
       only 400 px tall — gets no sticky bar and keeps its CTA below the fold. */
    const phone = mediaBlock("(max-width: 760px)");
    expect(phone).toMatch(/\.combat\s+\.action-tray\s+\.fire\s*\{[^}]*position:\s*fixed/);
    /* Base, mission select, reward and return share one fixed-bar rule group. The base entry was
       added with the W5 panel: the stash overview, node ladder and craft/upgrade/dismantle catalogs
       pushed «ВЫБРАТЬ МИССИЮ» past a 640px fold, which `e2e/viewport-geometry.spec.ts` measures. */
    expect(phone).toContain(".campaign.mission-select .mission-card:first-child > button");
    expect(phone).toContain(".campaign.reward .campaign-grid > .card:last-child .actions > button:first-child");
    expect(phone).toContain(".campaign.return .campaign-grid > .card:last-child .actions > button:first-child");
    expect(phone).toContain(".campaign.home .home-panel .primary-actions > button:last-child");
    expect(phone).toMatch(/\.campaign\.home[^{]*\{[^}]*position:\s*fixed/);
    /* The tray and the campaign grid each reserve room, so a pinned CTA cannot cover the last row. */
    expect(phone).toMatch(/\.combat\s+\.action-tray\s*\{[^}]*padding-bottom/);
    expect(phone).toMatch(/\.campaign\s+\.campaign-grid\s*\{[^}]*padding-bottom/);
    /* Safe-area inset is respected rather than a bare 12px, which would sit under the home bar. */
    expect(phone).toContain("env(safe-area-inset-bottom)");
  });

  it("constrains the canvas by aspect ratio so controls stay on screen", () => {
    expect(mediaBlock("(max-width: 430px)")).toContain("aspect-ratio");
    expect(mediaBlock("(max-height: 480px) and (orientation: landscape)")).toContain(
      "height: 62vh",
    );
  });

  it("honours reduced-motion preferences", () => {
    expect(rules).toContain("prefers-reduced-motion");
  });
});
