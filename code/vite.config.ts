import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact()],
  test: {
    /**
     * `e2e/` is owned by Playwright (W1-01). Vitest's default include pattern
     * matches every `*.spec.ts` in the project, so without this exclude
     * `npm test` would try to run the Playwright specs and fail on the
     * `@playwright/test` import.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    /**
     * A project whose `include` matches nothing must fail rather than report
     * success. Combined with the two explicit `include` patterns below, this is
     * what makes a whole missing environment loud instead of silent; per-file
     * coverage is guarded by `test-collection.test.ts`.
     */
    passWithNoTests: false,
    /**
     * W1-02 — two projects instead of a single global `environment: 'jsdom'`.
     *
     * jsdom costs roughly 0.8 s of setup per test file, and the 128 pre-existing
     * tests are pure-function tests that do not need a DOM. Splitting keeps them
     * in `node` and pays for jsdom only in `*.dom.test.tsx`, which is what the
     * W1-02 acceptance criterion about total `npm test` time depends on.
     *
     * `projects` is the Vitest 4 replacement for the removed
     * `environmentMatchGlobs`. A per-file `@vitest-environment` docblock also
     * works, but it is easy to forget in a new file and fails confusingly
     * (`document is not defined`), so the environment is pinned by path here.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          /**
           * `.test.ts` only. `*.test.ts` does **not** match `*.test.tsx` in the
           * glob implementation Vitest uses (verified: 17 files matched, none of
           * them `.tsx`), so the DOM files cannot leak into the node project and
           * fail on a missing `document`.
           */
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          /**
           * Any `.test.tsx` under `src/`, not just `*.dom.test.tsx`. The narrower
           * pattern would be the silent-skip trap this guards against: a new
           * `foo.test.tsx` would be collected by no project at all and `npm test`
           * would still report success. `test-collection.test.ts` asserts that
           * every test file on disk is claimed by exactly one project.
           */
          include: ['src/**/*.test.tsx'],
          /* Preact's DOM test utils need an explicit teardown between tests. */
          setupFiles: ['./src/test/dom-setup.ts'],
        },
      },
    ],
  },
})
