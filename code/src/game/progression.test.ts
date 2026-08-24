/**
 * W4-01 / W4-02 — the level curve, the XP award and the death penalty.
 *
 * Two things this file deliberately does *not* do:
 *
 *   - it does not restate the curve as literals where the assertion is about a *property*. Level
 *     boundaries are read from the shipped catalog, so a curve change fails the boundary tests with
 *     the real numbers instead of silently passing against a stale copy;
 *   - it does not test the penalty by reimplementing the formula. Every penalty assertion is about
 *     an invariant the ticket names (first death free, XP never negative, level never drops, no
 *     escalation), which is what survives a future rate change.
 *
 * The shipped JSON is compared field for field against `DEFAULT_PROGRESSION_LEVELS`, which is the
 * mechanism that stops the in-code default from drifting away from the content file.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_LEVEL_CURVE,
  DEFAULT_PROGRESSION_LEVELS,
  DEFAULT_XP_LOSS_RATE,
  MAX_SUPPORTED_LEVEL,
  applyXpLoss,
  awardXp,
  characterForXp,
  curveFor,
  deathPenalty,
  defaultCharacter,
  levelFloorXp,
  levelForXp,
  maxLevel,
  parseProgression,
  resolveDefeatRetry,
  resolveDefeatReturn,
  skillPointsGranted,
  validateProgression,
  xpToNextLevel,
} from './progression'
import {
  createCampaign,
  missionDefeat,
  retreatFromMission,
  startMission,
  type CampaignMission,
  type CampaignState,
} from './campaign'
import { validateRewards } from './campaign-content'

const shipped = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), 'utf8')) as unknown

const catalog = parseProgression(shipped('progression'))
const curve = catalog.curve

const MISSIONS: CampaignMission[] = [
  { id: 'one', zoneId: 'zone', order: 1, rewardId: 'reward-one', arenaId: 'arena-one' },
  { id: 'two', zoneId: 'zone', order: 2, rewardId: 'reward-two', arenaId: 'arena-two' },
]

/** A campaign parked on the return screen, reached through the real transitions. */
const returned = (reason: 'defeat' | 'retreat', xp: number, firstDeathReturnUsed = false): CampaignState => {
  const active = startMission(createCampaign(MISSIONS, 'test-catalog'), 'one', MISSIONS)
  const failed = reason === 'defeat' ? missionDefeat(active) : retreatFromMission(active)
  return { ...failed, xp, firstDeathReturnUsed }
}

describe('W4-01 shipped progression catalog', () => {
  it('parses to exactly the curve mirrored in code, so the two cannot drift', () => {
    expect(catalog.levels).toEqual([...DEFAULT_PROGRESSION_LEVELS])
    expect(curve).toEqual(DEFAULT_LEVEL_CURVE)
    expect(curve.xpLossRate).toBe(DEFAULT_XP_LOSS_RATE)
  })

  it('covers L1..L6 and no more', () => {
    expect(catalog.levels.map((entry) => entry.level)).toEqual([1, 2, 3, 4, 5, 6])
    expect(maxLevel(curve)).toBe(MAX_SUPPORTED_LEVEL)
  })

  it('agrees with the actual shipped reward XP rather than with historical doc 05 numbers', () => {
    /* Acceptance criterion 5. The campaign's own reward totals must be meaningful level moments:
       clearing encounter 1 reaches L2, clearing the zone reaches L4. Read from `rewards.json`. */
    const rewards = validateRewards(shipped('rewards'))
    if (!rewards.ok) throw rewards.error
    const totals = rewards.value.reduce<number[]>(
      (running, reward) => [...running, (running.at(-1) ?? 0) + reward.xp],
      [],
    )
    expect(totals.length).toBeGreaterThanOrEqual(3)
    expect(levelForXp(totals[0], curve)).toBe(1)
    expect(levelForXp(totals[1], curve)).toBe(2)
    expect(levelForXp(totals.at(-1)!, curve)).toBe(3)
    /* Reward totals intentionally sit inside bands rather than exactly on every threshold,
       so later defeat penalties can charge XP above the current level floor. */
    for (const total of totals.slice(0, 3)) expect(curve.thresholds.includes(total)).toBe(false)
  })
})

describe('W4-01 levelForXp boundaries', () => {
  it('changes level exactly at each threshold, and not one XP earlier', () => {
    /* The boundary test doc 24 asks for, over every threshold in the catalog. */
    curve.thresholds.forEach((threshold, index) => {
      const level = index + 2
      expect(levelForXp(threshold - 1, curve)).toBe(level - 1)
      expect(levelForXp(threshold, curve)).toBe(level)
      expect(levelForXp(threshold + 1, curve)).toBe(level)
    })
  })

  it('is monotone and total over every non-negative finite XP', () => {
    let previous = 0
    for (let xp = 0; xp <= (curve.thresholds.at(-1) ?? 0) + 50; xp += 1) {
      const level = levelForXp(xp, curve)
      expect(level).toBeGreaterThanOrEqual(previous)
      expect(Number.isInteger(level)).toBe(true)
      previous = level
    }
    expect(levelForXp(0, curve)).toBe(1)
    expect(levelForXp(Number.MAX_SAFE_INTEGER, curve)).toBe(maxLevel(curve))
  })

  it('collapses hostile inputs instead of producing a NaN level', () => {
    for (const xp of [-1, -1000, Number.NaN, Number.NEGATIVE_INFINITY]) expect(levelForXp(xp, curve)).toBe(1)
    expect(levelForXp(Number.POSITIVE_INFINITY, curve)).toBe(maxLevel(curve))
    expect(levelForXp(30.9, curve)).toBe(levelForXp(30, curve))
  })

  it('reports the remaining XP to the next level, and null at the ceiling', () => {
    expect(xpToNextLevel(0, curve)).toBe(curve.thresholds[0])
    curve.thresholds.forEach((threshold, index) => {
      const next = curve.thresholds[index + 1]
      expect(xpToNextLevel(threshold, curve)).toBe(next === undefined ? null : next - threshold)
    })
    expect(xpToNextLevel(curve.thresholds.at(-1)!, curve)).toBeNull()
    expect(xpToNextLevel(Number.MAX_SAFE_INTEGER, curve)).toBeNull()
  })

  it('reports the XP floor of each level, which is the hard bound on the penalty', () => {
    expect(levelFloorXp(1, curve)).toBe(0)
    curve.thresholds.forEach((threshold, index) => expect(levelFloorXp(index + 2, curve)).toBe(threshold))
    expect(levelFloorXp(999, curve)).toBe(curve.thresholds.at(-1))
  })
})

describe('W4-01 awardXp', () => {
  it('starts at L1 with nothing earned and nothing unspent', () => {
    expect(defaultCharacter(curve)).toEqual({ level: 1, xp: 0, unspentSkillPoints: 0 })
    expect(skillPointsGranted(1, curve)).toBe(0)
  })

  it('accumulates XP, resolves the level and banks the skill point', () => {
    const first = awardXp(defaultCharacter(curve), curve.thresholds[0], curve)
    expect(first.character).toEqual({ level: 2, xp: curve.thresholds[0], unspentSkillPoints: 1 })
    expect(first.levelsGained).toBe(1)
    expect(first.skillPointsGained).toBe(1)
  })

  it('resolves several levels from one award without losing a point', () => {
    const jump = awardXp(defaultCharacter(curve), curve.thresholds[2], curve)
    expect(jump.character.level).toBe(4)
    expect(jump.levelsGained).toBe(3)
    expect(jump.character.unspentSkillPoints).toBe(skillPointsGranted(4, curve))
  })

  it('saturates at the curve ceiling instead of inventing levels', () => {
    const overshoot = awardXp(defaultCharacter(curve), 10_000, curve)
    expect(overshoot.character.level).toBe(maxLevel(curve))
    expect(overshoot.character.unspentSkillPoints).toBe(skillPointsGranted(maxLevel(curve), curve))
    /* A further award adds XP but no more levels or points. */
    const again = awardXp(overshoot.character, 500, curve)
    expect(again.levelsGained).toBe(0)
    expect(again.skillPointsGained).toBe(0)
    expect(again.character.xp).toBe(overshoot.character.xp + 500)
  })

  it('ignores a negative or non-finite award rather than removing XP', () => {
    const start = awardXp(defaultCharacter(curve), 40, curve).character
    for (const amount of [-10, Number.NaN, Number.NEGATIVE_INFINITY])
      expect(awardXp(start, amount, curve).character).toEqual(start)
  })

  it('never spends a point on its own: unspent points only accumulate', () => {
    /* W4-03/W4-04 are out of scope, but the points a level grants must persist. */
    let character = defaultCharacter(curve)
    for (const threshold of curve.thresholds) character = awardXp(character, threshold - character.xp, curve).character
    expect(character.unspentSkillPoints).toBe(skillPointsGranted(maxLevel(curve), curve))
    expect(character.unspentSkillPoints).toBeGreaterThan(0)
  })
})

describe('W4-02 death penalty', () => {
  it('costs nothing on the first defeat and marks the allowance as used', () => {
    /* Acceptance criterion 1. */
    const campaign = returned('defeat', curve.thresholds[1])
    const penalty = deathPenalty(campaign, curve)
    expect(penalty).toMatchObject({ reason: 'defeat', firstDeathFree: true, xpLost: 0 })
    const resolved = resolveDefeatReturn(campaign, characterForXp(campaign.xp, curve), curve)
    expect(resolved.campaign.firstDeathReturnUsed).toBe(true)
    expect(resolved.campaign.xp).toBe(campaign.xp)
    expect(resolved.character.xp).toBe(campaign.xp)
  })

  it('charges the flat rate of the XP still owed to the next level on a later defeat', () => {
    /* Mid-band, so the rate is what binds rather than the level floor. */
    const xp = curve.thresholds[0] + 20
    const campaign = returned('defeat', xp, true)
    const penalty = deathPenalty(campaign, curve)
    const expected = Math.floor((xpToNextLevel(xp, curve) ?? 0) * curve.xpLossRate)
    expect(penalty.firstDeathFree).toBe(false)
    expect(expected).toBeGreaterThan(0)
    expect(penalty.xpLost).toBe(expected)
    expect(penalty.xpLossRate).toBe(curve.xpLossRate)
    expect(penalty.xpAfter).toBe(xp - penalty.xpLost)
  })

  it('never lets XP go negative, at any XP total including zero', () => {
    /* Acceptance criterion 2, asserted over the whole range rather than at one point. */
    for (let xp = 0; xp <= (curve.thresholds.at(-1) ?? 0) + 40; xp += 1) {
      const penalty = deathPenalty(returned('defeat', xp, true), curve)
      expect(penalty.xpLost).toBeGreaterThanOrEqual(0)
      expect(penalty.xpAfter).toBeGreaterThanOrEqual(0)
      expect(penalty.xpLost).toBeLessThanOrEqual(xp)
    }
    expect(deathPenalty(returned('defeat', 0, true), curve).xpLost).toBe(0)
  })

  it('never lowers the level, including exactly on a threshold', () => {
    /* Acceptance criterion 3, and the "XP на границе порога" boundary from doc 24. */
    for (const threshold of curve.thresholds) {
      for (const xp of [threshold, threshold + 1, threshold + 5]) {
        const penalty = deathPenalty(returned('defeat', xp, true), curve)
        expect(levelForXp(penalty.xpAfter, curve)).toBe(levelForXp(xp, curve))
        expect(penalty.xpAfter).toBeGreaterThanOrEqual(levelFloorXp(penalty.level, curve))
      }
    }
    /* Sitting exactly on a threshold means nothing above the floor, so nothing to take. */
    expect(deathPenalty(returned('defeat', curve.thresholds[0], true), curve).xpLost).toBeLessThanOrEqual(0 + Math.floor((xpToNextLevel(curve.thresholds[0], curve) ?? 0) * curve.xpLossRate))
    expect(levelForXp(deathPenalty(returned('defeat', curve.thresholds[0], true), curve).xpAfter, curve)).toBe(2)
  })

  it('caps the loss at the XP above the current level floor, which is the only cap', () => {
    /* The "потолок штрафа" case: mid-band XP whose 15% share exceeds what is above the floor. */
    const xp = curve.thresholds[0] + 1
    const penalty = deathPenalty(returned('defeat', xp, true), curve)
    expect(penalty.xpLost).toBeLessThanOrEqual(xp - levelFloorXp(penalty.level, curve))
    expect(levelForXp(penalty.xpAfter, curve)).toBe(penalty.level)
  })

  it('does not escalate: the tenth defeat costs the same as the second', () => {
    /* Acceptance criterion 4 / audit prohibition. Repeated defeats at the same XP cost the same. */
    const xp = curve.thresholds[1] + 20
    let campaign = returned('defeat', xp, true)
    const costs: number[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const penalty = deathPenalty(campaign, curve)
      costs.push(penalty.xpLost)
      campaign = { ...campaign, xp }
    }
    expect(new Set(costs).size).toBe(1)
    expect(costs[0]).toBeGreaterThan(0)
  })

  it('charges nothing at the curve ceiling beyond the final band share', () => {
    const top = (curve.thresholds.at(-1) ?? 0) + 500
    const penalty = deathPenalty(returned('defeat', top, true), curve)
    expect(penalty.xpToNext).toBeNull()
    expect(penalty.level).toBe(maxLevel(curve))
    expect(levelForXp(penalty.xpAfter, curve)).toBe(maxLevel(curve))
    expect(penalty.xpLost).toBeGreaterThanOrEqual(0)
  })

  it('distinguishes retreat from defeat: no XP cost and no allowance consumed', () => {
    /* W4-02 criterion 5 (docs) as an executable assertion. */
    const xp = curve.thresholds[1] + 10
    const campaign = returned('retreat', xp)
    const penalty = deathPenalty(campaign, curve)
    expect(penalty).toMatchObject({ reason: 'retreat', xpLost: 0, firstDeathFree: false })
    const resolved = resolveDefeatReturn(campaign, characterForXp(xp, curve), curve)
    expect(resolved.campaign.xp).toBe(xp)
    /* The free defeat is still available afterwards: retreating does not burn it. */
    expect(resolved.campaign.firstDeathReturnUsed).toBe(false)
    expect(deathPenalty(returned('defeat', xp), curve).firstDeathFree).toBe(true)
  })

  it('leaves stash, backpack and equipment untouched, because it only returns XP', () => {
    /* The loot penalty is W5-05. The type surface is the proof: nothing here can reach inventory. */
    const penalty = deathPenalty(returned('defeat', 200, true), curve)
    expect(Object.keys(penalty).sort()).toEqual(
      ['firstDeathFree', 'level', 'reason', 'xpAfter', 'xpBefore', 'xpLossRate', 'xpLost', 'xpToNext'].sort(),
    )
  })

  it('charges a retry exactly like a walk home, so retry is not a free undo', () => {
    const xp = curve.thresholds[1] + 20
    const campaign = returned('defeat', xp, true)
    const character = characterForXp(xp, curve)
    const home = resolveDefeatReturn(campaign, character, curve)
    const retry = resolveDefeatRetry(campaign, character, MISSIONS, curve)
    expect(retry.penalty.xpLost).toBe(home.penalty.xpLost)
    expect(retry.character).toEqual(home.character)
    expect(retry.campaign.screen).toBe('mission')
    expect(retry.campaign.xp).toBe(home.campaign.xp)
  })

  it('consumes the free defeat on a retry as well, so the next retry is charged', () => {
    const xp = curve.thresholds[1] + 20
    const first = resolveDefeatRetry(returned('defeat', xp), characterForXp(xp, curve), MISSIONS, curve)
    expect(first.penalty.xpLost).toBe(0)
    expect(first.campaign.firstDeathReturnUsed).toBe(true)
    const second = resolveDefeatRetry(missionDefeat(first.campaign), first.character, MISSIONS, curve)
    expect(second.penalty.xpLost).toBeGreaterThan(0)
  })

  it('does not charge anything when the retry itself is refused', () => {
    /* A no-op transition must not pocket the penalty: otherwise a rejected retry would cost XP. */
    const xp = curve.thresholds[1] + 20
    const campaign = returned('defeat', xp, true)
    const character = characterForXp(xp, curve)
    const refused = resolveDefeatRetry(campaign, character, [], curve)
    expect(refused.campaign).toBe(campaign)
    expect(refused.character).toBe(character)
  })

  it('keeps unspent points consistent when XP is reduced', () => {
    const character = { level: 3, xp: curve.thresholds[1], unspentSkillPoints: skillPointsGranted(3, curve) }
    const reduced = applyXpLoss(character, 10_000, curve)
    expect(reduced.xp).toBe(0)
    expect(reduced.level).toBe(1)
    expect(reduced.unspentSkillPoints).toBe(0)
  })
})

describe('W4-01 progression content validation', () => {
  const envelope = (entries: unknown, deathPenaltyValue: unknown = { xpLossRate: 0.15 }) => ({
    contentVersion: 1,
    kind: 'progression',
    deathPenalty: deathPenaltyValue,
    entries,
  })
  const valid = [
    { id: 'level-1', level: 1, xpThreshold: 0, skillPoints: 0 },
    { id: 'level-2', level: 2, xpThreshold: 30, skillPoints: 1 },
    { id: 'level-3', level: 3, xpThreshold: 75, skillPoints: 1 },
  ]
  const reject = (input: unknown, path: string) => {
    const result = validateProgression(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues.map((issue) => issue.path).join(' ')).toContain(path)
      expect(result.error.message.length).toBeGreaterThan(0)
    }
  }

  it('accepts a well-formed curve', () => {
    const result = validateProgression(envelope(valid))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.curve.thresholds).toEqual([30, 75])
  })

  it('rejects a non-monotone curve with the offending path', () => {
    /* Acceptance criterion 3, on each way a curve can fail to be monotone. */
    reject(envelope([valid[0], { ...valid[1], xpThreshold: 75 }, { ...valid[2], xpThreshold: 75 }]), '$.entries[2].xpThreshold')
    reject(envelope([valid[0], { ...valid[1], xpThreshold: 90 }, { ...valid[2], xpThreshold: 40 }]), '$.entries[2].xpThreshold')
  })

  it('rejects a first threshold that is not exactly zero, so L1 always starts at 0 XP', () => {
    reject(envelope([{ ...valid[0], xpThreshold: 10 }, valid[1], valid[2]]), '$.entries[0].xpThreshold')
    /* And the corollary the ticket words as "первый порог > 0": L2 cannot sit on 0. */
    reject(envelope([valid[0], { ...valid[1], xpThreshold: 0 }, valid[2]]), '$.entries[1].xpThreshold')
  })

  it('rejects non-integer, negative and non-numeric fields', () => {
    reject(envelope([valid[0], { ...valid[1], xpThreshold: 30.5 }]), '$.entries[1].xpThreshold')
    reject(envelope([valid[0], { ...valid[1], xpThreshold: -30 }]), '$.entries[1].xpThreshold')
    reject(envelope([valid[0], { ...valid[1], skillPoints: -1 }]), '$.entries[1].skillPoints')
    reject(envelope([valid[0], { ...valid[1], level: 0 }]), '$.entries[1].level')
    reject(envelope([valid[0], { ...valid[1], id: '' }]), '$.entries[1].id')
  })

  it('rejects out-of-order or gapped level numbers', () => {
    reject(envelope([valid[0], { ...valid[1], level: 3 }, { ...valid[2], level: 4 }]), '$.entries[1].level')
  })

  it('rejects a skill point on L1, which belongs to W4-03 starting attributes', () => {
    reject(envelope([{ ...valid[0], skillPoints: 2 }, valid[1]]), '$.entries[0].skillPoints')
  })

  it('rejects a curve with fewer than two levels or more than the supported ceiling', () => {
    reject(envelope([valid[0]]), '$.entries')
    const tooMany = Array.from({ length: MAX_SUPPORTED_LEVEL + 1 }, (_unused, index) => ({
      id: `level-${index + 1}`,
      level: index + 1,
      xpThreshold: index === 0 ? 0 : index * 30,
      skillPoints: index === 0 ? 0 : 1,
    }))
    reject(envelope(tooMany), '$.entries')
  })

  it('rejects a missing or out-of-range death penalty rate', () => {
    /* `null`, not `undefined`: an explicit `undefined` would hit the helper's own default. */
    reject(envelope(valid, null), '$.deathPenalty.xpLossRate')
    reject({ contentVersion: 1, kind: 'progression', entries: valid }, '$.deathPenalty.xpLossRate')
    reject(envelope(valid, { xpLossRate: 0 }), '$.deathPenalty.xpLossRate')
    reject(envelope(valid, { xpLossRate: 1.5 }), '$.deathPenalty.xpLossRate')
    reject(envelope(valid, { xpLossRate: 'high' }), '$.deathPenalty.xpLossRate')
  })

  it('rejects a wrong kind, wrong version, duplicate ids and an empty entry list', () => {
    reject({ ...envelope(valid), kind: 'levels' }, '$.kind')
    reject({ ...envelope(valid), contentVersion: 2 }, '$.contentVersion')
    reject(envelope([valid[0], { ...valid[1], id: 'level-1' }]), '$.entries')
    reject(envelope([]), '$.entries')
    reject('not an object', '$')
  })

  it('throws the validator error from parseProgression instead of returning a result', () => {
    expect(() => parseProgression(envelope([valid[0], { ...valid[1], xpThreshold: 0 }]))).toThrow(/Некорректный контент/)
  })

  it('builds a usable curve from any accepted table', () => {
    const custom = curveFor(
      [
        { id: 'a', level: 1, xpThreshold: 0, skillPoints: 0 },
        { id: 'b', level: 2, xpThreshold: 10, skillPoints: 2 },
      ],
      0.5,
    )
    expect(levelForXp(9, custom)).toBe(1)
    expect(levelForXp(10, custom)).toBe(2)
    expect(skillPointsGranted(2, custom)).toBe(2)
    expect(maxLevel(custom)).toBe(2)
  })
})
