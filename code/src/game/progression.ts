/**
 * W4-01 / W4-02 — the single source of truth for character progression.
 *
 * Everything about levels, XP and the death penalty lives here and nowhere else:
 *
 *   - the level curve is **content** (`public/config/progression.json`, kind `progression`),
 *     validated by `validateProgression` before anything reads it;
 *   - `levelForXp` / `xpToNextLevel` / `awardXp` are pure and total over any finite XP;
 *   - `deathPenalty` is the *only* implementation of the penalty formula. The shell renders what
 *     this function returns and never recomputes a number from it (W4-02 acceptance criterion 4).
 *
 * Why the curve is duplicated as `DEFAULT_PROGRESSION_LEVELS` in code. The browser fetches the
 * catalog at runtime, so the pure functions need a default for callers that have no catalog in
 * hand (`defaultSave`, save validation with a test catalog, the balance simulator's fixtures).
 * The duplication is not left to drift: `progression.test.ts` asserts the shipped JSON parses to
 * exactly this table, so editing one without the other fails `npm run verify`. That is the same
 * device already used for the E2E storage-key literals and for `sim/bounds.ts`.
 *
 * Curve rationale (W4-01 acceptance criterion 5 — the curve must agree with the *actual* rewards,
 * not with the historical numbers in doc 05). The shipped rewards are 30 / 45 / 60 XP, so the
 * level bands continue that arithmetic series (+15 per band):
 *
 *   | level | cumulative XP | reached by                                |
 *   |-------|--------------:|-------------------------------------------|
 *   | L1    |             0 | campaign start                            |
 *   | L2    |            40 | 10 XP after the first encounter            |
 *   | L3    |            90 | 15 XP after the shipped zone                |
 *   | L4    |           155 | +65 XP, beyond shipped content              |
 *   | L5    |           235 | +80 XP, beyond shipped content              |
 *   | L6    |           330 | +95 XP, MVP ceiling                         |
 *
 * Levels above L6 are out of scope for W4-01 and are rejected by the validator rather than
 * silently accepted, so content cannot quietly leave the tested range.
 *
 * SPECIAL, skills and perks (W4-03/W4-04) are **not** implemented. A level still grants a skill
 * point, and that point persists, because losing already-earned points when the spending UI
 * arrives would be a save-compatibility problem rather than a feature gap.
 */
import {
  firstDeathReturn,
  retryMission,
  type CampaignMission,
  type CampaignState,
  type ReturnReason,
} from './campaign'
import {
  ContentValidationError,
  checkEntries,
  checkEnvelope,
  checkUniqueIds,
  isInt,
  isNonEmptyString,
  isRecord,
  fetchContent,
  type ContentIssue,
  type ContentResult,
} from './content-format'

/** One row of the shipped level table. `xpThreshold` is cumulative XP, not XP-to-next. */
export interface ProgressionLevel {
  id: string
  level: number
  xpThreshold: number
  /** Skill points granted on *reaching* this level. L1 grants none: starting points are W4-03. */
  skillPoints: number
}

/**
 * The curve in the shape the pure functions consume: `thresholds[i]` is the cumulative XP needed
 * for level `i + 2`, so `thresholds[0] > 0` and the array is strictly increasing. Level 1 has no
 * threshold by construction, which is what keeps `levelForXp(0) === 1` true for every valid curve.
 */
export interface LevelCurve {
  readonly thresholds: readonly number[]
  /** `skillPoints[i]` is granted on reaching level `i + 2`; parallel to `thresholds`. */
  readonly skillPoints: readonly number[]
  /** Share of the XP remaining to the next level lost on a non-free defeat. */
  readonly xpLossRate: number
}

export interface ProgressionCatalog {
  levels: ProgressionLevel[]
  curve: LevelCurve
}

/** Persisted progression state (save v5 `$.character`). */
export interface CharacterState {
  level: number
  xp: number
  /** Earned and not yet spent. Nothing spends them until W4-03; they still persist. */
  unspentSkillPoints: number
}

/** Highest level W4-01 supports. Content declaring more is rejected, not truncated. */
export const MAX_SUPPORTED_LEVEL = 6

export const DEFAULT_XP_LOSS_RATE = 0.15

export const DEFAULT_PROGRESSION_LEVELS: readonly ProgressionLevel[] = [
  { id: 'level-1', level: 1, xpThreshold: 0, skillPoints: 0 },
  { id: 'level-2', level: 2, xpThreshold: 40, skillPoints: 1 },
  { id: 'level-3', level: 3, xpThreshold: 90, skillPoints: 1 },
  { id: 'level-4', level: 4, xpThreshold: 155, skillPoints: 1 },
  { id: 'level-5', level: 5, xpThreshold: 235, skillPoints: 1 },
  { id: 'level-6', level: 6, xpThreshold: 330, skillPoints: 1 },
] as const

/** Builds the consumable curve from a level table. Assumes the table already validated. */
export const curveFor = (levels: readonly ProgressionLevel[], xpLossRate: number): LevelCurve => ({
  thresholds: levels.slice(1).map((entry) => entry.xpThreshold),
  skillPoints: levels.slice(1).map((entry) => entry.skillPoints),
  xpLossRate,
})

export const DEFAULT_PROGRESSION: ProgressionCatalog = {
  levels: DEFAULT_PROGRESSION_LEVELS.map((entry) => ({ ...entry })),
  curve: curveFor(DEFAULT_PROGRESSION_LEVELS, DEFAULT_XP_LOSS_RATE),
}

export const DEFAULT_LEVEL_CURVE: LevelCurve = DEFAULT_PROGRESSION.curve

/**
 * Total over every input, which is what makes `levelForXp` total as well: a corrupt `NaN` collapses
 * to 0 rather than producing a `NaN` level, and `Infinity` saturates at the top of the curve.
 */
const normalizeXp = (xp: number): number => {
  if (typeof xp !== 'number' || Number.isNaN(xp)) return 0
  if (xp === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.floor(xp))
}

export const maxLevel = (curve: LevelCurve = DEFAULT_LEVEL_CURVE): number => curve.thresholds.length + 1

/** Monotone in `xp` and defined for every finite non-negative value (criterion 2). */
export function levelForXp(xp: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  const value = normalizeXp(xp)
  let level = 1
  for (const threshold of curve.thresholds) {
    if (value < threshold) break
    level += 1
  }
  return level
}

/** XP still required for the next level, or `null` at the top of the curve. */
export function xpToNextLevel(xp: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number | null {
  const value = normalizeXp(xp)
  const next = curve.thresholds[levelForXp(value, curve) - 1]
  return next === undefined ? null : Math.max(0, next - value)
}

/** Cumulative XP at which `level` begins. The floor a death penalty may never cross. */
export function levelFloorXp(level: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  if (!Number.isFinite(level) || level <= 1) return 0
  const index = Math.min(Math.floor(level), maxLevel(curve)) - 2
  return curve.thresholds[index] ?? 0
}

/** Skill points granted by every level up to and including `level`. */
export function skillPointsGranted(level: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  const capped = Math.min(Math.max(1, Math.floor(level)), maxLevel(curve))
  return curve.skillPoints.slice(0, capped - 1).reduce((sum, points) => sum + points, 0)
}

/** The state a fresh or migrated character has at `xp`: nothing spent yet. */
export function characterForXp(xp: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): CharacterState {
  const value = normalizeXp(xp)
  const level = levelForXp(value, curve)
  return { level, xp: value, unspentSkillPoints: skillPointsGranted(level, curve) }
}

export const defaultCharacter = (curve: LevelCurve = DEFAULT_LEVEL_CURVE): CharacterState =>
  characterForXp(0, curve)

export interface XpAward {
  character: CharacterState
  levelsGained: number
  skillPointsGained: number
}

/** Adds XP and resolves every level gained by it in one step. Negative awards are ignored. */
export function awardXp(
  character: CharacterState,
  amount: number,
  curve: LevelCurve = DEFAULT_LEVEL_CURVE,
): XpAward {
  const gain = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
  const xp = normalizeXp(character.xp) + gain
  const level = levelForXp(xp, curve)
  const previousLevel = Math.min(Math.max(1, Math.floor(character.level)), maxLevel(curve))
  const skillPointsGained = Math.max(0, skillPointsGranted(level, curve) - skillPointsGranted(previousLevel, curve))
  return {
    character: {
      level,
      xp,
      unspentSkillPoints: Math.max(0, Math.floor(character.unspentSkillPoints)) + skillPointsGained,
    },
    levelsGained: Math.max(0, level - previousLevel),
    skillPointsGained,
  }
}

export interface DeathPenalty {
  /** Which return produced this penalty. `retreat` never costs XP. */
  reason: ReturnReason
  /** Always `>= 0`, and never enough to cross `levelFloorXp`. */
  xpLost: number
  /** True when this defeat is the free one; it costs nothing and consumes the allowance. */
  firstDeathFree: boolean
  level: number
  xpBefore: number
  xpAfter: number
  /** XP that was still missing for the next level, or `null` at the curve's top. */
  xpToNext: number | null
  /** The percentage the formula applied, surfaced so no screen re-derives it. */
  xpLossRate: number
}

/**
 * The one death-penalty formula (W4-02, conservative variant of doc 05 §5.3.4).
 *
 *   xpLost = 0                                                if retreat, or if this is the first defeat
 *   xpLost = min(floor(0.15 × XP_to_next), xp − levelFloorXp)  otherwise
 *
 * Three properties hold by construction rather than by a caller remembering to clamp:
 *
 *   - **the first defeat is free** (`firstDeathReturnUsed === false`), and only a defeat consumes
 *     the allowance — retreating does not;
 *   - **XP never goes negative**, because the loss is bounded by the XP above the current level's
 *     floor, which is itself bounded by `xp`;
 *   - **the level never drops**, for the same reason. The loss is `min(max(1, floor(basis × rate)),
 *     affordable)` when affordable XP exists; exact level floors remain free;
 *   - the current shipped curve uses a final-band fallback, so the maximum raw loss is
 *     `floor(95 × 0.15) = 14` at the curve ceiling.
 *
 * There is **no escalation** for repeated deaths: the rate is flat, and nothing in the formula
 * reads a death counter. Resources, stash, backpack and equipment are untouched — that is W5-05.
 */
export function deathPenalty(state: CampaignState, curve: LevelCurve = DEFAULT_LEVEL_CURVE): DeathPenalty {
  const xpBefore = normalizeXp(state.xp)
  const level = levelForXp(xpBefore, curve)
  const xpToNext = xpToNextLevel(xpBefore, curve)
  /* At the top of the curve there is no "XP to next", so the final band's width is the basis. */
  const basis = xpToNext ?? finalBandWidth(curve)
  const isDefeat = state.returnReason === 'defeat'
  const firstDeathFree = isDefeat && !state.firstDeathReturnUsed
  const affordable = Math.max(0, xpBefore - levelFloorXp(level, curve)
  )
  const rawLoss = Math.floor(basis * curve.xpLossRate)
  const xpLost = isDefeat && !firstDeathFree && affordable > 0
    ? Math.min(Math.max(1, rawLoss), affordable)
    : 0
  return {
    reason: state.returnReason,
    xpLost,
    firstDeathFree,
    level,
    xpBefore,
    xpAfter: xpBefore - xpLost,
    xpToNext,
    xpLossRate: curve.xpLossRate,
  }
}

const finalBandWidth = (curve: LevelCurve): number => {
  const { thresholds } = curve
  if (thresholds.length === 0) return 0
  if (thresholds.length === 1) return thresholds[0]
  return thresholds[thresholds.length - 1] - thresholds[thresholds.length - 2]
}

/** Reduces XP by an already-clamped loss and recomputes the level. Never drops below L1 or 0 XP. */
export function applyXpLoss(
  character: CharacterState,
  xpLost: number,
  curve: LevelCurve = DEFAULT_LEVEL_CURVE,
): CharacterState {
  const xp = Math.max(0, normalizeXp(character.xp) - Math.max(0, Math.floor(xpLost)))
  const level = levelForXp(xp, curve)
  return {
    level,
    xp,
    /* Defensive: the formula cannot drop a level, so this clamp is a no-op today. */
    unspentSkillPoints: Math.min(
      Math.max(0, Math.floor(character.unspentSkillPoints)),
      skillPointsGranted(level, curve),
    ),
  }
}

export interface DefeatResolution {
  campaign: CampaignState
  character: CharacterState
  penalty: DeathPenalty
}

const applyPenalty = (
  campaign: CampaignState,
  character: CharacterState,
  penalty: DeathPenalty,
  curve: LevelCurve,
): { campaign: CampaignState; character: CharacterState } => {
  const next = applyXpLoss({ ...character, xp: normalizeXp(campaign.xp), level: penalty.level }, penalty.xpLost, curve)
  return { campaign: { ...campaign, xp: next.xp }, character: next }
}

/**
 * Leaving the return screen for the base. The penalty is charged here rather than at the moment of
 * defeat so the player is shown the exact cost before confirming (W4-02 scope: "отображение штрафа
 * игроку до подтверждения возврата"); `deathPenalty` is what the screen renders, and this applies
 * that same object.
 */
export function resolveDefeatReturn(
  campaign: CampaignState,
  character: CharacterState,
  curve: LevelCurve = DEFAULT_LEVEL_CURVE,
): DefeatResolution {
  const penalty = deathPenalty(campaign, curve)
  const applied = applyPenalty(campaign, character, penalty, curve)
  return { campaign: firstDeathReturn(applied.campaign), character: applied.character, penalty }
}

/**
 * Retrying straight from the return screen. Charged identically: a defeat costs the same whether
 * the player walks home or re-enters immediately, otherwise "retry" would be a free undo.
 */
export function resolveDefeatRetry(
  campaign: CampaignState,
  character: CharacterState,
  missions: readonly CampaignMission[],
  curve: LevelCurve = DEFAULT_LEVEL_CURVE,
): DefeatResolution {
  const penalty = deathPenalty(campaign, curve)
  const applied = applyPenalty(campaign, character, penalty, curve)
  const retried = retryMission(applied.campaign, missions)
  /*
   * A refused retry must not silently pocket the penalty. Refusal is detected by the screen, not by
   * object identity: `retryMission` rebuilds the state before handing it to `startMission`, so a
   * rejected retry still returns a *different* object that never left the return screen.
   */
  if (retried.screen !== 'mission') return { campaign, character, penalty }
  const consumed = penalty.firstDeathFree ? { ...retried, firstDeathReturnUsed: true } : retried
  return { campaign: consumed, character: applied.character, penalty }
}

/* ------------------------------------------------------------------ content validation */

const checkLevel = (value: unknown, path: string, issues: ContentIssue[]): ProgressionLevel | null => {
  if (!isRecord(value)) {
    issues.push({ path, message: 'объект уровня' })
    return null
  }
  const before = issues.length
  if (!isNonEmptyString(value.id)) issues.push({ path: `${path}.id`, message: 'непустая строка' })
  if (!isInt(value.level) || value.level < 1) issues.push({ path: `${path}.level`, message: 'целое >= 1' })
  if (!isInt(value.xpThreshold) || value.xpThreshold < 0)
    issues.push({ path: `${path}.xpThreshold`, message: 'неотрицательное целое' })
  if (!isInt(value.skillPoints) || value.skillPoints < 0)
    issues.push({ path: `${path}.skillPoints`, message: 'неотрицательное целое' })
  return issues.length === before ? (value as unknown as ProgressionLevel) : null
}

/**
 * Rejects a curve that the pure functions could not be monotone over, with the path and the reason
 * (W4-01 acceptance criterion 3). Enforced: sequential levels from 1, `xpThreshold` of L1 exactly
 * 0, strictly increasing integer thresholds afterwards (so the first real threshold is > 0), no
 * skill point on L1, at least two levels, no level above `MAX_SUPPORTED_LEVEL`, and a loss rate in
 * `(0, 1]`.
 */
export function validateProgression(input: unknown): ContentResult<ProgressionCatalog> {
  const envelope = checkEnvelope(input)
  if (!envelope.ok) return envelope
  const value = envelope.value
  const issues: ContentIssue[] = []
  const entries = checkEntries(value, 'progression', issues)
  const levels: ProgressionLevel[] = []
  entries.forEach((entry, index) => {
    const checked = checkLevel(entry, `$.entries[${index}]`, issues)
    if (checked) levels.push(checked)
  })
  if (issues.length === 0) checkUniqueIds(levels, issues)

  const rate = isRecord(value.deathPenalty) ? value.deathPenalty.xpLossRate : undefined
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1)
    issues.push({ path: '$.deathPenalty.xpLossRate', message: 'число в диапазоне (0, 1]' })

  if (issues.length === 0) {
    if (levels.length < 2) issues.push({ path: '$.entries', message: 'минимум два уровня' })
    if (levels.length > MAX_SUPPORTED_LEVEL)
      issues.push({ path: '$.entries', message: `не более ${MAX_SUPPORTED_LEVEL} уровней (вне scope W4-01)` })
    levels.forEach((entry, index) => {
      if (entry.level !== index + 1)
        issues.push({ path: `$.entries[${index}].level`, message: 'последовательные уровни начиная с 1' })
      if (index === 0) {
        if (entry.xpThreshold !== 0) issues.push({ path: `$.entries[${index}].xpThreshold`, message: 'ровно 0 для L1' })
        if (entry.skillPoints !== 0)
          issues.push({ path: `$.entries[${index}].skillPoints`, message: 'ровно 0 для L1 (очки старта — W4-03)' })
      } else if (entry.xpThreshold <= levels[index - 1].xpThreshold) {
        issues.push({
          path: `$.entries[${index}].xpThreshold`,
          message: 'строго возрастающий порог (первый порог > 0)',
        })
      }
    })
  }

  return issues.length
    ? { ok: false, error: new ContentValidationError('shape', issues) }
    : { ok: true, value: { levels, curve: curveFor(levels, rate as number) } }
}

export function parseProgression(input: unknown): ProgressionCatalog {
  const result = validateProgression(input)
  if (!result.ok) throw result.error
  return result.value
}

export const loadProgression = async (url = '/config/progression.json'): Promise<ProgressionCatalog> =>
  parseProgression(await fetchContent(url))
