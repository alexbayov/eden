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
  type EquipmentCatalog,
} from "../game/equipment-content";
import { campaignCatalogFor } from "../game/campaign-catalog";
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
const readDiskConfig = (name: string): unknown =>
  JSON.parse(readFileSync(join(CONFIG_DIR, name.endsWith(".json") ? name : `${name}.json`), "utf8")) as unknown;

/** Reads a shipped config file straight from `public/config`. */
export const readShippedConfig = readDiskConfig;

/**
 * Config overrides by file name, for the cases where the shipped catalog cannot express a rule under
 * test.
 *
 * Added for W6-01: the objective runtime resolves four types, and the MVP zone ships only two of them
 * (`eliminate` and `secure`). Testing `retrieve`/`escape` by adding content the design has not asked for
 * would put invented missions in front of players; overriding the catalog keeps the *runtime* covered and
 * leaves content decisions to W7. Overridden files still go through the real validators, so an override
 * cannot describe a catalog the game would refuse to load.
 */
export type ContentOverrides = Readonly<Record<string, unknown>>;

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
export function loadShippedContent(overrides: ContentOverrides = {}): ShippedContent {
  /* Overridden files are read from the override map, everything else from disk. One indirection so a
     spec cannot accidentally validate an override against a different file's rules. */
  const readShippedConfig = (name: string): unknown =>
    Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : readDiskConfig(name);
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
        /* W6-01: objective geometry is bounds-checked against the arena it runs on, so a fixture cannot
           load an exit cell outside the map — an unwinnable mission that looks valid in `missions.json`. */
        arenaBounds: new Map(arenas.all.map((arena) => [arena.id, { width: arena.width, height: arena.height }])),
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
      zoneOrderById: new Map(validated.zones.map((zone) => [zone.id, zone.order])),
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
  /**
   * Zone id → position, required once the build ships more than one zone. Optional so that fixtures which
   * deliberately construct a single-zone catalog stay unchanged.
   */
  zoneOrderById?: ReadonlyMap<string, number>;
}): CampaignCatalog {
  /*
   * Delegates to the production `campaignCatalogFor` instead of rebuilding the object field by field.
   *
   * It used to be a hand-written copy, and the copy drifted the moment a second zone shipped: it omitted `zoneOrder`,
   * so every fixture built a campaign the game would sequence differently from the one the save validator checked.
   * The docblock promised "field for field the same object `App` passes" — delegation is how that promise becomes
   * structural instead of maintained by hand.
   */
  return campaignCatalogFor({
    catalogId: input.arenas.catalogId,
    missions: input.missions,
    rewardIds: input.rewards.map((entry) => entry.id),
    arenaIds: input.arenas.all.map((entry) => entry.id),
    items: input.items,
    equipment: input.equipment,
    progression: input.progression.curve,
    zoneOrderById: input.zoneOrderById,
  });
}
