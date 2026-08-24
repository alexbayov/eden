/**
 * One construction of the runtime `CampaignCatalog` used to validate saves.
 *
 * `app.tsx` previously built this object twice — once on boot and once for the recovery reset
 * button — and the balance simulator (W3-01) needs a third. Three hand-written copies of the same
 * id-set glue is exactly how a save that the game accepts starts being rejected by the simulator
 * (or worse, the other way round), so the construction lives here and every caller shares it.
 *
 * No validation rule is defined here: this only assembles lookups over already-validated
 * catalogs. The rules stay in `save.ts`.
 */
import type { CampaignMission } from './campaign'
import type { ItemDefinition, MissionDefinition } from './campaign-content'
import { weaponById, type EquipmentCatalog } from './equipment-content'
import { DEFAULT_LEVEL_CURVE, type LevelCurve } from './progression'
import type { CampaignCatalog } from './save'

export interface CampaignCatalogSources {
  catalogId: string
  /** Playable encounters only: a save may never reference a locked-zone encounter. */
  missions: readonly MissionDefinition[]
  rewardIds: Iterable<string>
  arenaIds: Iterable<string>
  items: readonly ItemDefinition[]
  equipment: EquipmentCatalog
  /**
   * Level curve from `progression.json`. Omitted only by callers with no loaded catalog (tests
   * building a minimal fixture), which then fall back to the shipped curve mirrored in code.
   */
  progression?: LevelCurve
}

export const campaignMissionsOf = (missions: readonly MissionDefinition[]): CampaignMission[] =>
  missions.map(({ id, zoneId, order, rewardId, arenaId }) => ({ id, zoneId, order, rewardId, arenaId }))

export function campaignCatalogFor(sources: CampaignCatalogSources): CampaignCatalog {
  const { catalogId, missions, items, equipment } = sources
  const armorFor = (armorId: string) => equipment.armor.find((entry) => entry.id === armorId)
  return {
    catalogId,
    missions: campaignMissionsOf(missions),
    missionIds: new Set(missions.map((entry) => entry.id)),
    rewardIds: new Set(sources.rewardIds),
    arenaIds: new Set(sources.arenaIds),
    zoneIds: new Set(missions.map((entry) => entry.zoneId)),
    itemIds: new Set(items.map((entry) => entry.id)),
    itemWeightForId: (itemId: string) => items.find((entry) => entry.id === itemId)?.weight,
    weaponIds: new Set(equipment.weapons.map((entry) => entry.id)),
    weaponForId: (weaponId: string) => weaponById(equipment, weaponId) ?? undefined,
    armorIds: new Set(equipment.armor.map((entry) => entry.id)),
    /** Only armour slots a save can carry; anything else stays unknown so validation rejects it. */
    armorSlotForId: (itemId: string) => {
      const slot = armorFor(itemId)?.slot
      return slot === 'head' || slot === 'torso' ? slot : undefined
    },
    armorForId: armorFor,
    ammoIds: new Set(equipment.ammo.map((entry) => entry.id)),
    ammoForId: (ammoId: string) => equipment.ammo.find((entry) => entry.id === ammoId),
    progression: sources.progression ?? DEFAULT_LEVEL_CURVE,
    rewardIdForMission: (missionId: string) => missions.find((entry) => entry.id === missionId)?.rewardId,
    arenaIdForMission: (missionId: string) => missions.find((entry) => entry.id === missionId)?.arenaId,
  }
}
