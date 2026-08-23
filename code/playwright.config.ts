import { defineConfig, devices } from "@playwright/test";

/**
 * W1-01 — first real browser harness in this repository.
 *
 * The `test:e2e` scripts build immediately before Playwright starts `vite preview`.
 * `reuseExistingServer: false` then prevents a leftover preview process from masking
 * that fresh build. Both safeguards are required: this flag alone cannot refresh dist.
 */
const PORT = 4317;

export default defineConfig({
  testDir: "./e2e",
  /* Forbid accidentally committed test.only in CI. */
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    /* Acceptance criterion 3: trace + screenshot must exist for a failed test. */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
      command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
