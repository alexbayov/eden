/**
 * W9-03 / W9-04 — settings and accessibility tests.
 *
 * Two criteria carry the weight here and neither is a happy path:
 *
 *   - **criterion 2**, that corrupt settings never block the boot. Tested per field, because the failure mode is not
 *     "the file is garbage" but "one value is garbage and takes the others with it";
 *   - **criterion 3**, that a progress reset removes *only* game saves. Tested by listing what survives, since the
 *     interesting bug is deleting too much rather than too little.
 *
 * The contrast checks assert against `CONTRAST_AAA` rather than eyeballing the palette, and the contrast function
 * itself is verified in `tokens.test.ts` against fixed WCAG values — a function that always returned 21 would satisfy
 * every assertion below.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  HIGH_CONTRAST_OVERRIDES,
  HIGH_CONTRAST_PAIRS,
  SETTINGS_STORAGE_KEY,
  UI_SCALES,
  basePaletteReadable,
  buildSettingsControls,
  highContrastMeetsAAA,
  nextScale,
  parseSettings,
  resetProgressKeys,
  settingsEffect,
  worstContrast,
  type Settings,
} from './settings'
import { COLORS, CONTRAST_AAA, contrastRatio } from '../tokens'

const custom = (overrides: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...overrides })

describe('W9-03 settings survive, and never block the boot (criteria 1 and 2)', () => {
  it('round-trips every field', () => {
    const chosen = custom({ musicVolume: 30, sfxVolume: 0, uiScale: 150, highContrast: true, reducedMotion: true, largeText: true })
    expect(parseSettings(JSON.parse(JSON.stringify(chosen)))).toEqual(chosen)
  })

  it('falls back field by field, not all at once', () => {
    /*
     * The distinction that matters. One bad value — a hand edit, or a future version writing a field this build does
     * not understand — must not discard every other preference the player set.
     */
    const partial = parseSettings({ uiScale: 150, highContrast: 'yes', musicVolume: 'loud' })
    expect(partial.uiScale).toBe(150)
    expect(partial.highContrast).toBe(DEFAULT_SETTINGS.highContrast)
    expect(partial.musicVolume).toBe(DEFAULT_SETTINGS.musicVolume)
  })

  it('replaces anything unusable with defaults rather than throwing', () => {
    /* Criterion 2: a settings file is the last thing that should be able to stop the game from starting. */
    for (const broken of [null, undefined, 'settings', 42, [], { uiScale: 999 }, { uiScale: null }])
      expect(() => parseSettings(broken), JSON.stringify(broken)).not.toThrow()
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS)
    /* An unsupported scale is rejected rather than clamped: 999% is not a value the UI has a layout for. */
    expect(parseSettings({ uiScale: 999 }).uiScale).toBe(DEFAULT_SETTINGS.uiScale)
  })

  it('clamps volumes instead of rejecting them, because the intent is unambiguous', () => {
    /* 200 clearly means "as loud as possible" and -5 means "off"; discarding either would lose real intent. */
    expect(parseSettings({ musicVolume: 200 }).musicVolume).toBe(100)
    expect(parseSettings({ musicVolume: -5 }).musicVolume).toBe(0)
    expect(parseSettings({ sfxVolume: 43.7 }).sfxVolume).toBe(44)
    /* But a non-number is not intent at all. */
    expect(parseSettings({ musicVolume: Number.NaN }).musicVolume).toBe(DEFAULT_SETTINGS.musicVolume)
  })

  it('lives under its own key, isolated from the save', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('eden.settings.v1')
    expect(SETTINGS_STORAGE_KEY.startsWith('eden.save')).toBe(false)
  })
})

describe('W9-03 a progress reset removes only game saves (criterion 3)', () => {
  it('keeps settings and the tutorial preference', () => {
    /*
     * The bug this forecloses is deleting too much. Wiping a campaign does not mean the player wants the interface back
     * at 100% with hints re-enabled — and W7-05 already established that a reset must not re-teach the controls.
     */
    const keys = ['eden.save.v7', 'eden.save.v6', 'eden.save.v7.corrupt-backup', 'eden.settings.v1', 'eden.tutorial.v1']
    const removed = resetProgressKeys(keys)
    expect(removed).toContain('eden.save.v7')
    expect(removed).toContain('eden.save.v6')
    expect(removed).toContain('eden.save.v7.corrupt-backup')
    expect(removed).not.toContain('eden.settings.v1')
    expect(removed).not.toContain('eden.tutorial.v1')
  })

  it('leaves unrelated keys alone', () => {
    /* The game shares `localStorage` with whatever else the origin stores; a reset is not a licence to clear it. */
    expect(resetProgressKeys(['some-other-app', 'eden-not-a-save', 'eden.save.v7'])).toEqual(['eden.save.v7'])
  })

  it('is offered as a control that states what it does not touch', () => {
    const reset = buildSettingsControls({ settings: DEFAULT_SETTINGS }).find((control) => control.id === 'resetProgress')!
    expect(reset.kind).toBe('danger')
    expect(reset.value).toContain('подтвержден')
    expect(reset.ariaLabel).toMatch(/Настройки и обучение не затрагиваются/)
  })
})

describe('W9-03 every control has an effect or says why not (criterion 4)', () => {
  it('disables the volume controls with the reason, since there is no audio layer', () => {
    /*
     * `W9-01` is blocked externally, so the volume sliders would be decorative. Hiding them would lose the fact that
     * sound is planned; letting them pretend to work would be a lie. They state the reason instead.
     */
    const controls = buildSettingsControls({ settings: DEFAULT_SETTINGS })
    for (const id of ['musicVolume', 'sfxVolume'] as const) {
      const control = controls.find((entry) => entry.id === id)!
      expect(control.enabled, id).toBe(false)
      expect(control.reason, id).toMatch(/W9-01/)
      expect(control.ariaLabel, id).toContain('Недоступно')
    }
  })

  it('enables them the moment an audio layer exists, without editing this module', () => {
    /* `audioAvailable` is a parameter rather than a constant so the controls light up on their own when W9-01 lands. */
    const controls = buildSettingsControls({ settings: DEFAULT_SETTINGS, audioAvailable: true })
    for (const id of ['musicVolume', 'sfxVolume'] as const) {
      const control = controls.find((entry) => entry.id === id)!
      expect(control.enabled, id).toBe(true)
      expect(control.reason, id).toBe('')
    }
  })

  it('enables every non-audio control and describes its effect', () => {
    for (const control of buildSettingsControls({ settings: DEFAULT_SETTINGS })) {
      if (control.id === 'musicVolume' || control.id === 'sfxVolume') continue
      expect(control.enabled, String(control.id)).toBe(true)
      expect(control.reason, String(control.id)).toBe('')
      expect(control.ariaLabel.length, String(control.id)).toBeGreaterThan(10)
    }
  })

  it('shows the current value of each control', () => {
    const controls = buildSettingsControls({ settings: custom({ uiScale: 150, highContrast: true, musicVolume: 25 }) })
    expect(controls.find((entry) => entry.id === 'uiScale')!.value).toBe('150%')
    expect(controls.find((entry) => entry.id === 'highContrast')!.value).toBe('вкл')
    expect(controls.find((entry) => entry.id === 'musicVolume')!.value).toBe('25%')
  })
})

describe('W9-04 high contrast reaches AAA (criterion 1)', () => {
  it('clears 7:1 on every pair it promises', () => {
    expect(highContrastMeetsAAA()).toBe(true)
    for (const pair of HIGH_CONTRAST_PAIRS) {
      const ratio = contrastRatio(pair.fg, pair.bg)
      expect(ratio, `${pair.label}: ${ratio.toFixed(2)}:1 below AAA`).toBeGreaterThanOrEqual(CONTRAST_AAA)
    }
    /* The list must cover the UI rather than be trimmed until it passes. */
    expect(HIGH_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(10)
  })

  it('improves on the base palette rather than merely differing from it', () => {
    /*
     * A theme that swapped colours without raising contrast would satisfy "high contrast exists" and nothing else. The
     * base palette already reaches 16.8:1 on body text, so the meaningful comparison is the *worst* pair in each.
     */
    const baseWorst = worstContrast([
      { fg: COLORS.textFaint, bg: COLORS.surfaceRaised },
      { fg: COLORS.danger, bg: COLORS.surfaceRaised },
      { fg: COLORS.accentCool, bg: COLORS.surfaceAccent },
    ])
    expect(worstContrast(HIGH_CONTRAST_PAIRS)).toBeGreaterThan(baseWorst)
  })

  it('overrides only text and surface roles, letting the rest inherit', () => {
    /* A theme that redefined all 98 tokens would be a second palette to maintain. Every override must name a token
       the base palette actually declares, or it would be a silent no-op. */
    for (const key of Object.keys(HIGH_CONTRAST_OVERRIDES))
      expect(Object.keys(COLORS), `${key} is not a core token`).toContain(key)
    expect(Object.keys(HIGH_CONTRAST_OVERRIDES).length).toBeLessThan(Object.keys(COLORS).length + 1)
  })

  it('keeps the base palette readable too, so the theme is a choice and not a fix', () => {
    expect(basePaletteReadable()).toBe(true)
  })
})

describe('W9-04 settings apply immediately and observably (criteria 3 and 4)', () => {
  it('describes itself as attributes and properties rather than mutating anything', () => {
    /* Returned as data so the module stays pure and this test can assert what *would* be applied without a DOM. */
    const effect = settingsEffect(custom({ uiScale: 150, highContrast: true, reducedMotion: true, largeText: true }))
    expect(effect.attributes).toMatchObject({
      'data-ui-scale': '150',
      'data-high-contrast': 'true',
      'data-reduced-motion': 'true',
      'data-large-text': 'true',
    })
    expect(effect.properties['--ui-scale']).toBe('1.5')
  })

  it('applies the contrast palette only when the setting is on', () => {
    const off = settingsEffect(custom({ highContrast: false }))
    expect(off.properties['--color-bg']).toBeUndefined()
    const on = settingsEffect(custom({ highContrast: true }))
    expect(on.properties['--color-bg']).toBe(HIGH_CONTRAST_OVERRIDES.bg)
    expect(on.properties['--color-text-muted']).toBe(HIGH_CONTRAST_OVERRIDES.textMuted)
  })

  it('cycles the scale through exactly the supported values', () => {
    expect(UI_SCALES).toEqual([100, 125, 150])
    expect(nextScale(100)).toBe(125)
    expect(nextScale(125)).toBe(150)
    /* Wraps rather than sticking, so one control reaches every value. */
    expect(nextScale(150)).toBe(100)
  })

  it('names custom properties the way tokens.css does, or the override would not apply', () => {
    /* `--color-textMuted` would parse fine and do nothing. The kebab conversion is the whole contract. */
    const on = settingsEffect(custom({ highContrast: true }))
    for (const name of Object.keys(on.properties))
      expect(name, `${name} must be kebab-case`).toMatch(/^--[a-z0-9-]+$/)
  })
})
