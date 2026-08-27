/**
 * W7-01 (technical half) — zone progression tests.
 *
 * The criterion that shapes this file is 1: «прохождение зоны открывает следующую; **порядок нельзя обойти**». A
 * happy-path test proves the first half and nothing about the second, so most of what follows tries to *skip* a
 * zone — by replaying a cleared one, by hand-editing the ladder, by declaring a broken order in content — and
 * asserts each route is closed.
 *
 * Criterion 4 («число encounter соответствует утверждённой длительности из D-03») is **not** covered and cannot be:
 * the decision has not been taken. Everything here is agnostic to how many zones or encounters exist, so the
 * decision can land later without reshaping this.
 */
import { describe, expect, it } from 'vitest'
import {
  activeZone,
  completeZone,
  createZoneLadder,
  isCampaignComplete,
  isZoneLadder,
  isZoneLadderReachable,
  isZonePlayable,
  validateZoneLadder,
  zoneEncountersCleared,
  type ZoneDescriptor,
  type ZoneProgressEntry,
} from './zone-progress'
import {
  claimReward,
  createCampaign,
  missionVictory,
  startMission,
  type CampaignMission,
  type MissionProgress,
} from './campaign'

const zone = (id: string, order: number, unlocked = true): ZoneDescriptor => ({ id, order, unlocked })
const FOUR: ZoneDescriptor[] = [zone('z1', 1), zone('z2', 2), zone('z3', 3), zone('z4', 4)]

const progress = (id: string, status: MissionProgress['status']): MissionProgress => ({
  id,
  status,
  victories: status === 'completed' ? 1 : 0,
  firstRewardClaimed: status === 'completed',
  mapId: id,
  arenaId: id,
  rewardId: `${id}-clear`,
})

describe('W7-01 the ladder starts with exactly one zone open', () => {
  it('opens the first zone by order and locks the rest', () => {
    const ladder = createZoneLadder(FOUR)
    expect(ladder.map((entry) => entry.status)).toEqual(['available', 'locked', 'locked', 'locked'])
    expect(activeZone(ladder)?.id).toBe('z1')
  })

  it('orders by the declared order, not by array position', () => {
    /* The catalog is authored by hand, so a mis-ordered file must not silently decide the campaign sequence. */
    const shuffled = [zone('z3', 3), zone('z1', 1), zone('z4', 4), zone('z2', 2)]
    const ladder = createZoneLadder(shuffled)
    expect(ladder.map((entry) => entry.id)).toEqual(['z1', 'z2', 'z3', 'z4'])
    expect(activeZone(ladder)?.id).toBe('z1')
  })

  it('drops zones absent from the build rather than locking them', () => {
    /*
     * `unlocked` in content means "this zone exists in this build", which is a different question from "the player
     * has reached it" — conflating the two is what produced the dead end this module replaces. A zone that is not in
     * the build must not appear as progress a player could make.
     */
    const ladder = createZoneLadder([zone('z1', 1), zone('z2', 2, false), zone('z3', 3)])
    expect(ladder.map((entry) => entry.id)).toEqual(['z1', 'z3'])
    expect(ladder.map((entry) => entry.status)).toEqual(['available', 'locked'])
  })
})

describe('W7-01 clearing a zone opens exactly the next one (criterion 1)', () => {
  it('promotes one successor, never all of them', () => {
    /* Opening several would let a player skip a zone, which is the half of criterion 1 a happy path cannot check. */
    const after = completeZone(createZoneLadder(FOUR), 'z1')
    expect(after.map((entry) => entry.status)).toEqual(['completed', 'available', 'locked', 'locked'])
    expect(activeZone(after)?.id).toBe('z2')
  })

  it('walks the whole campaign one zone at a time', () => {
    let ladder = createZoneLadder(FOUR)
    for (const id of ['z1', 'z2', 'z3']) {
      ladder = completeZone(ladder, id)
      expect(isCampaignComplete(ladder), `after ${id}`).toBe(false)
    }
    ladder = completeZone(ladder, 'z4')
    expect(isCampaignComplete(ladder)).toBe(true)
    expect(activeZone(ladder)).toBeNull()
  })

  it('refuses to complete a locked zone, which is the skip route', () => {
    /* The direct attempt: clearing the last zone from a fresh save. Nothing changes, by reference. */
    const ladder = createZoneLadder(FOUR)
    expect(completeZone(ladder, 'z4')).toBe(ladder)
    expect(completeZone(ladder, 'nonexistent')).toBe(ladder)
  })

  it('does not reopen the next zone when a cleared zone is replayed', () => {
    /*
     * The subtler route. A player can replay a completed encounter, so `missionVictory` can fire again for a zone
     * already done — and if that promoted the successor each time, the ladder could be walked forward without
     * playing. Asserted by reference: nothing at all changes.
     */
    const once = completeZone(createZoneLadder(FOUR), 'z1')
    const twice = completeZone(once, 'z1')
    expect(twice).toBe(once)
    /* And with the successor already cleared, replaying its predecessor must not demote or reopen anything. */
    const deeper = completeZone(once, 'z2')
    expect(completeZone(deeper, 'z1')).toBe(deeper)
    expect(deeper.find((entry) => entry.id === 'z2')?.status).toBe('completed')
  })

  it('reports only the current zone as playable', () => {
    const ladder = completeZone(createZoneLadder(FOUR), 'z1')
    expect(isZonePlayable(ladder, 'z2')).toBe(true)
    /* Neither a finished zone nor a future one may be entered. */
    expect(isZonePlayable(ladder, 'z1')).toBe(false)
    expect(isZonePlayable(ladder, 'z3')).toBe(false)
  })
})

describe('W7-01 zone completion is read off the encounters', () => {
  it('is complete only when every encounter of the zone is', () => {
    /* Read from encounter progress rather than tracked separately: a second counter could disagree with the first. */
    const encounters = [progress('m1', 'completed'), progress('m2', 'completed'), progress('m3', 'available')]
    expect(zoneEncountersCleared(encounters, ['m1', 'm2'])).toBe(true)
    expect(zoneEncountersCleared(encounters, ['m1', 'm2', 'm3'])).toBe(false)
    /* A failed encounter is not a cleared one. */
    expect(zoneEncountersCleared([progress('m1', 'failed')], ['m1'])).toBe(false)
  })

  it('never reports an empty zone as cleared', () => {
    /* Otherwise a zone with no encounters would complete instantly and unlock the next one for free. The catalog
       validator already refuses such a zone, so this is the second line of defence. */
    expect(zoneEncountersCleared([progress('m1', 'completed')], [])).toBe(false)
  })
})

describe('W7-01 content ordering is validated (criterion 2)', () => {
  it('accepts a well-formed ladder', () => {
    expect(validateZoneLadder(FOUR)).toEqual([])
  })

  it('rejects a gap in the zone order', () => {
    /*
     * The gap `validateCampaignCatalog` did not close: it enforces sequential `order` *within* a zone but nothing
     * checked the ordering *between* zones. A jump from 1 to 3 would load, and `createZoneLadder` would then pick a
     * first zone by sort order — the campaign sequence decided by a tie-break rather than by the author.
     */
    const issues = validateZoneLadder([zone('z1', 1), zone('z3', 3)])
    expect(issues.map((issue) => issue.path)).toContain('zones.z3.order')
    expect(issues[0].message).toMatch(/ожидался 2/)
  })

  it('rejects two zones claiming the same position', () => {
    const issues = validateZoneLadder([zone('z1', 1), zone('z2', 1)])
    expect(issues.some((issue) => issue.message.includes('дублирующийся'))).toBe(true)
  })

  it('rejects a build with no playable zone at all', () => {
    const issues = validateZoneLadder([zone('z1', 1, false)])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/ни одна зона/)
  })

  it('ignores zones outside the build when checking the order', () => {
    /* A build shipping zones 1 and 3 with 2 disabled is well-formed: the disabled one is not content the player can
       reach, so it must not be read as a gap. */
    expect(validateZoneLadder([zone('z1', 1), zone('z2', 2, false)])).toEqual([])
  })
})

describe('W7-01 a persisted ladder cannot be edited into a skip', () => {
  const ladder = (statuses: ZoneProgressEntry['status'][]) =>
    statuses.map((status, index) => ({ id: `z${index + 1}`, order: index + 1, status }))

  it('accepts a reachable sequence', () => {
    for (const statuses of [
      ['available', 'locked', 'locked'],
      ['completed', 'available', 'locked'],
      ['completed', 'completed', 'available'],
      ['completed', 'completed', 'completed'],
    ] as ZoneProgressEntry['status'][][]) {
      const entry = ladder(statuses)
      expect(isZoneLadder(entry), statuses.join(',')).toBe(true)
      expect(isZoneLadderReachable(entry), statuses.join(',')).toBe(true)
    }
  })

  it('refuses an available zone behind a locked one', () => {
    /* The hand-edit that skips the campaign: open the last zone while the first is untouched. */
    expect(isZoneLadderReachable(ladder(['locked', 'locked', 'available']))).toBe(false)
    expect(isZoneLadderReachable(ladder(['available', 'locked', 'available']))).toBe(false)
  })

  it('refuses a completed zone after an unfinished one', () => {
    /* Unreachable: that zone could not have been played. */
    expect(isZoneLadderReachable(ladder(['available', 'completed', 'locked']))).toBe(false)
    expect(isZoneLadderReachable(ladder(['locked', 'completed', 'locked']))).toBe(false)
  })

  it('refuses two zones open at once, a state no transition produces', () => {
    /* `completeZone` promotes exactly one successor, so two available zones is either tampering or a bug. */
    expect(isZoneLadder(ladder(['available', 'available', 'locked']))).toBe(false)
  })

  it('refuses a malformed ladder rather than reading past it', () => {
    expect(isZoneLadder([])).toBe(false)
    expect(isZoneLadder(null)).toBe(false)
    expect(isZoneLadder([{ id: '', order: 1, status: 'available' }])).toBe(false)
    expect(isZoneLadder([{ id: 'z1', order: 0, status: 'available' }])).toBe(false)
    expect(isZoneLadder([{ id: 'z1', order: 1.5, status: 'available' }])).toBe(false)
    expect(isZoneLadder([{ id: 'z1', order: 1, status: 'open' }])).toBe(false)
    /* Duplicate positions would make "the next zone" ambiguous. */
    expect(
      isZoneLadder([
        { id: 'z1', order: 1, status: 'completed' },
        { id: 'z2', order: 1, status: 'available' },
      ]),
    ).toBe(false)
  })
})

describe('W7-01 the campaign transition closes a zone at its own boundary', () => {
  /*
   * Numbered the way shippable content has to be: `order` restarts at 1 in every zone, and `zoneOrder` carries the
   * zone's position. The earlier version of this fixture numbered zone two's encounter `order: 3`, i.e. it continued
   * a single global sequence — which `validateCampaignCatalog` rejects ("последовательный порядок внутри зоны с 1").
   * So this test passed while describing a catalog that could not ship, and it hid the fact that the campaign
   * sequenced zones by `order` alone. With real numbering that sort interleaves the zones.
   */
  const MISSIONS: CampaignMission[] = [
    { id: 'a1', zoneId: 'z1', zoneOrder: 1, order: 1, rewardId: 'r1', arenaId: 'm' },
    { id: 'a2', zoneId: 'z1', zoneOrder: 1, order: 2, rewardId: 'r2', arenaId: 'm' },
    { id: 'b1', zoneId: 'z2', zoneOrder: 2, order: 1, rewardId: 'r3', arenaId: 'm' },
  ]
  const win = (state: ReturnType<typeof createCampaign>, id: string) => {
    const started = startMission(state, id, MISSIONS)
    expect(started.activeMissionId, `${id} must be startable`).toBe(id)
    const won = missionVictory(started, MISSIONS)
    return claimReward(won, MISSIONS.find((mission) => mission.id === id)!.rewardId, 10, MISSIONS)
  }

  it('closes zone one after its own last encounter, not the campaign’s', () => {
    /*
     * The defect this pins. The first version only closed a zone at the end of the whole mission list, so with two
     * zones the first stayed `available` through its entire run and closed only after the *last* encounter of zone
     * two — the ladder advanced one zone too late and zone two was never shown as open. Found by walking two zones
     * end to end rather than by reading the code.
     */
    let campaign = createCampaign(MISSIONS, 'test-catalog')
    expect(campaign.zones.map((entry) => entry.status)).toEqual(['available', 'locked'])

    campaign = win(campaign, 'a1')
    /* Mid-zone: nothing about the ladder moves. */
    expect(campaign.zone.id).toBe('z1')
    expect(campaign.zones.map((entry) => entry.status)).toEqual(['available', 'locked'])

    campaign = win(campaign, 'a2')
    /* Zone boundary: zone one completed, zone two open, and `zone` follows the ladder. */
    expect(campaign.zones.map((entry) => entry.status)).toEqual(['completed', 'available'])
    expect(campaign.zone).toEqual({ id: 'z2', status: 'available' })

    campaign = win(campaign, 'b1')
    expect(isCampaignComplete(campaign.zones)).toBe(true)
    expect(campaign.zone.status).toBe('completed')
  })

  it('keeps a single-zone campaign behaving exactly as before', () => {
    /* The shipped zone is one of one, so this is the regression guard for existing content. */
    const single: CampaignMission[] = [
      { id: 'm1', zoneId: 'only', order: 1, rewardId: 'r1', arenaId: 'm' },
      { id: 'm2', zoneId: 'only', order: 2, rewardId: 'r2', arenaId: 'm' },
    ]
    let campaign = createCampaign(single, 'test-catalog')
    campaign = claimReward(
      missionVictory(startMission(campaign, 'm1', single), single),
      'r1',
      10,
      single,
    )
    expect(campaign.zone.status).toBe('available')
    campaign = claimReward(
      missionVictory(startMission(campaign, 'm2', single), single),
      'r2',
      10,
      single,
    )
    expect(campaign.zone.status).toBe('completed')
    expect(isCampaignComplete(campaign.zones)).toBe(true)
  })

  it('sequences zone by zone instead of interleaving them (D-03 defect)', () => {
    /*
     * The defect that made a second zone unshippable, pinned directly.
     *
     * Because `validateCampaignCatalog` requires every zone to number its encounters from 1, mission `order`
     * repeats across zones — so ordering the campaign by `order` alone produced `z1-1, z2-1, z1-2, z2-2, …`. The
     * consequence was not cosmetic: `missionVictory` opens the *next* mission in that sequence, so clearing the
     * first encounter of zone one unlocked the first encounter of zone two, and the zone ladder was bypassable
     * through the encounter list. This is asserted as a whole sequence rather than a spot check because the bug was
     * an ordering, not a single wrong status.
     */
    const twoZones: CampaignMission[] = [
      { id: 'z1-1', zoneId: 'z1', zoneOrder: 1, order: 1, rewardId: 'r11', arenaId: 'm' },
      { id: 'z1-2', zoneId: 'z1', zoneOrder: 1, order: 2, rewardId: 'r12', arenaId: 'm' },
      { id: 'z2-1', zoneId: 'z2', zoneOrder: 2, order: 1, rewardId: 'r21', arenaId: 'm' },
      { id: 'z2-2', zoneId: 'z2', zoneOrder: 2, order: 2, rewardId: 'r22', arenaId: 'm' },
    ]
    expect(createCampaign(twoZones, 'test-catalog').encounters.map((entry) => entry.id)).toEqual([
      'z1-1',
      'z1-2',
      'z2-1',
      'z2-2',
    ])
    /* The sequence is a property of the data, not of how the file happened to be written. */
    const authoredOutOfOrder = [twoZones[2], twoZones[0], twoZones[3], twoZones[1]]
    expect(createCampaign(authoredOutOfOrder, 'test-catalog').encounters.map((entry) => entry.id)).toEqual([
      'z1-1',
      'z1-2',
      'z2-1',
      'z2-2',
    ])
    /* Zone two's opener stays locked until zone one is finished, which is what the interleaving broke. */
    const opened = missionVictory(startMission(createCampaign(twoZones, 'test-catalog'), 'z1-1', twoZones), twoZones)
    expect(opened.encounters.find((entry) => entry.id === 'z2-1')?.status).toBe('locked')
    expect(opened.encounters.find((entry) => entry.id === 'z1-2')?.status).toBe('available')
  })

  it('refuses a multi-zone catalog with no zone positions rather than guessing one', () => {
    /* Every available default is wrong: array order is an authoring accident and `order` repeats per zone. A
       campaign whose unlock order came from a sort tie-break is exactly the failure this replaces. */
    const missingZoneOrder: CampaignMission[] = [
      { id: 'a', zoneId: 'z1', order: 1, rewardId: 'r1', arenaId: 'm' },
      { id: 'b', zoneId: 'z2', order: 1, rewardId: 'r2', arenaId: 'm' },
    ]
    expect(() => createCampaign(missingZoneOrder, 'test-catalog')).toThrow(/zoneOrder/)
    /* A single-zone catalog still needs none, so existing content and fixtures are untouched. */
    expect(() =>
      createCampaign([{ id: 'a', zoneId: 'only', order: 1, rewardId: 'r1', arenaId: 'm' }], 'test-catalog'),
    ).not.toThrow()
  })
})
