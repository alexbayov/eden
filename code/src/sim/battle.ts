/**
 * Deterministic battle driver for the balance simulator (W3-01/W3-02).
 *
 * This module decides *what the hero does*; it computes nothing about the outcome. Every number
 * that matters — hit chance, damage, crit, malfunction, armour wear, AP, statuses, enemy AI — comes
 * from `game/combat.ts` via `combatAttack`/`reloadWeapon`/`clearMalfunction`/`runEnemyTurn` and from
 * `game/session.ts` via `resolveEnemyPhase`. There is no formula here, and adding one would break
 * W3-01 acceptance criterion 3.
 *
 * ## Roll ordering (must not drift)
 *
 * The order in which `nextRandom` is advanced *is* part of the measured system: change it and the
 * same seed produces different battles. Two orderings exist in the shipped game and both are
 * preserved here rather than unified:
 *
 *   - **player attack** — `app.tsx` builds `{ malfunction: roll(), hit: roll(), crit: roll() }`. In
 *     JS an object literal evaluates in source order, so the player consumes *malfunction, hit,
 *     crit*. This module calls the same `performCombatAttack` with a literal in the same order.
 *   - **enemy turn** — `combat.ts` passes `{ hit: roll(), crit: roll(), malfunction: roll() }`, i.e.
 *     *hit, crit, malfunction*, and consumes further rolls per enemy and per overwatch reaction. The
 *     simulator does not reimplement any of it: it calls `resolveEnemyPhase`, which owns both the
 *     ordering and the `rngState` threading.
 *
 * The hero's own dice therefore come from the same single LCG stream as the enemy's, advanced in the
 * same order the game advances it. `rngState` is carried through the `SaveData` snapshot exactly as
 * the game carries it, which is also why the enemy phase can be delegated wholesale.
 *
 * ## Policies
 *
 * A policy is only a target-and-body-part choice plus whether to use cover, i.e. the decisions a
 * player makes. Policies are intentionally crude and deterministic; they are not an AI and they are
 * not tuned. See `policies.ts`.
 */
import {
  cellKey,
  clearMalfunction,
  defensiveCover,
  findReachable,
  getAttack,
  hasLineOfSight,
  isAlive,
  performCombatAttack,
  reloadWeapon,
  startTurn,
  advanceStatuses,
  type BodyPart,
  type Cover,
  type Point,
  type Reachability,
  type Unit,
} from '../game/combat'
import type { ArenaConfig } from '../game/content'
import { nextRandom } from '../game/rng'
import { evaluateObjective, pickUpObjective } from '../game/objective'
import { resolveEnemyPhase, type ObjectiveResolution } from '../game/session'
import type { CampaignMission } from '../game/campaign'
import { syncEquipmentInstances } from '../game/equipment-content'
import type { SaveData } from '../game/save'
import type { Policy, PolicyContext } from './policies'

/** How a single simulated battle ended. */
/**
 * `objective-failed` is new in W6-01: the hero is alive and nothing went wrong in combat, but the
 * objective's own deadline passed. Kept distinct from `loss` because pooling them would report a
 * design deadline as a balance failure, and distinct from `turn-limit` because that is the
 * simulator's stalemate guard rather than a rule of the game.
 */
export type BattleOutcome = 'win' | 'loss' | 'ammo-empty' | 'turn-limit' | 'objective-failed'

export interface ShotRecord {
  part: BodyPart
  hit: boolean
  critical: boolean
  executed: boolean
  malfunctioned: boolean
  damage: number
  targetId: string
  /** Enemy archetype id when the target is an enemy, for per-archetype TTK. */
  archetypeId?: string
}

export interface BattleResult {
  arenaId: string
  policyId: string
  seed: number
  outcome: BattleOutcome
  /** Player turns actually taken, counting the turn the battle ended on. */
  turns: number
  heroHpStart: number
  heroHpEnd: number
  heroMaxHp: number
  damageTaken: number
  damageDealt: number
  shots: ShotRecord[]
  reloads: number
  jamClears: number
  /** Rounds fired by the hero: one per triggered shot, jams included. */
  ammoSpent: number
  ammoRemaining: number
  weaponDurabilityLost: number
  armorDurabilityLost: number
  /** True when the hero left the encounter voluntarily because no attack was possible. */
  retreated: boolean
  killsByArchetype: Record<string, number>
  /** Player turn index (1-based) on which each enemy died; the TTK sample. */
  ttkTurnsByArchetype: Record<string, number[]>
  enemiesKilled: number
  enemyCount: number
  finalUnits: Unit[]
  finalRngState: number
}

export interface BattleOptions {
  arena: ArenaConfig
  /** A validated save whose units/inventory are already at mission start. */
  save: SaveData
  policy: Policy
  seed: number
  /**
   * Hard stop so a stalemate (hero out of ammo behind cover, defender that never advances)
   * terminates instead of spinning. A battle that hits this is reported as `turn-limit`, never
   * silently as a loss — a turn-limit rate above zero is itself a balance finding.
   */
  turnLimit: number
  /**
   * W6-01 — the encounter's objective.
   *
   * Required for the measurement to mean anything once objectives exist: this loop used to declare a
   * win the moment the last enemy died, which is exactly the assumption `secure` breaks. A simulator
   * that kept it would report a win rate for a mission the player cannot finish that way.
   *
   * Defaulted by the caller rather than here, so a new encounter cannot silently be measured as an
   * `eliminate`.
   */
  objective: ObjectiveResolution
  /**
   * The campaign's mission list, carrying each zone's position. Optional: a single-encounter probe has no campaign, and
   * `session.ts` then falls back to reconstructing a zone-blind list from the save.
   */
  missions?: readonly CampaignMission[]
}

const coverList = (arena: ArenaConfig): Cover[] => arena.cover.map((cover) => ({ ...cover, kind: cover.type }))

/** Full-cover cells plus every living unit except the two named ones: the game's LOS blocker set. */
const blockersFor = (units: readonly Unit[], arena: ArenaConfig, ignore: readonly string[]): Set<string> =>
  new Set([
    ...arena.cover.filter((cover) => cover.type === 'full').map((cover) => cellKey(cover.x, cover.y)),
    ...units.filter((unit) => isAlive(unit) && !ignore.includes(unit.id)).map((unit) => cellKey(unit.x, unit.y)),
  ])

const durabilityOf = (unit: Unit | undefined) => ({
  weapon: unit?.weaponState?.durability ?? 0,
  armor: unit?.armor?.durability ?? 0,
})

/**
 * Runs one battle to a terminal state and returns its metrics.
 *
 * The loop is: hero acts until out of AP or out of options -> enemy phase via `resolveEnemyPhase`
 * -> repeat. Hero AP restoration, status decay and turn counting are delegated to
 * `resolveEnemyPhase` (which calls `startTurn`/`advanceStatuses`) so a status effect never behaves
 * differently in the simulator than in the game.
 */
export function simulateBattle(options: BattleOptions): BattleResult {
  const { arena, policy, seed, turnLimit, objective } = options
  const cover = coverList(arena)
  let save: SaveData = { ...options.save, rngState: seed >>> 0, turn: 1, phase: 'player' }
  /** Objective state across the battle; only a `retrieve` pick-up mutates it outside the turn clock. */
  let objectiveState = save.objective
  const heroStart = save.units.find((unit) => unit.id === 'hero')!
  const startDurability = durabilityOf(heroStart)
  const enemyIds = save.units.filter((unit) => unit.team === 'enemy').map((unit) => unit.id)
  const archetypeById = new Map(save.units.map((unit) => [unit.id, unit.archetypeId]))

  const shots: ShotRecord[] = []
  const killsByArchetype: Record<string, number> = {}
  const ttkTurnsByArchetype: Record<string, number[]> = {}
  let reloads = 0
  let jamClears = 0
  let damageDealt = 0
  let retreated = false
  let outcome: BattleOutcome | null = null
  let turns = 0
  const dead = new Set<string>()

  const recordKills = (units: readonly Unit[], turnIndex: number) => {
    for (const id of enemyIds) {
      if (dead.has(id)) continue
      const unit = units.find((candidate) => candidate.id === id)
      if (unit && !isAlive(unit)) {
        dead.add(id)
        const key = archetypeById.get(id) ?? id
        killsByArchetype[key] = (killsByArchetype[key] ?? 0) + 1
        ttkTurnsByArchetype[key] = [...(ttkTurnsByArchetype[key] ?? []), turnIndex]
      }
    }
  }

  while (outcome === null) {
    turns = save.turn
    if (turns > turnLimit) {
      outcome = 'turn-limit'
      break
    }
    let units = save.units
    let rngState = save.rngState
    /** The hero's dice, drawn from the same LCG stream and advanced the same way the game does. */
    const roll = () => {
      const next = nextRandom(rngState)
      rngState = next.state
      return next.value
    }

    // ---- player phase -------------------------------------------------------------------
    /*
     * One action per iteration; the phase ends by `break`. Termination is structural rather than
     * assumed: every action the loop performs costs at least 1 AP (`clearMalfunction` 2,
     * `reloadWeapon` `reloadAp` ≥ 1, a move `cost` ≥ 1, an attack `apCost` ≥ 4), so `progressAp`
     * strictly decreases. The guard makes that an enforced invariant — a future decision kind that
     * spent nothing would end the phase instead of spinning forever.
     *
     * Taking a `retrieve` item is the one free action, exactly as in the game (`pickUpObjective` spends no AP), so
     * it is exempted **once** rather than by relaxing the guard: `pickUpObjective` sets `carrying` and refuses a
     * second time, which bounds the exemption at one iteration per battle. Weakening the AP invariant instead would
     * have removed the protection for every future action kind too.
     */
    let progressAp = Number.POSITIVE_INFINITY
    let freeActionAvailable = true
    for (;;) {
      const hero = units.find((unit) => unit.id === 'hero')!
      if (!isAlive(hero)) break
      if (hero.ap >= progressAp && !freeActionAvailable) break
      progressAp = Math.min(progressAp, hero.ap)
      const enemies = units.filter((unit) => unit.team === 'enemy' && isAlive(unit))
      /*
       * An empty board ends the phase only for objectives that combat can finish. `retrieve` and `escape` are
       * finished by *walking* — to a pickup cell, then to an exit — so breaking here made them unwinnable the moment
       * the last enemy died, and equally unwinnable while enemies lived because no policy branch moved toward the
       * goal. That is why the first shipped `retrieve` encounter measured 0% over 103 runs.
       */
      const objectiveNeedsMovement =
        objective.params.kind === 'retrieve' || objective.params.kind === 'escape' || objective.params.kind === 'secure'
      if (!enemies.length && !objectiveNeedsMovement) break

      const visible = enemies.filter((enemy) =>
        hasLineOfSight(hero, enemy, blockersFor(units, arena, [hero.id, enemy.id])),
      )
      /* Reachability is derived once per decision and only when a policy asks for it. */
      let reach: Reachability | null = null
      const currentUnits = units
      const context: PolicyContext = {
        hero,
        enemies,
        visibleEnemies: visible,
        arena,
        cover,
        coverFor: (target: Unit) => defensiveCover(hero, target, cover),
        reachable: () =>
          (reach ??= findReachable(
            hero,
            hero.ap,
            arena.width,
            arena.height,
            blockersFor(currentUnits, arena, [hero.id]),
          )),
        /* Live objective state: a pick-up inside this phase must be visible to the next decision. */
        objective: { params: objective.params, state: objectiveState },
      }

      // A jam blocks every shot, so clearing it is always the first useful action.
      if (hero.weaponState?.malfunctioned) {
        const cleared = clearMalfunction(hero)
        if (cleared) {
          units = units.map((unit) => (unit.id === hero.id ? cleared : unit))
          jamClears += 1
          continue
        }
        break
      }

      const decision = policy.decide(context)
      if (decision.kind === 'pick-up') {
        /* `pickUpObjective` is the shipped rule and refuses off-cell or repeat pickups, so an illegal decision ends
           the phase instead of silently granting the item. */
        const picked = pickUpObjective({
          params: objective.params,
          state: objectiveState,
          units,
          turn: save.turn,
          turnLimit: objective.turnLimit,
        })
        if (!picked) break
        objectiveState = picked
        /* The single free action is now spent, so the AP guard applies unconditionally from here. */
        freeActionAvailable = false
        continue
      }
      if (decision.kind === 'reload') {
        const reloaded = reloadWeapon(hero)
        if (!reloaded) break
        units = units.map((unit) => (unit.id === hero.id ? reloaded : unit))
        reloads += 1
        continue
      }
      if (decision.kind === 'move') {
        if (decision.cost < 1 || decision.cost > hero.ap) break
        units = units.map((unit) =>
          unit.id === hero.id ? { ...unit, x: decision.to.x, y: decision.to.y, ap: unit.ap - decision.cost } : unit,
        )
        continue
      }
      if (decision.kind === 'pass') break

      const target = decision.target
      if (hero.ap < getAttack(decision.part).apCost) break
      /* Player roll order: malfunction, hit, crit — the literal order in app.tsx's attack(). */
      const action = performCombatAttack(
        hero,
        target,
        decision.part,
        defensiveCover(hero, target, cover),
        { malfunction: roll(), hit: roll(), crit: roll() },
      )
      if (!action.ok) break
      units = units.map((unit) =>
        unit.id === hero.id ? action.attacker : unit.id === target.id ? action.target : unit,
      )
      damageDealt += action.resolution?.damage ?? 0
      shots.push({
        part: decision.part,
        hit: Boolean(action.resolution?.hit),
        critical: Boolean(action.resolution?.critical),
        executed: Boolean(action.resolution?.executed),
        malfunctioned: action.malfunctioned,
        damage: action.resolution?.damage ?? 0,
        targetId: target.id,
        archetypeId: target.archetypeId,
      })
      recordKills(units, turns)
    }

    /* `objective` carries a pick-up made during this phase, so the evaluation below and the enemy phase both see it. */
    save = { ...save, units, rngState, objective: objectiveState, inventory: syncEquipmentInstances(save.inventory, units) }
    recordKills(units, turns)

    const hero = units.find((unit) => unit.id === 'hero')!
    if (!isAlive(hero)) {
      outcome = 'loss'
      break
    }
    /*
     * W6-01: the objective decides, not "the board is empty".
     *
     * Previously `!units.some(alive)` was the win condition, which measured every mission as an
     * `eliminate`. Evaluated here on the player's own turn as well as inside the enemy phase, because
     * an `escape` or `retrieve` completes on a hero action while an `eliminate` completes on the kill
     * that ends the phase.
     *
     * Read-only: the turn clock is advanced by `resolveEnemyPhase` alone, so this cannot double-count a
     * held turn — the bug that made a two-turn hold finish in 1.3 turns.
     */
    const playerEvaluation = evaluateObjective({
      params: objective.params,
      state: save.objective,
      units,
      turn: save.turn,
      turnLimit: objective.turnLimit,
    })
    if (playerEvaluation.outcome === 'complete') {
      outcome = 'win'
      break
    }
    if (playerEvaluation.outcome === 'failed') {
      outcome = 'objective-failed'
      break
    }

    /*
     * Soft-lock detection, mirroring the condition the shell shows the retreat button for: no
     * round chambered, no reserve, and nothing left to unjam. The game's only exit is retreat, so
     * that is what the simulator records — as its own outcome, not as a loss.
     */
    const weapon = hero.weaponState
    if (weapon && weapon.magazine === 0 && weapon.reserveAmmo === 0 && !weapon.malfunctioned) {
      retreated = true
      outcome = 'ammo-empty'
      break
    }

    // ---- enemy phase: delegated wholesale, including its roll order and rngState ---------
    const enemySnapshot: SaveData = { ...save, phase: 'enemy' }
    /* The real mission list, so a victory closes the right zone boundary in a multi-zone campaign. */
    const resolved = resolveEnemyPhase(enemySnapshot, arena, objective, options.missions)
    if (resolved === enemySnapshot) {
      /* resolveEnemyPhase refuses non-mission snapshots; run the same primitives it would. */
      const fallback = { ...save, turn: save.turn + 1 }
      save = { ...fallback, units: fallback.units.map((unit) => (unit.id === 'hero' ? advanceStatuses(startTurn(unit)) : unit)) }
    } else {
      save = resolved
    }
    /* `resolveEnemyPhase` owns the turn clock and returns the advanced objective state; read it back rather than
       keeping a stale local, which would drop a `carrying` flag at the turn boundary. */
    objectiveState = save.objective
    recordKills(save.units, turns)
    if (!isAlive(save.units.find((unit) => unit.id === 'hero')!)) {
      outcome = 'loss'
      turns = Math.max(turns, save.turn)
      break
    }
    /*
     * W6-01: `resolveEnemyPhase` now decides the objective too, so its verdict is read rather than
     * re-derived. `victory` covers a hold that completed on the enemy's clock; a `defeat` with a live
     * hero is an expired deadline, which is a failed objective and not a loss — conflating them would
     * report a balance problem where there is a design deadline.
     */
    if (save.phase === 'victory') {
      outcome = 'win'
      break
    }
    if (save.phase === 'defeat') {
      outcome = 'objective-failed'
      turns = Math.max(turns, save.turn)
      break
    }
  }

  const heroEnd = save.units.find((unit) => unit.id === 'hero')!
  const endDurability = durabilityOf(heroEnd)
  const killed = enemyIds.filter((id) => !isAlive(save.units.find((unit) => unit.id === id)!)).length
  return {
    arenaId: arena.id,
    policyId: policy.id,
    seed: seed >>> 0,
    outcome,
    turns,
    heroHpStart: heroStart.hp,
    heroHpEnd: heroEnd.hp,
    heroMaxHp: heroEnd.maxHp,
    damageTaken: Math.max(0, heroStart.hp - heroEnd.hp),
    damageDealt,
    shots,
    reloads,
    jamClears,
    ammoSpent: shots.length,
    ammoRemaining: (heroEnd.weaponState?.magazine ?? 0) + (heroEnd.weaponState?.reserveAmmo ?? 0),
    weaponDurabilityLost: Math.max(0, startDurability.weapon - endDurability.weapon),
    armorDurabilityLost: Math.max(0, startDurability.armor - endDurability.armor),
    retreated,
    killsByArchetype,
    ttkTurnsByArchetype,
    enemiesKilled: killed,
    enemyCount: enemyIds.length,
    finalUnits: save.units,
    finalRngState: save.rngState,
  }
}

export type { Point }
