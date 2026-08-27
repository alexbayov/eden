/**
 * W7-01 (technical half) — zone progression as state rather than as a content flag.
 *
 * **The defect this replaces.** `CampaignState.zone` is a *single* `ZoneProgress`, and whether a zone is playable
 * at all comes from `zone.unlocked` in `zones.json` — a static content boolean. So a second zone could only ever
 * be either permanently open from a new save or permanently invisible: a zone with `unlocked: false` is filtered
 * out of `playableMissions` before the campaign is even built, and nothing in the runtime can ever flip it. There
 * is no expressible state for "locked until the previous zone is cleared".
 *
 * This module supplies the missing piece: progress across *several* zones, with unlocking driven by completion.
 *
 * **What is deliberately not here.** How many zones there are and how many encounters each holds is decision
 * **D-03**, which the owner has not taken. `W7-01` criterion 4 depends on it and stays unmet. Everything below is
 * agnostic to those numbers — it works for the one shipped zone and for four — so the decision can land later
 * without reshaping the state.
 *
 * **Why `unlocked` in content stays.** It still means "this zone exists in this build", which is a different
 * question from "the player has reached it". Conflating the two is what produced the current dead end. A zone
 * absent from the build cannot be reached; a zone present but not yet earned is `locked` here.
 */
import type { MissionProgress } from './campaign'

/** Where the player stands with one zone. */
export type ZoneStatus = 'locked' | 'available' | 'completed'

export interface ZoneProgressEntry {
  id: string
  /** 1-based position in the campaign, from `zones.json`. */
  order: number
  status: ZoneStatus
}

/** A zone as the catalog declares it, reduced to what progression needs. */
export interface ZoneDescriptor {
  id: string
  order: number
  /** Whether the zone exists in this build at all. A false value keeps it out of progression entirely. */
  unlocked: boolean
}

/**
 * Builds the initial ladder: the first zone available, every later one locked.
 *
 * Ordered by `order` and **not** by array position, because the catalog is authored by hand and a mis-ordered
 * file would otherwise silently decide the campaign sequence. Zones absent from the build are dropped here rather
 * than carried as `locked`, so their absence is not mistaken for progress a player could make.
 */
export function createZoneLadder(zones: readonly ZoneDescriptor[]): ZoneProgressEntry[] {
  const present = zones.filter((zone) => zone.unlocked).sort((left, right) => left.order - right.order)
  return present.map((zone, index) => ({
    id: zone.id,
    order: zone.order,
    status: index === 0 ? 'available' : 'locked',
  }))
}

/** The zone the player is currently allowed to be in, or `null` when the campaign is finished. */
export const activeZone = (ladder: readonly ZoneProgressEntry[]): ZoneProgressEntry | null =>
  ladder.find((zone) => zone.status === 'available') ?? null

/** Whether a zone can be entered right now. */
export const isZonePlayable = (ladder: readonly ZoneProgressEntry[], zoneId: string): boolean =>
  ladder.some((zone) => zone.id === zoneId && zone.status === 'available')

/**
 * Marks a zone completed and opens the next one.
 *
 * Two rules that are easy to get wrong and are therefore structural here:
 *
 *   1. **Only the *next* zone by `order` opens**, never all remaining ones. Opening several would let a player skip
 *      a zone, which criterion 1 forbids («порядок нельзя обойти»).
 *   2. **Completing an already-completed zone changes nothing**, returning the same array by reference. Replaying a
 *      cleared zone must not re-open the one after it, or the ladder could be walked backwards to grant access.
 */
export function completeZone(ladder: readonly ZoneProgressEntry[], zoneId: string): ZoneProgressEntry[] {
  const target = ladder.find((zone) => zone.id === zoneId)
  if (!target || target.status !== 'available') return ladder as ZoneProgressEntry[]
  const ordered = [...ladder].sort((left, right) => left.order - right.order)
  const position = ordered.findIndex((zone) => zone.id === zoneId)
  const next = ordered[position + 1]
  return ladder.map((zone) => {
    if (zone.id === zoneId) return { ...zone, status: 'completed' as const }
    /* Only a locked successor is promoted: a zone the player already cleared must not reopen. */
    if (next && zone.id === next.id && zone.status === 'locked') return { ...zone, status: 'available' as const }
    return zone
  })
}

/** Whether every zone in the build has been cleared. */
export const isCampaignComplete = (ladder: readonly ZoneProgressEntry[]): boolean =>
  ladder.length > 0 && ladder.every((zone) => zone.status === 'completed')

/**
 * Whether the encounters of `zoneId` are all completed, i.e. the zone itself is finished.
 *
 * Read off encounter progress rather than tracked separately: a zone is done exactly when its missions are, and a
 * second counter would be a source of truth that can disagree with the first.
 */
export const zoneEncountersCleared = (
  encounters: readonly MissionProgress[],
  zoneMissionIds: readonly string[],
): boolean =>
  zoneMissionIds.length > 0 &&
  zoneMissionIds.every((id) => encounters.find((entry) => entry.id === id)?.status === 'completed')

export interface ZoneIssue {
  path: string
  message: string
}

/**
 * Validates the zone ladder as content (criterion 2).
 *
 * The gap this closes: `validateCampaignCatalog` already rejects a zone with no encounters and enforces sequential
 * `order` *within* a zone, but nothing checked the ordering *between* zones. A build with two zones both at
 * `order: 1`, or a jump from 1 to 3, would load — and `createZoneLadder` would then pick a first zone by sort
 * order, i.e. the campaign sequence would be decided by a tie-break rather than by the author.
 */
export function validateZoneLadder(zones: readonly ZoneDescriptor[]): ZoneIssue[] {
  const issues: ZoneIssue[] = []
  const present = zones.filter((zone) => zone.unlocked)
  if (!present.length) {
    issues.push({ path: 'zones', message: 'ни одна зона не помечена unlocked: кампания не может начаться' })
    return issues
  }
  const ordered = [...present].sort((left, right) => left.order - right.order)
  ordered.forEach((zone, index) => {
    if (zone.order !== index + 1)
      issues.push({
        path: `zones.${zone.id}.order`,
        message: `последовательный порядок зон с 1: ожидался ${index + 1}, объявлен ${zone.order}`,
      })
  })
  const seen = new Map<number, string>()
  for (const zone of present) {
    const clash = seen.get(zone.order)
    if (clash)
      issues.push({
        path: `zones.${zone.id}.order`,
        message: `дублирующийся порядок ${zone.order}: уже занят зоной ${clash}`,
      })
    else seen.set(zone.order, zone.id)
  }
  return issues
}

/** Whether a persisted ladder is structurally sound, for the save validator. */
export function isZoneLadder(value: unknown): value is ZoneProgressEntry[] {
  if (!Array.isArray(value) || value.length === 0) return false
  const statuses = new Set<ZoneStatus>(['locked', 'available', 'completed'])
  const orders = new Set<number>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return false
    const zone = entry as ZoneProgressEntry
    if (typeof zone.id !== 'string' || !zone.id) return false
    if (!Number.isInteger(zone.order) || zone.order < 1) return false
    if (!statuses.has(zone.status)) return false
    if (orders.has(zone.order)) return false
    orders.add(zone.order)
  }
  /*
   * At most one zone may be available. More than one would mean the player can enter two zones at once, which no
   * transition produces — `completeZone` promotes exactly one successor — so it is either tampering or a bug.
   */
  return value.filter((zone) => (zone as ZoneProgressEntry).status === 'available').length <= 1
}

/**
 * Whether the ladder's statuses form a reachable sequence.
 *
 * A hand-edited save could set the last zone `available` while the first is still `locked`, skipping the campaign.
 * Reachability means: completed zones form a prefix, then at most one available zone, then only locked ones.
 */
export function isZoneLadderReachable(ladder: readonly ZoneProgressEntry[]): boolean {
  const ordered = [...ladder].sort((left, right) => left.order - right.order)
  let seenNonCompleted = false
  let seenLocked = false
  for (const zone of ordered) {
    if (zone.status === 'completed') {
      /* A completed zone after a locked one is unreachable: it could not have been played. */
      if (seenNonCompleted) return false
      continue
    }
    seenNonCompleted = true
    if (zone.status === 'available') {
      /* An available zone after a locked one is the skip this check exists to refuse. */
      if (seenLocked) return false
      continue
    }
    seenLocked = true
  }
  return true
}
