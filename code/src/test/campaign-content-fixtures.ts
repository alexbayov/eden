/**
 * Shared test fixtures — loads the shipped `public/config/*.json` catalogs from disk and
 * assembles the exact same `CampaignCatalog` object `App` builds at boot.
 *
 * Used by both the Playwright specs (W1-03…W1-05) and the jsdom DOM tests (W1-02), so it must
 * not depend on either runner. The app fetches these files over HTTP; a test process reads
 * them from the filesystem. Everything between parsing and the catalog shape goes through the
 * runtime validators (`validateMissions`, `validateCampaignCatalog`, `validateArenaCatalog`, …),
 * so a fixture can never be built against a catalog the app itself would reject.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBaseUpgrades,
  validateItemEffects,
  validateItems,
  validateMissions,
  validateRecipes,
  validateReturnTables,
  validateRewards,
  validateZones,
  validateCampaignCatalog,
  type ItemDefinition,
  type ItemEffectDefinition,
  type MissionDefinition,
  type RewardDefinition,
  type ReturnTableDefinition,
  type ZoneDefinition,
} from "../game/campaign-content";
import {
  parseArenaContent,
  parseArenaManifest,
  validateArenaCatalog,
  type ArenaCatalog,
} from "../game/content";
import { parseProgression, type ProgressionCatalog } from "../game/progression";
import type { BaseUpgradeDefinition, RecipeDefinition } from "../game/base";
import {
  parseEquipmentCatalog,
  weaponById,
  type EquipmentCatalog,
} from "../game/equipment-content";
import type { CampaignCatalog } from "../game/save";

/**
 * Resolved with `node:path`, not with `new URL("../../public/…", import.meta.url)`.
 *
 * Vite statically rewrites a *literal* `new URL(..., import.meta.url)` into an asset URL, which
 * under the jsdom project resolves against `http://localhost:3000/` and makes `readFileSync`
 * fail. Keeping the path out of that pattern makes this a plain filesystem read everywhere.
 */
const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "config");

/** Reads a shipped config file straight from `public/config`. */
export const readShippedConfig = (name: string): unknown =>
  JSON.parse(readFileSync(join(CONFIG_DIR, name.endsWith(".json") ? name : `${name}.json`), "utf8")) as unknown;

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: Error }, label: string): T => {
  if (!result.ok) throw new Error(`shipped ${label} is invalid: ${result.error.message}`);
  return result.value;
};

export interface ShippedContent {
  zones: ZoneDefinition[];
  /** Only encounters inside an unlocked zone, exactly like `App`'s `playableMissions`. */
  missions: MissionDefinition[];
  rewards: RewardDefinition[];
  items: ItemDefinition[];
  /** W5-02 crafting catalog, exposed so a spec asserts labels from data rather than literals. */
  recipes: RecipeDefinition[];
  /** W5-01 node level catalog, exposed for the same reason. */
  upgrades: BaseUpgradeDefinition[];
  /** W5-03 quick-slot effects, so a spec reads the AP price and heal amount from content. */
  itemEffects: ItemEffectDefinition[];
  /** W5-04 dismantle returns, so a spec reads the expected payout from content. */
  returnTables: ReturnTableDefinition[];
  equipment: EquipmentCatalog;
  arenas: ArenaCatalog;
  progression: ProgressionCatalog;
  campaignCatalog: CampaignCatalog;
}

/** Loads and validates the shipped catalogs. Arenas come from the manifest, not a hardcoded list. */
export function loadShippedContent(): ShippedContent {
  const manifest = parseArenaManifest(readShippedConfig("arena-manifest.json"));
  const equipment = parseEquipmentCatalog(readShippedConfig("equipment.json"));
  const arenaList = manifest.entries.map((entry) => {
    /* Manifest paths are absolute web paths (`/config/x.json`); map them back to disk. */
    const arena = parseArenaContent(readShippedConfig(entry.path.replace(/^\/config\//, "")));
    if (arena.id !== entry.id) throw new Error(`arena manifest id mismatch: ${entry.id} != ${arena.id}`);
    return arena;
  });

  const progression = parseProgression(readShippedConfig("progression.json"));
  const zones = unwrap(validateZones(readShippedConfig("zones.json")), "zones");
  const missions = unwrap(validateMissions(readShippedConfig("missions.json")), "missions");
  const rewards = unwrap(validateRewards(readShippedConfig("rewards.json")), "rewards");
  const items = unwrap(validateItems(readShippedConfig("items.json")), "items");
  const recipes = unwrap(validateRecipes(readShippedConfig("recipes.json")), "recipes");
  const upgrades = unwrap(validateBaseUpgrades(readShippedConfig("base-upgrades.json")), "base-upgrades");
  const itemEffects = unwrap(validateItemEffects(readShippedConfig("item-effects.json")), "item-effects");
  const returnTables = unwrap(validateReturnTables(readShippedConfig("return-tables.json")), "return-tables");

  const arenas = validateArenaCatalog(manifest, arenaList, new Set(missions.map((mission) => mission.arenaId)));
  /* The same cross-file references the shell checks at boot, including the equipment/ammo id sets:
     without them a fixture load would accept a catalog the running game rejects. */
  const validated = unwrap(
    validateCampaignCatalog(
      { zones, missions, rewards, items, recipes, upgrades, itemEffects, returnTables },
      new Set(arenas.all.map((arena) => arena.id)),
      new Set(items.map((item) => item.id)),
      {
        equipmentIds: new Set([...equipment.weapons.map((entry) => entry.id), ...equipment.armor.map((entry) => entry.id)]),
        ammoIds: new Set(equipment.ammo.map((entry) => entry.id)),
      },
    ),
    "campaign catalog",
  );

  const unlockedZones = new Set(validated.zones.filter((zone) => zone.unlocked).map((zone) => zone.id));
  const playable = validated.missions.filter((mission) => unlockedZones.has(mission.zoneId));
  if (!playable.length) throw new Error("shipped catalog has no playable encounter");

  return {
    zones: validated.zones,
    missions: playable,
    rewards: validated.rewards,
    items,
    recipes,
    upgrades,
    itemEffects,
    returnTables,
    equipment,
    arenas,
    progression,
    campaignCatalog: shippedCampaignCatalog({
      missions: playable,
      rewards: validated.rewards,
      items,
      equipment,
      arenas,
      progression,
    }),
  };
}

/**
 * Rebuilds the runtime `CampaignCatalog` validation options. Field for field the same object
 * `App` passes to `saveAdapter.setValidationOptions`, so a fixture is validated by identical
 * rules to a save the running app writes.
 */
export function shippedCampaignCatalog(input: {
  missions: readonly MissionDefinition[];
  rewards: readonly RewardDefinition[];
  items: readonly ItemDefinition[];
  equipment: EquipmentCatalog;
  arenas: ArenaCatalog;
  progression: ProgressionCatalog;
}): CampaignCatalog {
  const { missions, rewards, items, equipment, arenas, progression } = input;
  const armorFor = (itemId: string) => equipment.armor.find((entry) => entry.id === itemId);
  return {
    catalogId: arenas.catalogId,
    missions: missions.map(({ id, zoneId, order, rewardId, arenaId }) => ({ id, zoneId, order, rewardId, arenaId })),
    missionIds: new Set(missions.map((entry) => entry.id)),
    rewardIds: new Set(rewards.map((entry) => entry.id)),
    arenaIds: new Set(arenas.all.map((entry) => entry.id)),
    zoneIds: new Set(missions.map((entry) => entry.zoneId)),
    itemIds: new Set(items.map((entry) => entry.id)),
    itemWeightForId: (itemId: string) => items.find((entry) => entry.id === itemId)?.weight,
    weaponIds: new Set(equipment.weapons.map((entry) => entry.id)),
    weaponForId: (weaponId: string) => weaponById(equipment, weaponId) ?? undefined,
    armorIds: new Set(equipment.armor.map((entry) => entry.id)),
    armorSlotForId: (itemId: string) => {
      const slot = armorFor(itemId)?.slot;
      return slot === "head" || slot === "torso" ? slot : undefined;
    },
    armorForId: (armorId: string) => armorFor(armorId),
    ammoIds: new Set(equipment.ammo.map((entry) => entry.id)),
    ammoForId: (ammoId: string) => equipment.ammo.find((entry) => entry.id === ammoId),
    progression: progression.curve,
    rewardIdForMission: (missionId: string) => missions.find((entry) => entry.id === missionId)?.rewardId,
    arenaIdForMission: (missionId: string) => missions.find((entry) => entry.id === missionId)?.arenaId,
  };
}
