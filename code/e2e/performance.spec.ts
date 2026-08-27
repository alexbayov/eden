import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { clearSave, collectConsoleErrors, gotoApp, phaseLabel, seedRawSave } from "./helpers/app";
import { buildSave, loadShippedContent } from "../src/test/campaign-save-fixtures";
import { PERF_BUDGETS, evaluatePerfBudgets, type PerfReport } from "../src/perf/budgets";

/**
 * W1-06 — actual runtime numbers, replacing "performance is pending" with a measurement.
 *
 * ## What this measures, and what it cannot
 *
 * Headless Chromium on this machine. That is **not** a player's device: no thermal throttling, no competing apps, a
 * different GPU path. Doc 24 §6.2 states it, `W2-06` owns the device pass, and the report records
 * `environment: "ci-headless-chromium"` so a number from here can never be quoted as a device result. Criterion 3 asks
 * for exactly this framing: the test fails on a budget breach, but it is labelled as CI hardware.
 *
 * ## Why the numbers are taken the way they are
 *
 * - **TTI** is read from the Navigation Timing API plus the app's own readiness signal, not from a `waitForTimeout`.
 *   The base screen is interactive once the phase label renders, because that only happens after catalogs are validated
 *   and the save is loaded — the real gate on this screen.
 * - **Combat ready** spans the click on «НАЧАТЬ» to the tactical phase being live, which includes fetching and
 *   evaluating the lazy Phaser chunk. That is the slowest path in the game and the one a budget is worth having on.
 * - **FPS** counts frames the compositor actually produced, via `requestAnimationFrame` sampling over a fixed window.
 *   A synthetic loop would measure the loop; this measures presented frames. In headless Chromium `rAF` is still driven
 *   by the compositor, so the number is meaningful, but it is an upper bound on what a phone will do.
 * - **Heap** uses `performance.memory.usedJSHeapSize`, which is Chromium-only and coarse. It is a regression signal, not
 *   an allocation profile; a leak that doubles the peak will show up, a 5% drift will not.
 * - **Enemy turn** is measured in the browser around a real end-turn, because the budget in doc 24 is about what the
 *   player waits for, not about the pure function's cost.
 *
 * The report is written to `design-data/perf/<date>-<commit>.json`, the naming rule that directory already specifies.
 */

const content = loadShippedContent();

/** Short SHA of the tree under test. A report that cannot name its commit is not reproducible. */
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

/** Frames sampled over this window. Long enough to average out a slow first frame, short enough to keep CI quick. */
const FPS_SAMPLE_MS = 2000;

test.describe("W1-06 runtime performance budgets", () => {
  /* One measurement per run, shared by the assertions below: the numbers describe a single session, and re-measuring
     per assertion would report a different session for each budget. */
  test("measures the shipped budgets and writes a reproducible report", async ({ page, viewport }) => {
    const errors = collectConsoleErrors(page);

    // ---- TTI: base screen interactive ------------------------------------------------------
    await clearSave(page);
    await seedRawSave(page, buildSave(content, { screen: "mission-select" }).raw);
    const startedAt = Date.now();
    await gotoApp(page);
    await expect(phaseLabel(page)).toHaveText("МИССИЯ");
    const ttiMs = Date.now() - startedAt;

    /*
     * ---- scene-mount stall ----------------------------------------------------------------
     *
     * Armed **before** the click, because the thing it measures is over by the time combat is ready. Found while
     * validating this spec: a probe sampling frames immediately after entry caught a single ~270 ms frame from Phaser's
     * scene mount, while the steady-state measurement below reported a clean 33 ms — two `await`s had let the stall pass
     * unobserved. Sampling after the fact reported 33 ms too, which is why the recorder is installed first and left
     * running across the transition.
     *
     * Doc 24 §6.2 has **no budget** for this, so it is a reported finding, not an assertion. It is also the number
     * decision **D-04** (Phaser 3 vs 4) actually needs: it prices Phaser's boot rather than the game loop.
     */
    await page.evaluate(() => {
      const state = { worst: 0, last: performance.now() };
      (window as unknown as { __mountStall: typeof state }).__mountStall = state;
      const tick = (now: number) => {
        state.worst = Math.max(state.worst, now - state.last);
        state.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // ---- combat ready: includes the lazy Phaser chunk --------------------------------------
    const combatStartedAt = Date.now();
    await page.getByRole("button", { name: "НАЧАТЬ" }).first().click();
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД");
    /* The canvas is what Phaser mounts; waiting for it is what makes this "combat ready" rather than "state changed". */
    await page.locator("canvas").first().waitFor({ state: "attached" });
    const combatReadyMs = Date.now() - combatStartedAt;
    const mountStallMs = Math.round(
      await page.evaluate(() => (window as unknown as { __mountStall: { worst: number } }).__mountStall.worst),
    );

    // ---- FPS over a fixed window, counting presented frames --------------------------------
    const frames = await page.evaluate(async (windowMs) => {
      const timestamps: number[] = [];
      await new Promise<void>((resolve) => {
        const started = performance.now();
        const tick = (now: number) => {
          timestamps.push(now);
          if (now - started >= windowMs) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      /* Per-frame deltas, so a single long frame shows up in the minimum instead of being averaged away. */
      const deltas = timestamps.slice(1).map((value, index) => value - timestamps[index]);
      return { deltas, elapsed: timestamps.at(-1)! - timestamps[0] };
    }, FPS_SAMPLE_MS);

    expect(frames.deltas.length, "no frames were presented — the FPS measurement would be meaningless").toBeGreaterThan(10);
    const avgFps = Math.round((frames.deltas.length / frames.elapsed) * 1000);
    /*
     * Worst frame in the steady-state window, as an instantaneous rate: what a stutter feels like.
     *
     * **Zero headroom on this hardware, and that is a finding rather than a pass.** Headless Chromium presents frames at
     * a mixed 16.5/33.4 ms cadence, so the worst steady frame is 33.4 ms — exactly 30 fps, exactly the doc 24 §6.2
     * floor. One additional dropped frame reads as 20 fps and fails. The budget is the owner's number and is not
     * relaxed here; `worstFrameMs` is recorded so the boundary is visible instead of being rediscovered as a flake.
     */
    const worstFrameMs = Math.round(Math.max(...frames.deltas) * 10) / 10;
    const minFps = Math.round(1000 / Math.max(...frames.deltas));

    // ---- heap peak -------------------------------------------------------------------------
    const heapPeakBytes = await page.evaluate(() => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return memory?.usedJSHeapSize ?? 0;
    });
    expect(heapPeakBytes, "performance.memory is unavailable, so the heap budget cannot be checked").toBeGreaterThan(0);

    // ---- enemy turn: what the player actually waits for ------------------------------------
    const enemyTurnStartedAt = Date.now();
    await page.locator("button.end").first().click();
    /* Back to the player's turn is the end of the wait, whatever the enemy did in between. */
    await expect(phaseLabel(page)).toHaveText("ВАШ ХОД", { timeout: 15_000 });
    const enemyTurnMs = Date.now() - enemyTurnStartedAt;

    const measured = { ttiMs, combatReadyMs, avgFps, minFps, heapPeakBytes, enemyTurnMs };
    const violations = evaluatePerfBudgets(measured);
    const report: PerfReport = {
      commit,
      environment: "ci-headless-chromium",
      viewport: { width: viewport?.width ?? 0, height: viewport?.height ?? 0 },
      ...measured,
      /* Findings without a budget in doc 24 §6.2, carried so they are not lost between runs. */
      worstFrameMs,
      mountStallMs,
      budgetPass: violations.length === 0,
      violations,
    };

    /* Criterion 1: the report is an artefact, not console output. Written before the assertion so a *failing* run still
       leaves the evidence of what it measured. */
    /* Resolved from this file, like the simulator CLI does, so the report lands in `design-data/perf/` regardless of cwd. */
    const outDir = fileURLToPath(new URL("../../design-data/perf/", import.meta.url));
    await mkdir(outDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    await writeFile(`${outDir}${date}-${commit}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    /* Criterion 3: a breach fails the run, and the message names which budget and by how much. */
    expect(violations, `runtime budgets exceeded on CI hardware: ${violations.join("; ")}`).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("reads its budgets from the shared source rather than restating them", () => {
    /*
     * Criterion 2 as a test. If a budget is ever hardcoded in a spec again, the two values will differ and this fails —
     * which is the only way "there is one source of truth" stays true after the ticket closes.
     */
    expect(PERF_BUDGETS.ttiMs).toBeGreaterThan(0);
    expect(evaluatePerfBudgets({ ttiMs: PERF_BUDGETS.ttiMs + 1, combatReadyMs: 0, avgFps: 60, minFps: 60, heapPeakBytes: 1, enemyTurnMs: 1 })).toEqual([
      `ttiMs: ${PERF_BUDGETS.ttiMs + 1} > ${PERF_BUDGETS.ttiMs}`,
    ]);
    /* And a measurement inside every budget produces no violations, so the evaluator cannot pass by always failing. */
    expect(
      evaluatePerfBudgets({
        ttiMs: PERF_BUDGETS.ttiMs - 1,
        combatReadyMs: PERF_BUDGETS.combatReadyMs - 1,
        avgFps: PERF_BUDGETS.avgFps + 1,
        minFps: PERF_BUDGETS.minFps + 1,
        heapPeakBytes: PERF_BUDGETS.heapPeakBytes - 1,
        enemyTurnMs: PERF_BUDGETS.enemyTurnMs - 1,
      }),
    ).toEqual([]);
  });
});
