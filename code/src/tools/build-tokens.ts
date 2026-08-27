/**
 * W8-01 — regenerates `src/tokens.css` from `src/tokens.ts`.
 *
 * The CSS file is a build artefact checked into the repository, because Vite reads it directly and adding a build
 * step to serve one file would slow every dev start for no benefit. Checking it in means it can drift, which is why
 * `tokens.test.ts` compares the two and fails on any disagreement — the generator is a convenience, the test is the
 * guarantee.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tokenDeclarations } from '../tokens'

const HEADER = `/*
 * W8-01 — GENERATED from src/tokens.ts. Do not edit by hand.
 *
 * Regenerate with: npm run tokens:build
 * Kept honest by tokens.test.ts, which fails when this file and the TS source disagree — the ticket forbids
 * duplicating values in two places without a check, and discipline is not a check.
 */
:root {
`

export const renderTokensCss = (): string =>
  `${HEADER}${tokenDeclarations()
    .map((declaration) => `  ${declaration.name}: ${declaration.value};`)
    .join('\n')}\n}\n`

const target = fileURLToPath(new URL('../tokens.css', import.meta.url))
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(target, renderTokensCss(), 'utf8')
  process.stdout.write(`tokens.css: ${tokenDeclarations().length} declarations\n`)
}
