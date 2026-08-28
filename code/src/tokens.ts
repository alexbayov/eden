/**
 * W8-01 — the single source of visual values.
 *
 * **The problem this replaces.** `app.css` carried **59 distinct hex colours** and repeated the 44px minimum
 * control size **11 times** (the ticket estimated six). So doc 14's tap-target floor was a number maintained by
 * hand in eleven places, and a palette change meant a search-and-replace across two stylesheets with no way to
 * tell an intentional shade from a typo.
 *
 * **Why TypeScript is the source and CSS is derived.** The values are needed in both places — `TacticalScene`
 * draws on a canvas and cannot read CSS custom properties, while the stylesheet cannot import TS. Something has to
 * be duplicated, so the question is only *which copy is authoritative and how the other is kept honest*. TS is
 * authoritative because it is the one the type checker sees, and `tokens.css` is checked against it **by a test**
 * rather than by discipline — the ticket forbids "duplication without a check" in as many words.
 *
 * **What is deliberately not here.** No visual redesign: every value below is lifted from the existing stylesheets
 * unchanged, so this refactor is provably neutral. Theming is `W9-04`, which adds a *second* palette rather than
 * editing this one.
 */

/** Palette, grouped by the role each colour actually plays in the current stylesheets. */
export const COLORS = {
  /* Surfaces, darkest first. */
  bg: '#071017',
  surface: '#0c151b',
  surfaceRaised: '#101f27',
  surfaceAccent: '#14313d',

  /* Text, brightest first. Contrast against `bg` is asserted by `tokens.test.ts`. */
  text: '#e8f2f3',
  textStrong: '#d8f4f5',
  textMuted: '#b5c9d0',
  textDim: '#a8c0c8',
  textFaint: '#7f97a1',

  /* Accents. `accent` is the primary highlight and the focus ring. */
  accent: '#ffdc83',
  accentCool: '#65d7ff',
  accentCoolDim: '#73dff0',
  accentWarm: '#ffb36b',

  /* Status. `danger` for critical, `warning` for advisory, `success` for confirmation. */
  danger: '#ff8a7a',
  warning: '#ffb08a',
  success: '#6ad9a1',

  /* Lines and dividers. */
  border: '#49616c',
  borderDim: '#355767',
  borderMuted: '#4c7481',
} as const

/**
 * Control and layout sizing.
 *
 * `minTouchTarget` is the value doc 14 requires and `viewport-geometry.spec.ts` measures. It existed as eleven
 * separate `44px` literals; naming it once is the point of criterion 3.
 */

/**
 * Extended palette: shades each used one to four times by specific panels.
 *
 * Separate from `COLORS` so the core roles stay readable as a design vocabulary. These exist because criterion 1 asks
 * that **every** value reference a token — leaving forty rare shades as literals would have satisfied the letter of a
 * colour-lint rule while defeating its purpose.
 */
export const COLORS_EXTENDED = {
  surfaceDeepest: '#050a0f',
  surfaceDeep: '#09151d',
  surfaceSunken: '#0b1720',
  surfaceSunkenAlt: '#0b1820',
  surfaceInset: '#0e1e27',
  surfaceInsetCool: '#10222c',
  surfaceCoolAlt: '#122935',
  surfaceCool: '#122a34',
  surfaceCoolRaised: '#16303c',
  surfaceNeutral: '#1b2a33',
  surfaceCoolBright: '#1b3948',
  surfaceNeutralRaised: '#20323c',
  borderNeutral: '#28343b',
  borderSoft: '#2a3f4a',
  borderCool: '#33505d',
  surfaceAmberDim: '#343024',
  borderCoolDim: '#355262',
  borderCoolSoft: '#35545f',
  surfaceRose: '#382b30',
  surfaceAmberDeep: '#3a2a1a',
  surfaceAmber: '#3c3827',
  borderCoolBright: '#3d5a64',
  borderCoolVivid: '#436776',
  borderAmber: '#4a3f22',
  textSubtle: '#5d7c88',
  textSubtleStrong: '#6c8b96',
  accentSlateBright: '#6fa2b3',
  accentSlate: '#84b7c7',
  dangerDeep: '#85453d',
  textSlate: '#8aa2aa',
  successSoft: '#8ad6a0',
  successBright: '#9fe6c4',
  textCool: '#a3b6bd',
  textCoolStrong: '#b0c4cb',
  textPale: '#bdd0d5',
  textPaleStrong: '#c8d9dd',
  textPaleBright: '#cfe3e8',
  successPale: '#cfeadd',
  textIce: '#d6e7ec',
  dangerWarm: '#d98b6a',
  accentDeep: '#d9ad5f',
  accentSand: '#d9b46a',
  dangerBright: '#e47a68',
  dangerVivid: '#ee6f64',
  textWhite: '#effaff',
  warningPale: '#f0d3c4',
  accentPale: '#f0e5c4',
  accentLight: '#ffd9a8',
  accentCream: '#ffe6c7',
} as const

/**
 * Translucent values: panel overlays and shadows.
 *
 * Tokens rather than hex suffixes so a panel's opacity is one design decision instead of an `a8` repeated across six
 * rules. The alpha is part of the token because changing it independently of the base colour is exactly the edit that
 * produces an inconsistent surface.
 */
export const COLORS_ALPHA = {
  tintDanger: '#d98b6a17',
  tintSuccess: '#6ad9a114',
  tintAccent: '#d9b46a17',
  tintWarning: '#ffb36b1a',
  overlaySunken: '#0b1820e8',
  overlayRaised: '#101f27a8',
  overlayAccent: '#14313da8',
  shadowFaint: '#0005',
  shadowSoft: '#0008',
  shadowStrong: '#000a',
} as const

export const SIZES = {
  /** doc 14 §accessibility: the minimum tappable dimension. */
  minTouchTarget: 44,
  focusRing: 3,
  borderWidth: 1,
  accentBarWidth: 3,
} as const

/** Spacing scale, in px. Values taken from the existing stylesheet rather than invented. */
export const SPACING = { xs: 4, sm: 6, md: 8, lg: 10, xl: 14 } as const

/** Type scale, in px. */
export const FONT_SIZES = { xs: 12, sm: 13, md: 17, lg: 18, xl: 23, display: 30 } as const

/**
 * Breakpoints, in px.
 *
 * `stickyCta` is the one with behaviour attached: `@media (max-width: 760px)` promotes each screen's primary action
 * to a fixed bottom bar, and `viewport-geometry.spec.ts` keys its own expectations on the same number. It was
 * previously a literal in both places.
 */
export const BREAKPOINTS = {
  narrow: 430,
  stickyCta: 760,
  stacked: 1100,
  wide: 1400,
  shortLandscape: 480,
  /**
   * W2-F — height at or below which a viewport cannot hold a screen's content above its primary action.
   *
   * Distinct from `shortLandscape` (480), which only reshapes the combat canvas. This is the threshold at which the CTA
   * itself has to be pinned: measured against the two failing viewports, 1280×720 and 800×400, whose content overruns the
   * fold by 66–1318 px. It is deliberately *not* the only condition — `stacked` covers 768×1024, which is tall enough by
   * this measure yet stacks its content into a ~3000 px page. Height alone was the first attempt and left that viewport
   * broken.
   */
  shortViewport: 820,
} as const

/**
 * The CSS custom-property name for a token, so the mapping is generated rather than typed twice.
 *
 * `camelCase` → `--kebab-case` with a role prefix: `COLORS.textMuted` → `--color-text-muted`.
 */
export const cssVariableName = (group: string, key: string): string =>
  `--${group}-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

/** Every token as a `--name: value` pair, in the order the stylesheet declares them. */
export function tokenDeclarations(): { name: string; value: string }[] {
  const declarations: { name: string; value: string }[] = []
  for (const [key, value] of Object.entries({ ...COLORS, ...COLORS_EXTENDED, ...COLORS_ALPHA }))
    declarations.push({ name: cssVariableName('color', key), value })
  for (const [key, value] of Object.entries(SIZES))
    declarations.push({ name: cssVariableName('size', key), value: `${value}px` })
  for (const [key, value] of Object.entries(SPACING))
    declarations.push({ name: cssVariableName('space', key), value: `${value}px` })
  for (const [key, value] of Object.entries(FONT_SIZES))
    declarations.push({ name: cssVariableName('font', key), value: `${value}px` })
  for (const [key, value] of Object.entries(BREAKPOINTS))
    declarations.push({ name: cssVariableName('breakpoint', key), value: `${value}px` })
  return declarations
}

/* ------------------------------------------------------------------ contrast */

/** One channel of an sRGB colour, 0..255. */
const channels = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

/**
 * Relative luminance per WCAG 2.1, used only to compute contrast ratios.
 *
 * Implemented rather than pulled from a dependency because it is eight lines and the alternative is a runtime
 * dependency in the *token* module, which every other module reads.
 */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const scaled = channel / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1..21. Order-independent. */
export function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return (light + 0.05) / (dark + 0.05)
}

/** WCAG AA for body text. Asserted over the shipped pairs by `tokens.test.ts` (criterion 5). */
export const CONTRAST_AA = 4.5
/** WCAG AAA, the target the high-contrast theme has to reach in W9-04. */
export const CONTRAST_AAA = 7

/**
 * The text/background pairs the UI actually renders, so the contrast check measures real combinations rather than
 * every possible pairing.
 *
 * A pair listed here is a promise: this text appears on this surface. Adding a combination to the stylesheet
 * without adding it here is the gap the test cannot see, which is why the list is short and grouped by surface.
 */
export const TEXT_PAIRS: readonly { label: string; fg: string; bg: string }[] = [
  { label: 'body on background', fg: COLORS.text, bg: COLORS.bg },
  { label: 'body on surface', fg: COLORS.text, bg: COLORS.surface },
  { label: 'strong on raised surface', fg: COLORS.textStrong, bg: COLORS.surfaceRaised },
  { label: 'muted on raised surface', fg: COLORS.textMuted, bg: COLORS.surfaceRaised },
  { label: 'muted on background', fg: COLORS.textMuted, bg: COLORS.bg },
  { label: 'dim on background', fg: COLORS.textDim, bg: COLORS.bg },
  { label: 'accent on background', fg: COLORS.accent, bg: COLORS.bg },
  { label: 'accent on surface', fg: COLORS.accent, bg: COLORS.surface },
  { label: 'cool accent on accent surface', fg: COLORS.accentCool, bg: COLORS.surfaceAccent },
  { label: 'danger on raised surface', fg: COLORS.danger, bg: COLORS.surfaceRaised },
  { label: 'warning on raised surface', fg: COLORS.warning, bg: COLORS.surfaceRaised },
  { label: 'success on background', fg: COLORS.success, bg: COLORS.bg },
  { label: 'faint placeholder on raised surface', fg: COLORS.textFaint, bg: COLORS.surfaceRaised },
]

/**
 * The faint placeholder pair, held to AA like the rest.
 *
 * It was almost recorded as a known exception on the assumption that a deliberately quiet placeholder could not meet
 * body-text contrast. Measured, it reaches **5.49:1** — comfortably above AA — so the exception would have been an
 * excuse for a problem that does not exist. Listed here as a normal pair instead.
 */
export const FAINT_PAIR = { label: 'faint placeholder on raised surface', fg: COLORS.textFaint, bg: COLORS.surfaceRaised } as const
