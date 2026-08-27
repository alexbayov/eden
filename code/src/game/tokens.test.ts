/**
 * W8-01 — token tests.
 *
 * Three guarantees, and the second is the one that makes the rest durable:
 *
 *   1. **no literal colours outside the token files** (criterion 2) — otherwise the palette drifts back one
 *      convenient hex at a time;
 *   2. **TS and CSS agree** — the ticket forbids duplicating values in two places without a check, and the CSS is a
 *      checked-in artefact, so discipline is not sufficient;
 *   3. **contrast is measured, not assumed** (criterion 5).
 *
 * The lint test reads the stylesheets as text, the same technique `responsive-css.test.ts` uses. That is deliberate:
 * a rule about what the source may contain has to inspect the source.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BREAKPOINTS,
  COLORS,
  COLORS_ALPHA,
  COLORS_EXTENDED,
  CONTRAST_AA,
  FONT_SIZES,
  SIZES,
  SPACING,
  TEXT_PAIRS,
  contrastRatio,
  cssVariableName,
  luminance,
  tokenDeclarations,
} from '../tokens'
import { renderTokensCss } from '../tools/build-tokens'

const read = (path: string) => readFileSync(path, 'utf8')
const APP_CSS = read('src/app.css')
const INDEX_CSS = read('src/index.css')
const TOKENS_CSS = read('src/tokens.css')

describe('W8-01 no literal visual values outside the token files (criteria 1 and 2)', () => {
  it('finds no hex colour in app.css or index.css', () => {
    /*
     * The regression this exists for. Before the refactor `app.css` carried 59 distinct hex colours; a single new one
     * would restart the drift, and it would look perfectly reasonable in review.
     */
    for (const [label, css] of [
      ['app.css', APP_CSS],
      ['index.css', INDEX_CSS],
    ] as const) {
      const literals = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(literals, `${label} must reference tokens, found: ${literals.join(', ')}`).toEqual([])
    }
  })

  it('finds no literal rgb()/hsl() colour either', () => {
    /* The obvious way around a hex-only rule. Checked so the lint cannot be satisfied by changing notation. */
    for (const [label, css] of [
      ['app.css', APP_CSS],
      ['index.css', INDEX_CSS],
    ] as const) {
      const functional = css.match(/\b(?:rgb|rgba|hsl|hsla)\(/g) ?? []
      expect(functional, `${label} uses a literal colour function`).toEqual([])
    }
  })

  it('declares the 44px control floor once, as a token (criterion 3)', () => {
    /*
     * It was repeated **eleven** times in `app.css` — the ticket estimated six. `viewport-geometry.spec.ts` measures
     * the same number from its own constant, so this ties the stylesheet to the token rather than to a coincidence.
     */
    expect(SIZES.minTouchTarget).toBe(44)
    expect(APP_CSS).not.toMatch(/\b44px\b/)
    expect(APP_CSS).toContain('var(--size-min-touch-target)')
  })

  it('keeps every token referenced by the stylesheet actually defined', () => {
    /* A `var(--color-typo)` silently falls back to nothing, so an undefined reference is an invisible bug. */
    const referenced = new Set([...APP_CSS.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]))
    const defined = new Set(tokenDeclarations().map((declaration) => declaration.name))
    for (const name of referenced)
      expect(defined.has(name), `${name} is referenced by app.css but not defined in tokens.ts`).toBe(true)
    /* And the stylesheet genuinely uses tokens rather than having been trivially emptied. */
    expect(referenced.size).toBeGreaterThan(30)
  })
})

describe('W8-01 the CSS artefact cannot drift from the TS source', () => {
  it('matches what the generator would produce right now', () => {
    /*
     * `tokens.css` is checked in because Vite reads it directly and a build step for one file would slow every dev
     * start. Checked-in artefacts drift, so the generator is a convenience and *this* is the guarantee.
     */
    expect(TOKENS_CSS).toBe(renderTokensCss())
  })

  it('defines every token from every palette group', () => {
    const groups = { ...COLORS, ...COLORS_EXTENDED, ...COLORS_ALPHA }
    for (const key of Object.keys(groups))
      expect(TOKENS_CSS, `missing ${key}`).toContain(`${cssVariableName('color', key)}:`)
    for (const key of Object.keys(SIZES)) expect(TOKENS_CSS).toContain(`${cssVariableName('size', key)}:`)
    for (const key of Object.keys(SPACING)) expect(TOKENS_CSS).toContain(`${cssVariableName('space', key)}:`)
    for (const key of Object.keys(FONT_SIZES)) expect(TOKENS_CSS).toContain(`${cssVariableName('font', key)}:`)
    for (const key of Object.keys(BREAKPOINTS))
      expect(TOKENS_CSS).toContain(`${cssVariableName('breakpoint', key)}:`)
  })

  it('names variables predictably, so the mapping is generated rather than typed twice', () => {
    expect(cssVariableName('color', 'textMuted')).toBe('--color-text-muted')
    expect(cssVariableName('size', 'minTouchTarget')).toBe('--size-min-touch-target')
    expect(cssVariableName('color', 'bg')).toBe('--color-bg')
  })

  it('uses no duplicate hex value under two different names', () => {
    /*
     * Two names for one colour is how a palette stops being a vocabulary: a later change updates one and not the
     * other. Reported with both names so the duplicate is actionable.
     */
    const seen = new Map<string, string>()
    for (const [name, value] of Object.entries({ ...COLORS, ...COLORS_EXTENDED, ...COLORS_ALPHA })) {
      const previous = seen.get(value.toLowerCase())
      expect(previous, `${name} duplicates ${previous} (${value})`).toBeUndefined()
      seen.set(value.toLowerCase(), name)
    }
  })

  it('imports the tokens before any rule that references them', () => {
    /* A `@import` after a rule would leave the first rules unstyled in some engines. */
    expect(INDEX_CSS).toContain('@import "./tokens.css"')
    expect(INDEX_CSS.indexOf('@import')).toBeLessThan(INDEX_CSS.indexOf(':root {'))
  })
})

describe('W8-01 contrast is measured (criterion 5)', () => {
  it('meets WCAG AA on every text/background pair the UI renders', () => {
    for (const pair of TEXT_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg)
      expect(ratio, `${pair.label}: ${ratio.toFixed(2)}:1 below AA`).toBeGreaterThanOrEqual(CONTRAST_AA)
    }
    /* The list must actually cover the UI rather than being trimmed until it passes. */
    expect(TEXT_PAIRS.length).toBeGreaterThanOrEqual(12)
  })

  it('computes contrast correctly against known WCAG values', () => {
    /*
     * The check that makes the check trustworthy. A contrast function that always returned 21 would pass every
     * assertion above, so it is verified against the two ratios WCAG itself fixes: black on white is 21:1, and any
     * colour against itself is 1:1.
     */
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
    /* Order-independent, as the WCAG definition is. */
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456'), 6)
  })

  it('computes luminance at the documented endpoints', () => {
    expect(luminance('#000000')).toBeCloseTo(0, 6)
    expect(luminance('#ffffff')).toBeCloseTo(1, 6)
    /* Short hex is expanded rather than misparsed. */
    expect(luminance('#fff')).toBeCloseTo(luminance('#ffffff'), 6)
  })
})
