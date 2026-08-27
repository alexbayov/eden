/**
 * W7-02 — playability checks for authored maps.
 *
 * The runtime already validates map *shape* (`validateArenaContent`) and cross-file *references*
 * (`validateCampaignCatalog`). Neither asks the question a content author actually gets wrong: **can this map
 * be played?** A grid can be perfectly well-formed and still ship an enemy walled off behind full cover, a
 * hero with nowhere to go, or two heroes.
 *
 * Every check here is derived from the shipped rules rather than reimplemented:
 *
 *   - reachability uses `findReachable`, the same breadth-first walk the game uses for movement, with the same
 *     blocker set (`full` cover plus living units);
 *   - line of sight uses `hasLineOfSight`, the same supercover trace the combat resolver uses.
 *
 * That is deliberate and load-bearing. A second implementation of "can the hero get there" would drift from
 * the one the game runs, and a validator that disagrees with the game is worse than no validator: it either
 * blocks valid content or passes content the player cannot finish.
 *
 * **What is a warning and what is an error.** An unreachable enemy is an *error* only under
 * `--strict-playability`, because `eliminate` genuinely cannot be completed while it stands there, but a
 * `secure` or `escape` map may legitimately contain an enemy the hero never has to touch. A map with no cover
 * is always a warning and never an error: it is playable, merely poor. Getting this split wrong is how a
 * validator becomes something authors route around.
 */
import {
  cellKey,
  findReachable,
  hasLineOfSight,
  isAlive,
  type Point,
  type Unit,
} from './combat'
import type { ArenaContent } from './content'
import type { ObjectiveParams } from './objective'

/** Severity of a finding. Only `error` fails a run. */
export type PlayabilityLevel = 'error' | 'warning'

export interface PlayabilityIssue {
  /** Stable id, usable as a waiver key and as a test assertion. */
  id: string
  level: PlayabilityLevel
  /** `arenaId` the finding belongs to. */
  arenaId: string
  message: string
}

/** AP a mission starts with, so reachability is measured over a realistic walk rather than the whole map. */
export const AUTHORING_REACH_AP = 10

/**
 * How many turns of walking the reachability check allows.
 *
 * Reachability over a single turn's AP would reject perfectly ordinary maps — the shipped arenas are 7–8 cells
 * wide and a hero has 10 AP, so a far corner takes two moves. Ten turns is deliberately generous: the check
 * exists to catch cells that are *walled off*, not cells that are far away, and a wall does not become passable
 * with more AP.
 */
export const AUTHORING_REACH_TURNS = 10

const blockedCells = (arena: ArenaContent, ignore: readonly string[]): Set<string> =>
  new Set([
    ...arena.cover.filter((entry) => entry.type === 'full').map((entry) => cellKey(entry.x, entry.y)),
    ...arena.units
      .filter((unit) => isAlive(unit as Unit) && !ignore.includes(unit.id))
      .map((unit) => cellKey(unit.x, unit.y)),
  ])

/**
 * Cells the hero can walk to, given several turns of movement.
 *
 * `findReachable` is the game's own walk, so a cell it cannot reach is a cell the player cannot reach.
 */
export function heroReachableCells(arena: ArenaContent): Set<string> {
  const hero = arena.units.find((unit) => unit.id === 'hero')
  if (!hero) return new Set()
  const blocked = blockedCells(arena, ['hero'])
  const reach = findReachable(
    hero,
    AUTHORING_REACH_AP * AUTHORING_REACH_TURNS,
    arena.width,
    arena.height,
    blocked,
  )
  return new Set(reach.costs.keys())
}

/**
 * Whether the hero can ever get a shot at `target`.
 *
 * Answered as "is there any reachable cell with a firing line", not "is there a line from the start" — an enemy
 * behind cover is normal design, an enemy that cannot be shot from anywhere the hero can stand is not.
 */
export function canEngage(arena: ArenaContent, target: Point): boolean {
  const reachable = heroReachableCells(arena)
  const blocked = blockedCells(arena, ['hero'])
  for (const key of reachable) {
    const [x, y] = key.split(',').map(Number)
    /* The target's own cell never blocks the line to itself. */
    const lineBlockers = new Set(blocked)
    lineBlockers.delete(cellKey(target.x, target.y))
    if (hasLineOfSight({ x, y }, target, lineBlockers)) return true
  }
  return false
}

export interface PlayabilityInput {
  arena: ArenaContent
  /** The objective this map is played under, when the caller knows it. */
  objective?: ObjectiveParams
  /** Whether unreachable enemies and objective cells are errors rather than warnings. */
  strict?: boolean
}

/**
 * Every playability finding for one map.
 *
 * Ordered from structural to situational, so the first message an author reads is the most fundamental thing
 * wrong rather than whichever check happened to run first.
 */
export function checkPlayability(input: PlayabilityInput): PlayabilityIssue[] {
  const { arena, objective, strict = false } = input
  const issues: PlayabilityIssue[] = []
  const at = (id: string, level: PlayabilityLevel, message: string) =>
    issues.push({ id, level, arenaId: arena.id, message })
  const objectiveLevel: PlayabilityLevel = strict ? 'error' : 'warning'

  // ---- structure ---------------------------------------------------------------------------
  const heroes = arena.units.filter((unit) => unit.id === 'hero' || unit.team === 'player')
  if (heroes.length !== 1)
    at(
      'hero-count',
      'error',
      `ожидается ровно один юнит игрока, найдено ${heroes.length}: ${heroes.map((unit) => unit.id).join(', ') || '—'}`,
    )
  const hero = arena.units.find((unit) => unit.id === 'hero')
  if (!hero) at('hero-missing', 'error', 'нет юнита с id "hero": карта не может начаться')

  const outside = arena.units.filter(
    (unit) => unit.x < 0 || unit.y < 0 || unit.x >= arena.width || unit.y >= arena.height,
  )
  for (const unit of outside)
    at(
      'unit-out-of-bounds',
      'error',
      `юнит ${unit.id} стоит в (${unit.x}, ${unit.y}) вне сетки ${arena.width}×${arena.height}`,
    )

  const coverOutside = arena.cover.filter(
    (entry) => entry.x < 0 || entry.y < 0 || entry.x >= arena.width || entry.y >= arena.height,
  )
  for (const entry of coverOutside)
    at('cover-out-of-bounds', 'error', `укрытие в (${entry.x}, ${entry.y}) вне сетки`)

  /* Two units on one cell is not expressible in play: `blockingCells` would treat the pair as one blocker and
     movement onto an occupied cell is refused. */
  const cells = new Map<string, string[]>()
  for (const unit of arena.units) {
    const key = cellKey(unit.x, unit.y)
    cells.set(key, [...(cells.get(key) ?? []), unit.id])
  }
  for (const [key, ids] of cells)
    if (ids.length > 1) at('units-overlap', 'error', `юниты ${ids.join(', ')} стоят на одной клетке ${key}`)

  /* A unit standing on full cover is walled in by the game's own blocker rules. */
  const fullCover = new Set(
    arena.cover.filter((entry) => entry.type === 'full').map((entry) => cellKey(entry.x, entry.y)),
  )
  for (const unit of arena.units)
    if (fullCover.has(cellKey(unit.x, unit.y)))
      at('unit-inside-cover', 'error', `юнит ${unit.id} стоит внутри полного укрытия (${unit.x}, ${unit.y})`)

  if (!hero || heroes.length !== 1) return issues

  // ---- movement ----------------------------------------------------------------------------
  const reachable = heroReachableCells(arena)
  /* One reachable cell means the hero can only stand still — the map is a cell, not an arena. */
  if (reachable.size <= 1)
    at('hero-immobile', 'error', 'герою некуда двигаться: все соседние клетки заблокированы')

  /*
   * Isolated regions. Counted over *walkable* cells rather than all cells, so decorative full cover does not
   * read as an island. A pocket the hero can never enter is content the player will never see, which is at best
   * wasted authoring and at worst a hidden objective cell.
   *
   * Cells occupied by a living unit are excluded, and that is the whole subtlety: `findReachable` treats other
   * units as blockers, so an enemy's own tile is never "reachable" while it stands there — but it is not walled
   * off either, it is simply occupied, and it frees up the moment the enemy dies or moves. Counting those cells
   * reported every shipped map as having an isolated region, which is how this was found.
   */
  const occupied = new Set(
    arena.units.filter((unit) => isAlive(unit as Unit)).map((unit) => cellKey(unit.x, unit.y)),
  )
  const walkable: string[] = []
  for (let y = 0; y < arena.height; y += 1)
    for (let x = 0; x < arena.width; x += 1) {
      const key = cellKey(x, y)
      if (!fullCover.has(key) && !occupied.has(key)) walkable.push(key)
    }
  const unreachableWalkable = walkable.filter((key) => !reachable.has(key))
  if (unreachableWalkable.length)
    at(
      'isolated-region',
      strict ? 'error' : 'warning',
      `${unreachableWalkable.length} проходимых клеток недостижимы для героя: ${unreachableWalkable
        .slice(0, 6)
        .join(' ')}${unreachableWalkable.length > 6 ? ' …' : ''}`,
    )

  // ---- engagement --------------------------------------------------------------------------
  const enemies = arena.units.filter((unit) => unit.team === 'enemy')
  if (!enemies.length && (!objective || objective.kind === 'eliminate'))
    at('no-enemies', 'error', 'нет противников: цель eliminate не может быть выполнена')

  for (const enemy of enemies)
    if (!canEngage(arena, enemy))
      at(
        'enemy-unengageable',
        objectiveLevel,
        `по ${enemy.id} в (${enemy.x}, ${enemy.y}) нельзя выстрелить ни с одной достижимой клетки`,
      )

  // ---- objective geometry ------------------------------------------------------------------
  if (objective)
    for (const [label, cell] of objectiveCellsOf(objective))
      if (!reachable.has(cellKey(cell.x, cell.y)))
        at(
          'objective-unreachable',
          objectiveLevel,
          `клетка цели ${label} (${cell.x}, ${cell.y}) недостижима для героя`,
        )

  // ---- quality (never fatal) ---------------------------------------------------------------
  if (!arena.cover.length)
    at('no-cover', 'warning', 'на карте нет укрытий: бой сводится к перестрелке в открытом поле')

  return issues
}

/**
 * Objective cells, labelled. Duplicated from `objective.ts`'s `objectiveCells` on purpose: importing it here
 * would make this module depend on the objective runtime, and the two lists answer different questions — that
 * one bounds-checks against the arena, this one asks whether the hero can walk there.
 */
const objectiveCellsOf = (params: ObjectiveParams): [string, Point][] => {
  switch (params.kind) {
    case 'eliminate':
      return []
    case 'secure':
      return [['zone', params.zone]]
    case 'retrieve':
      return [
        ['at', params.at],
        ['exit', params.exit],
      ]
    case 'escape':
      return [['exit', params.exit]]
  }
}

/** True when a finding list would fail a validation run. */
export const hasBlockingIssues = (issues: readonly PlayabilityIssue[]) =>
  issues.some((issue) => issue.level === 'error')
