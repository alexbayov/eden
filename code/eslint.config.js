import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  /* E2E specs run in node but evaluate browser code inside page.evaluate. */
  { files: ['e2e/**/*.ts', 'playwright.config.ts'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
)
