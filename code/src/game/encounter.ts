/**
 * Mission-start unit construction, shared by the app shell and the balance simulator (W3-01).
 *
 * This lived as a private helper inside `app.tsx`. It moved here unchanged because the simulator
 * has to build the *same* mission-start state the game builds — hero AP, carried HP/statuses,
 * hydrated weapon/armor instances, enemy archetypes — and a second copy of that composition in
 * the simulator would silently drift from the game it is supposed to measure.
 *
 * No rule is defined here: hydration comes from `hydrateArenaUnits`/`applyEnemyArchetype` and the
 * AP value from `AP_PER_TURN`.
 */
import { AP_PER_TURN, type Unit } from './combat'
import type { ArenaConfig } from './content'
import { applyEnemyArchetype, hydrateArenaUnits, type EquipmentCatalog } from './equipment-content'
import type { Inventory } from './inventory'

export const createEncounterUnits = (
  arena: ArenaConfig,
  equipment?: EquipmentCatalog,
  inventory?: Inventory,
  previousUnits: readonly Unit[] = [],
): Unit[] =>
  inventory
    ? hydrateArenaUnits({ units: arena.units.map((unit) => ({ ...unit, ap: 0 })) }, equipment!, inventory, previousUnits).map((unit) => ({
        ...unit,
        ap: unit.team === 'player' ? AP_PER_TURN : 0,
        posture: unit.posture ?? 'stand',
        statuses: unit.statuses ?? {},
      }))
    : arena.units.map((unit) => ({
        ...(equipment ? applyEnemyArchetype({ ...unit, ap: 0 }, equipment) : unit),
        ap: unit.team === 'player' ? AP_PER_TURN : 0,
        posture: unit.posture ?? 'stand',
        statuses: unit.statuses ?? {},
      }))
