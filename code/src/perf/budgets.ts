/**
 * W1-06 — runtime performance budgets, in one place.
 *
 * Criterion 2 asks that budgets come from doc 24 §6.2 rather than being restated inside a test. That is not tidiness:
 * a limit written twice is a limit that will disagree with itself, and the version inside a test is the one nobody
 * reads when tuning. So the numbers live here, the spec imports them, and the aggregation script imports the same
 * object — there is exactly one place to change a budget and exactly one place a reader has to trust.
 *
 * **These are CI-hardware measurements and nothing else.** Headless Chromium on a CI runner is not a proxy for a
 * player's phone: it has no thermal throttling, no competing apps and a different GPU path. Doc 24 §6.2 says so
 * explicitly, `W2-06` owns the device measurement, and every field carrying a number here is named so a reader cannot
 * mistake one for the other (`environment: 'ci-headless-chromium'` in the report).
 */

/** Doc 24 §6.2, verbatim. Milliseconds, frames per second, bytes. */
export const PERF_BUDGETS = {
  /** Base screen interactive: content parsed, catalogs validated, first paint usable. */
  ttiMs: 3000,
  /** Entering a mission, including the lazy Phaser chunk. The slowest path in the game. */
  combatReadyMs: 2500,
  avgFps: 45,
  minFps: 30,
  heapPeakBytes: 250 * 1024 * 1024,
  /** Enemy turn resolution. Measured deterministically, not in the browser — see the spec. */
  enemyTurnMs: 1500,
} as const

export type PerfBudgets = typeof PERF_BUDGETS

/** One measured run, written to `design-data/perf/<date>-<commit>.json` per that directory's naming rule. */
export interface PerfReport {
  commit: string
  /** `ci-headless-chromium` today. Present so a device measurement can never be confused with this one. */
  environment: string
  viewport: { width: number; height: number }
  ttiMs: number
  combatReadyMs: number
  avgFps: number
  minFps: number
  heapPeakBytes: number
  enemyTurnMs: number
  /**
   * Longest steady-state frame, in ms. **Not budgeted** — it is the same fact as `minFps`, kept because the rounded fps
   * figure hides how little headroom there is: 33.4 ms is exactly the 30 fps floor.
   */
  worstFrameMs: number
  /**
   * Longest single frame during Phaser's scene mount, in ms. **Not budgeted** by doc 24 §6.2.
   *
   * Reported because it is invisible to the steady-state measurement (it has passed before sampling begins) and because
   * it is the number decision **D-04** needs: it prices Phaser's boot, not the game loop.
   */
  mountStallMs: number
  /** False when any measured value is outside `PERF_BUDGETS`. The spec asserts on this, and on the detail below. */
  budgetPass: boolean
  /** Which budgets failed, named. An empty array is the passing state. */
  violations: string[]
}

const overBudget = (label: string, measured: number, limit: number, direction: 'max' | 'min'): string | null => {
  const failed = direction === 'max' ? measured > limit : measured < limit
  return failed ? `${label}: ${measured} ${direction === 'max' ? '>' : '<'} ${limit}` : null
}

/**
 * Compares measurements against the budgets, returning every violation rather than the first.
 *
 * Separated from the measuring code so it is testable without a browser, and so the pass/fail rule cannot quietly
 * differ between the spec and the aggregation script.
 */
export function evaluatePerfBudgets(
  measured: Pick<PerfReport, 'ttiMs' | 'combatReadyMs' | 'avgFps' | 'minFps' | 'heapPeakBytes' | 'enemyTurnMs'>,
  budgets: PerfBudgets = PERF_BUDGETS,
): string[] {
  return [
    overBudget('ttiMs', measured.ttiMs, budgets.ttiMs, 'max'),
    overBudget('combatReadyMs', measured.combatReadyMs, budgets.combatReadyMs, 'max'),
    overBudget('avgFps', measured.avgFps, budgets.avgFps, 'min'),
    overBudget('minFps', measured.minFps, budgets.minFps, 'min'),
    overBudget('heapPeakBytes', measured.heapPeakBytes, budgets.heapPeakBytes, 'max'),
    overBudget('enemyTurnMs', measured.enemyTurnMs, budgets.enemyTurnMs, 'max'),
  ].filter((entry): entry is string => entry !== null)
}
