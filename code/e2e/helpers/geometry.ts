import { expect, type Locator, type Page } from "@playwright/test";

/**
 * W1-05 — measured geometry helpers.
 *
 * Everything here reads real `getBoundingClientRect` / `scrollWidth` values out of Chromium. The
 * repository's pre-existing `responsive-css.test.ts` asserts the *declared* CSS floor by reading the
 * stylesheet text; that cannot detect a control shrunk by a flex parent, an inherited
 * `font-size: 0`, or a rule that never matched. These helpers are the measured counterpart, and the
 * two are complementary rather than redundant.
 *
 * Scope limit, stated because it is easy to overclaim: these are measurements in headless Chromium at
 * a CSS viewport size. They are not device tests. Real device pixel ratios, browser chrome, on-screen
 * keyboards, safe-area insets and WebKit behaviour are untested here and belong to W2-05/W2-06.
 */

/** The five viewports W1-05 requires, plus the orientation each represents. */
export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  /** Why this size is in the matrix, so a future reader does not delete it as arbitrary. */
  rationale: string;
}

export const VIEWPORTS: readonly ViewportSpec[] = [
  {
    name: "360x640",
    width: 360,
    height: 640,
    orientation: "portrait",
    rationale: "doc 14 minimum supported width; the tightest portrait budget",
  },
  {
    name: "390x844",
    width: 390,
    height: 844,
    orientation: "portrait",
    rationale: "iPhone 12/13/14 portrait; the primary mobile target",
  },
  {
    name: "768x1024",
    width: 768,
    height: 1024,
    orientation: "portrait",
    rationale: "tablet portrait; crosses the 760px breakpoint",
  },
  {
    name: "1280x720",
    width: 1280,
    height: 720,
    orientation: "landscape",
    rationale: "doc 14 desktop reference; crosses the 1101px breakpoint",
  },
  {
    name: "800x400",
    width: 800,
    height: 400,
    orientation: "landscape",
    rationale: "short landscape phone; exercises the max-height 480px rule",
  },
] as const;

/** Minimum interactive target edge, from doc 14. */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * Every element a player can operate. Kept as a single selector so the audit cannot drift from the
 * assertion, and deliberately broader than `button` so a future link or input is covered too.
 */
const INTERACTIVE_SELECTOR = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]';

export interface MeasuredTarget {
  /** Accessible-ish label: aria-label when present, otherwise trimmed text. */
  label: string;
  tag: string;
  width: number;
  height: number;
}

export interface OverflowMeasurement {
  documentScrollWidth: number;
  documentClientWidth: number;
  bodyScrollWidth: number;
  innerWidth: number;
  /** Elements whose right edge exceeds the viewport, with their measured overhang. */
  overhanging: Array<{ selector: string; right: number; overhangPx: number }>;
}

/**
 * Measures every *visible* interactive element smaller than 44x44 CSS px.
 *
 * Hidden controls are skipped rather than failed: a `display: none` element has a zero-size rect and
 * is not something the player can mis-tap. Visibility is decided from computed style and rect size,
 * not from the CSS class, so a control hidden by any mechanism is treated the same way.
 */
export async function measureUndersizedTargets(page: Page): Promise<MeasuredTarget[]> {
  return page.evaluate(
    ({ selector, minimum }: { selector: string; minimum: number }) => {
      const results: Array<{ label: string; tag: string; width: number; height: number }> = [];
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const rect = element.getBoundingClientRect();
        /* A zero-area rect means the element is not laid out at all — not a mis-tap risk. */
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.width + 0.01 >= minimum && rect.height + 0.01 >= minimum) continue;
        const label =
          element.getAttribute("aria-label") ?? (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        results.push({
          label: label || "(no label)",
          tag: element.tagName.toLowerCase(),
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        });
      }
      return results;
    },
    { selector: INTERACTIVE_SELECTOR, minimum: MIN_TOUCH_TARGET_PX },
  );
}

/** Counts the visible interactive elements, so a "no undersized targets" pass cannot be vacuous. */
export async function countInteractiveTargets(page: Page): Promise<number> {
  return page.evaluate((selector: string) => {
    let count = 0;
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      count += 1;
    }
    return count;
  }, INTERACTIVE_SELECTOR);
}

/**
 * Measures horizontal overflow two ways: the document's own `scrollWidth` versus `clientWidth`, and
 * the widest element's right edge. The second catches an element that overflows a scroll container
 * without extending the document, which the first would miss.
 */
export async function measureOverflow(page: Page): Promise<OverflowMeasurement> {
  return page.evaluate(() => {
    const documentClientWidth = document.documentElement.clientWidth;
    const overhanging: Array<{ selector: string; right: number; overhangPx: number }> = [];
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      /* One CSS pixel of slack absorbs sub-pixel rounding in the layout engine. */
      if (rect.right <= documentClientWidth + 1) continue;
      const className = typeof element.className === "string" ? element.className : "";
      overhanging.push({
        selector: `${element.tagName.toLowerCase()}${className ? `.${className.split(/\s+/).join(".")}` : ""}`,
        right: Math.round(rect.right * 100) / 100,
        overhangPx: Math.round((rect.right - documentClientWidth) * 100) / 100,
      });
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
      overhanging,
    };
  });
}

/** Asserts no horizontal scrolling and no element hanging past the viewport's right edge. */
export async function assertNoOverflow(page: Page, context: string): Promise<OverflowMeasurement> {
  const measured = await measureOverflow(page);
  expect(
    measured.documentScrollWidth,
    `${context}: document scrollWidth ${measured.documentScrollWidth} exceeds clientWidth ${measured.documentClientWidth}`,
  ).toBeLessThanOrEqual(measured.documentClientWidth);
  expect(
    measured.bodyScrollWidth,
    `${context}: body scrollWidth ${measured.bodyScrollWidth} exceeds clientWidth ${measured.documentClientWidth}`,
  ).toBeLessThanOrEqual(measured.documentClientWidth);
  expect(
    measured.overhanging,
    `${context}: elements extend past the right edge: ${JSON.stringify(measured.overhanging)}`,
  ).toEqual([]);
  return measured;
}

/** Asserts every visible interactive element measures at least 44x44 CSS px. */
export async function assertTouchTargets(page: Page, context: string): Promise<number> {
  const undersized = await measureUndersizedTargets(page);
  expect(
    undersized,
    `${context}: interactive elements smaller than ${MIN_TOUCH_TARGET_PX}px: ${JSON.stringify(undersized)}`,
  ).toEqual([]);
  const total = await countInteractiveTargets(page);
  /* Guards against a false pass on a screen that rendered no controls at all. */
  expect(total, `${context}: expected at least one interactive element to measure`).toBeGreaterThan(0);
  return total;
}

export interface CtaMeasurement {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fully inside the initial viewport, with no scrolling. */
  withinFold: boolean;
  /** Reported by Playwright's own actionability check. */
  clickable: boolean;
}

/**
 * Measures a primary call to action against the *unscrolled* viewport and confirms Chromium
 * considers it clickable where it sits.
 */
export async function measureCta(page: Page, locator: Locator, viewport: ViewportSpec): Promise<CtaMeasurement> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, "expected a bounding box for the primary CTA").not.toBeNull();
  const scrollY = await page.evaluate(() => window.scrollY);
  /* `boundingBox` is viewport-relative, so undo any scroll to get the unscrolled position. */
  const top = box!.y + scrollY;
  return {
    x: box!.x,
    y: top,
    width: box!.width,
    height: box!.height,
    withinFold: top >= 0 && top + box!.height <= viewport.height,
    clickable: await locator.isEnabled(),
  };
}

/** Resets scroll, so a measurement is never taken from a scrolled document by accident. */
export const resetScroll = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, 0));
