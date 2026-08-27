/**
 * W9-03 / W9-04 — settings and accessibility options, as one pure module.
 *
 * The two tickets are implemented together because the high-contrast theme is a *token* palette selected by a
 * *setting*: splitting them would mean writing the settings model twice, once with a placeholder for the theme and
 * once for real.
 *
 * **Why settings live outside the save.** `eden.settings.v1`, never in `SaveData`. Same reasoning as the tutorial
 * preference in W7-05, and the ticket states it as a data contract: settings are preferences, not campaign state.
 * They have no catalog references, no cross-field invariants, and they must survive a progress reset — resetting a
 * campaign does not mean the player wants the interface back at 100% with the contrast theme off.
 *
 * **Corrupt settings must never block the game** (criterion 2). Every read falls back to defaults field by field
 * rather than wholesale, so one bad value does not discard the others. A settings file is the last thing that should
 * be able to stop a boot.
 *
 * **Sound is present but disabled, with the reason stated** (criterion 4). There is no audio layer — `W9-01` is
 * blocked externally — so the volume controls would be decorative. Rather than hide them or let them pretend to
 * work, they render with an explicit reason. A control that silently does nothing is worse than one that says why.
 */
import { COLORS, CONTRAST_AAA, contrastRatio } from '../tokens'

/** Interface scale, as the accessibility ticket enumerates it. */
export const UI_SCALES = [100, 125, 150] as const
export type UiScale = (typeof UI_SCALES)[number]

export interface Settings {
  /** 0..100. Stored and applied once an audio layer exists; inert today. */
  musicVolume: number
  sfxVolume: number
  /** Interface scale in percent. */
  uiScale: UiScale
  /** High-contrast theme, which swaps the token palette. */
  highContrast: boolean
  /**
   * Motion off as an explicit choice.
   *
   * Separate from the `prefers-reduced-motion` media query rather than a duplicate of it: the query says what the
   * *system* prefers, and a player may want motion off in this game only, or on despite a system-wide setting.
   */
  reducedMotion: boolean
  /** Larger base font, independent of `uiScale` so text can grow without enlarging every control. */
  largeText: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  musicVolume: 70,
  sfxVolume: 80,
  uiScale: 100,
  highContrast: false,
  reducedMotion: false,
  largeText: false,
}

/** Storage key. Deliberately not `eden.save.*`, so a progress reset cannot touch it. */
export const SETTINGS_STORAGE_KEY = 'eden.settings.v1'

const clampVolume = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null

const asScale = (value: unknown): UiScale | null =>
  UI_SCALES.includes(value as UiScale) ? (value as UiScale) : null

const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

/**
 * Parses stored settings, falling back **field by field** (criterion 2).
 *
 * Per-field rather than all-or-nothing on purpose: a single bad value — from a hand edit, or from a future version
 * writing a field this build does not understand — would otherwise discard every other preference the player set.
 * Out-of-range volumes are clamped rather than rejected, because the intent is unambiguous.
 */
export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTINGS }
  const raw = value as Record<string, unknown>
  return {
    musicVolume: clampVolume(raw.musicVolume) ?? DEFAULT_SETTINGS.musicVolume,
    sfxVolume: clampVolume(raw.sfxVolume) ?? DEFAULT_SETTINGS.sfxVolume,
    uiScale: asScale(raw.uiScale) ?? DEFAULT_SETTINGS.uiScale,
    highContrast: asBoolean(raw.highContrast) ?? DEFAULT_SETTINGS.highContrast,
    reducedMotion: asBoolean(raw.reducedMotion) ?? DEFAULT_SETTINGS.reducedMotion,
    largeText: asBoolean(raw.largeText) ?? DEFAULT_SETTINGS.largeText,
  }
}

/* ------------------------------------------------------------------ high contrast theme */

/**
 * The high-contrast palette (W9-04 criterion 1: ≥ 7:1 for body text).
 *
 * Only the values that carry text or separate surfaces are overridden — the rest of the 98 tokens inherit. Built by
 * pushing surfaces to near-black and text to near-white, because the base palette already reaches 16:1 on body text
 * and its weak points are the *dim* variants and coloured status text, not the primary pairs.
 *
 * Verified by `settings.test.ts` against `CONTRAST_AAA`, so a shade that looks bold but measures 6.8:1 fails.
 */
export const HIGH_CONTRAST_OVERRIDES: Readonly<Record<string, string>> = {
  bg: '#000000',
  surface: '#050505',
  surfaceRaised: '#0a0a0a',
  surfaceAccent: '#0d1418',
  text: '#ffffff',
  textStrong: '#ffffff',
  textMuted: '#e8f2f3',
  textDim: '#dbe8ec',
  textFaint: '#c3d3d9',
  accent: '#ffe9a3',
  accentCool: '#9ae8ff',
  accentCoolDim: '#9ae8ff',
  accentWarm: '#ffd0a0',
  danger: '#ffb3a8',
  warning: '#ffd0b0',
  success: '#a8f0c4',
  border: '#8aa2aa',
  borderDim: '#8aa2aa',
  borderMuted: '#9fb4bb',
}

/** Text/background pairs the high-contrast theme has to clear at AAA. */
export const HIGH_CONTRAST_PAIRS: readonly { label: string; fg: string; bg: string }[] = [
  { label: 'body on background', fg: HIGH_CONTRAST_OVERRIDES.text, bg: HIGH_CONTRAST_OVERRIDES.bg },
  { label: 'body on surface', fg: HIGH_CONTRAST_OVERRIDES.text, bg: HIGH_CONTRAST_OVERRIDES.surface },
  { label: 'muted on raised surface', fg: HIGH_CONTRAST_OVERRIDES.textMuted, bg: HIGH_CONTRAST_OVERRIDES.surfaceRaised },
  { label: 'dim on background', fg: HIGH_CONTRAST_OVERRIDES.textDim, bg: HIGH_CONTRAST_OVERRIDES.bg },
  { label: 'faint on raised surface', fg: HIGH_CONTRAST_OVERRIDES.textFaint, bg: HIGH_CONTRAST_OVERRIDES.surfaceRaised },
  { label: 'accent on background', fg: HIGH_CONTRAST_OVERRIDES.accent, bg: HIGH_CONTRAST_OVERRIDES.bg },
  { label: 'cool accent on accent surface', fg: HIGH_CONTRAST_OVERRIDES.accentCool, bg: HIGH_CONTRAST_OVERRIDES.surfaceAccent },
  { label: 'danger on raised surface', fg: HIGH_CONTRAST_OVERRIDES.danger, bg: HIGH_CONTRAST_OVERRIDES.surfaceRaised },
  { label: 'warning on raised surface', fg: HIGH_CONTRAST_OVERRIDES.warning, bg: HIGH_CONTRAST_OVERRIDES.surfaceRaised },
  { label: 'success on background', fg: HIGH_CONTRAST_OVERRIDES.success, bg: HIGH_CONTRAST_OVERRIDES.bg },
]

/** The worst contrast ratio in a pair list, for reporting rather than for assertion. */
export const worstContrast = (pairs: readonly { fg: string; bg: string }[]): number =>
  pairs.reduce((worst, pair) => Math.min(worst, contrastRatio(pair.fg, pair.bg)), Number.POSITIVE_INFINITY)

/** Whether the high-contrast palette meets AAA everywhere it promises to. */
export const highContrastMeetsAAA = (): boolean => worstContrast(HIGH_CONTRAST_PAIRS) >= CONTRAST_AAA

/* ------------------------------------------------------------------ applying settings */

/**
 * The attributes and custom properties the shell writes to `<html>`.
 *
 * Returned as data rather than applied here so the module stays pure and the test can assert what *would* be applied
 * without a DOM. `applySettings` in the shell is then a loop with no decisions in it.
 */
export interface SettingsEffect {
  /** `data-*` attributes, for CSS to select on. */
  attributes: Record<string, string>
  /** Custom properties overridden on the root element. */
  properties: Record<string, string>
}

const cssVar = (key: string) => `--color-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`

export function settingsEffect(settings: Settings): SettingsEffect {
  const attributes: Record<string, string> = {
    'data-ui-scale': String(settings.uiScale),
    'data-high-contrast': String(settings.highContrast),
    'data-reduced-motion': String(settings.reducedMotion),
    'data-large-text': String(settings.largeText),
  }
  const properties: Record<string, string> = {
    /* Scale drives a single root property; every size token is expressed in terms of it by `tokens.css`. */
    '--ui-scale': `${settings.uiScale / 100}`,
  }
  if (settings.highContrast)
    for (const [key, value] of Object.entries(HIGH_CONTRAST_OVERRIDES)) properties[cssVar(key)] = value
  return { attributes, properties }
}

/* ------------------------------------------------------------------ view model */

export type SettingsControlKind = 'volume' | 'scale' | 'toggle' | 'danger'

export interface SettingsControl {
  id: keyof Settings | 'resetProgress'
  kind: SettingsControlKind
  label: string
  /** Current value as the control renders it. */
  value: string
  /** False when the control cannot do anything yet. */
  enabled: boolean
  /** Why it is disabled, in the player's terms. Empty when enabled (criterion 4). */
  reason: string
  ariaLabel: string
}

/**
 * Whether an audio layer exists.
 *
 * A parameter rather than a constant so the volume controls light up on their own the moment `W9-01` lands, without
 * anyone remembering to edit this file. Defaults to `false`, which is the truth today.
 */
export interface SettingsViewInput {
  settings: Settings
  audioAvailable?: boolean
}

export function buildSettingsControls(input: SettingsViewInput): SettingsControl[] {
  const { settings, audioAvailable = false } = input
  const audioReason = 'Звук ещё не реализован (W9-01): значение сохраняется и применится, когда аудио появится.'
  const volume = (id: 'musicVolume' | 'sfxVolume', label: string): SettingsControl => ({
    id,
    kind: 'volume',
    label,
    value: `${settings[id]}%`,
    enabled: audioAvailable,
    reason: audioAvailable ? '' : audioReason,
    ariaLabel: `${label}: ${settings[id]}%.${audioAvailable ? '' : ` Недоступно: ${audioReason}`}`,
  })
  const toggle = (id: 'highContrast' | 'reducedMotion' | 'largeText', label: string, effect: string): SettingsControl => ({
    id,
    kind: 'toggle',
    label,
    value: settings[id] ? 'вкл' : 'выкл',
    enabled: true,
    reason: '',
    ariaLabel: `${label}: ${settings[id] ? 'включено' : 'выключено'}. ${effect}`,
  })
  return [
    volume('musicVolume', 'Музыка'),
    volume('sfxVolume', 'Звуки'),
    {
      id: 'uiScale',
      kind: 'scale',
      label: 'Масштаб интерфейса',
      value: `${settings.uiScale}%`,
      enabled: true,
      reason: '',
      ariaLabel: `Масштаб интерфейса: ${settings.uiScale}%. Применяется сразу.`,
    },
    toggle('highContrast', 'Высокий контраст', 'Повышает контраст текста и границ.'),
    toggle('reducedMotion', 'Меньше движения', 'Отключает анимации, не убирая информацию.'),
    toggle('largeText', 'Крупный текст', 'Увеличивает базовый размер шрифта.'),
    {
      id: 'resetProgress',
      kind: 'danger',
      label: 'Сбросить прогресс',
      value: 'требует подтверждения',
      enabled: true,
      reason: '',
      ariaLabel:
        'Сбросить прогресс кампании. Требует подтверждения. Настройки и обучение не затрагиваются.',
    },
  ]
}

/** The next scale in the cycle, so one control steps through the three values. */
export const nextScale = (scale: UiScale): UiScale => UI_SCALES[(UI_SCALES.indexOf(scale) + 1) % UI_SCALES.length]

/**
 * Storage keys a progress reset may remove (criterion 3).
 *
 * Only game saves. Settings and the tutorial preference are excluded **by construction** rather than by the caller
 * remembering: wiping a campaign does not mean the player wants the interface back at 100% with hints re-enabled, and
 * W7-05 already established that resetting progress must not re-teach the controls.
 */
export const resetProgressKeys = (allKeys: readonly string[]): string[] =>
  allKeys.filter((key) => key.startsWith('eden.save'))

/** Sanity check for the base palette, so the settings module fails loudly if the tokens regress. */
export const basePaletteReadable = (): boolean => contrastRatio(COLORS.text, COLORS.bg) >= CONTRAST_AAA
