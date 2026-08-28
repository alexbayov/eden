import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { clearSave, collectConsoleErrors, gotoApp, seedRawSave } from "./helpers/app";
import { buildSave, loadShippedContent, orderedEncounters } from "../src/test/campaign-save-fixtures";
import { SETTINGS_STORAGE_KEY } from "../src/game/settings";

/**
 * W2-A — automated accessibility audit, closing `W2-04` criterion 4.
 *
 * ## Why this exists even though the ticket was marked done
 *
 * doc 24 §7.1 is titled "Автоматические (axe в E2E, W2-04)" and lists eight checks including "нарушения axe
 * critical/serious — ноль". `W2-04` names `e2e/a11y.spec.ts` under its own Tests section. Neither the file nor any axe
 * dependency existed, so **none** of those eight lines was actually checked and the gate G2 requirement was unverifiable.
 * Some of §7.1 is genuinely covered elsewhere — token contrast in `tokens.test.ts`, touch targets and geometry in
 * `viewport-geometry.spec.ts`, live regions in the DOM tests — so this file covers what was left, rather than duplicating
 * them.
 *
 * ## The negative control is not optional
 *
 * A passing audit and an audit that never ran produce the same output: zero violations. `the audit itself can fail`
 * below injects genuinely inaccessible markup and requires a violation, so "zero" means "checked and clean". I have made
 * the opposite mistake on this project already — treating an empty critic response as a pass — and this is the structural
 * fix for that class of error.
 *
 * ## What is deliberately not asserted
 *
 * `moderate` and `minor` findings are **reported, not enforced**. Failing on them would either force unrelated changes
 * into this ticket or invite someone to silence the rule wholesale; printing them keeps them visible and actionable. And
 * per `W2-04` criterion 5, this proves nothing about real assistive technology: no screen reader was involved, and full
 * WCAG validation requires manual testing with AT and expert review.
 */

const content = loadShippedContent();
const encounters = orderedEncounters(content);

/** The same five screens `viewport-geometry.spec.ts` audits, because "screen" means the same thing in both files. */
const SCREENS = [
  { name: "home", raw: () => buildSave(content, { screen: "home" }).raw },
  { name: "mission-select", raw: () => buildSave(content, { screen: "mission-select" }).raw },
  { name: "combat", raw: () => buildSave(content, { screen: "mission" }).raw },
  { name: "reward", raw: () => buildSave(content, { screen: "reward", encounterId: encounters[0].id }).raw },
  { name: "return", raw: () => buildSave(content, { screen: "return", encounterId: encounters[0].id }).raw },
] as const;

/**
 * WCAG tags to audit against, matching doc 24 §7.1's targets (contrast, names, roles, heading order).
 *
 * Pinned rather than left at axe's default so the audit's scope is a stated decision: a future axe release adding a new
 * best-practice rule would otherwise silently change what this gate means.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * The Phaser canvas is excluded from the audit, and this is the one exclusion in the file.
 *
 * A `<canvas>` is opaque to axe: it has no DOM inside it to name, label or contrast-check, so any finding against it is a
 * statement about the element wrapper rather than about our markup. It is excluded **by selector** so the exclusion is
 * visible and narrow — the surrounding tactical panel, HUD and every control stay in scope. The canvas's own
 * accessibility is a separate, unsolved problem: the board is conveyed to a screen reader by the live region and the
 * tactical panel, not by the canvas, which is why those are audited here and the canvas is not.
 */
const EXCLUDED_SELECTOR = "canvas";

interface Finding {
  id: string;
  impact: string;
  nodes: number;
  target: string;
}

const audit = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude(EXCLUDED_SELECTOR).analyze();
  const findings: Finding[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? "unknown",
    nodes: violation.nodes.length,
    target: String(violation.nodes[0]?.target?.[0] ?? "?"),
  }));
  return {
    blocking: findings.filter((finding) => finding.impact === "critical" || finding.impact === "serious"),
    advisory: findings.filter((finding) => finding.impact !== "critical" && finding.impact !== "serious"),
    /* Non-zero proves axe evaluated rules rather than bailing out early — see the negative control. */
    checked: results.passes.length,
  };
};

const describeFindings = (findings: readonly Finding[]) =>
  findings.map((finding) => `${finding.id} [${finding.impact}] ×${finding.nodes} @ ${finding.target}`).join("; ");

const openScreen = async (page: Page, raw: string, options: { highContrast?: boolean } = {}) => {
  await clearSave(page);
  await seedRawSave(page, raw);
  if (options.highContrast)
    await page.addInitScript(
      ([key, payload]) => window.localStorage.setItem(key, payload),
      [SETTINGS_STORAGE_KEY, JSON.stringify({ highContrast: true })] as const,
    );
  await gotoApp(page);
};

test.describe("W2-A automated accessibility audit", () => {
  test("the audit itself can fail, so a clean result means something", async ({ page }) => {
    /*
     * The control that makes every "zero violations" below trustworthy. Injects markup with two unambiguous, high-impact
     * problems — an unlabelled control and an image with no alternative — and requires axe to report them.
     *
     * Without this, a broken import, a wrong selector or an axe that silently no-ops would read as a perfect score.
     */
    await openScreen(page, buildSave(content, { screen: "home" }).raw);
    await page.evaluate(() => {
      const broken = document.createElement("div");
      broken.id = "a11y-negative-control";
      broken.innerHTML = '<button></button><img src="data:,x">';
      document.body.append(broken);
    });

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).include("#a11y-negative-control").analyze();
    expect(
      results.violations.length,
      "axe reported nothing against deliberately inaccessible markup, so it is not actually auditing",
    ).toBeGreaterThan(0);
    const ids = results.violations.map((violation) => violation.id);
    expect(ids, `expected a missing-name and a missing-alt finding, got: ${ids.join(", ")}`).toContain("button-name");
  });

  for (const screen of SCREENS)
    test(`has no critical or serious violations on ${screen.name}`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await openScreen(page, screen.raw());
      const { blocking, advisory, checked } = await audit(page);

      /* Proof the audit ran: zero passes would mean axe evaluated no rules at all. */
      expect(checked, `${screen.name}: axe evaluated no rules`).toBeGreaterThan(0);
      /* Advisory findings are surfaced rather than enforced — see the file header. */
      if (advisory.length) console.log(`a11y advisory on ${screen.name}: ${describeFindings(advisory)}`);
      expect(blocking.length, `${screen.name}: ${describeFindings(blocking)}`).toBe(0);
      expect(errors).toEqual([]);
    });

  for (const screen of SCREENS)
    test(`has no critical or serious violations on ${screen.name} in high contrast`, async ({ page }) => {
      /* A theme shipped as an accessibility feature (`W9-04`) has to survive the same audit as the default one. Its
         contrast ratio is separately asserted at 11.56:1 by `tokens.test.ts`; this checks the rendered result. */
      await openScreen(page, screen.raw(), { highContrast: true });
      await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
      const { blocking, advisory, checked } = await audit(page);

      expect(checked, `${screen.name} (high contrast): axe evaluated no rules`).toBeGreaterThan(0);
      if (advisory.length) console.log(`a11y advisory on ${screen.name} (high contrast): ${describeFindings(advisory)}`);
      expect(blocking.length, `${screen.name} (high contrast): ${describeFindings(blocking)}`).toBe(0);
    });
});
