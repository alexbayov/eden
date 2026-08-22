/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Posture, Statuses, Unit } from "./combat";
import { createCampaign, type CampaignMission, type CampaignState } from "./campaign";
import { defaultBase, isValidBase, type BaseState } from "./base";
import { createInventory, isEquipmentSlot, isResourceId, type EquipmentInstance, type EquipmentSlot, type Inventory } from "./inventory";
import { DEFAULT_RNG_STATE } from "./rng";
import { hydrateArenaUnits, type ArmorDefinition, type EquipmentCatalog, type WeaponDefinition } from "./equipment-content";

export const SAVE_SCHEMA_VERSION = 4;
export const SAVE_STORAGE_KEY = "eden.save.v4";
export const SAVE_BACKUP_KEY = "eden.save.v4.corrupt-backup";
export type BattlePhase = "player" | "enemy" | "victory" | "defeat";
export interface SaveData { schemaVersion: 4; arenaId: string; activeEncounterId: string | null; phase: BattlePhase; turn: number; rngState: number; units: Unit[]; campaign: CampaignState; inventory: Inventory; base: BaseState }
export interface SaveIssue { path: string; message: string }
export interface CampaignCatalog { catalogId?: string; missions: readonly CampaignMission[]; missionIds: ReadonlySet<string>; rewardIds: ReadonlySet<string>; arenaIds: ReadonlySet<string>; zoneIds?: ReadonlySet<string>; itemIds?: ReadonlySet<string>; itemWeightForId?: (itemId: string) => number | undefined; weaponIds?: ReadonlySet<string>; weaponForId?: (weaponId: string) => WeaponDefinition | undefined; armorIds?: ReadonlySet<string>; armorSlotForId?: (itemId: string) => string | undefined; armorForId?: (armorId: string) => ArmorDefinition | undefined; ammoIds?: ReadonlySet<string>; ammoForId?: (ammoId: string) => { damageModifier: number; penetrationModifier: number } | undefined; rewardIdForMission: (missionId: string) => string | undefined; arenaIdForMission: (missionId: string) => string | undefined }
export interface SaveValidationOptions { campaignCatalog?: CampaignCatalog; campaignMissions?: readonly CampaignMission[] }
export type SaveResult = { ok: true; value: SaveData } | { ok: false; error: SaveValidationError };
export class SaveValidationError extends Error { readonly code: "parse" | "version" | "shape"; readonly issues: SaveIssue[]; constructor(code: SaveValidationError["code"], issues: SaveIssue[]) { super(`Некорректное сохранение (${code}): ${issues.map((i) => `${i.path} — ${i.message}`).join("; ")}`); this.name = "SaveValidationError"; this.code = code; this.issues = issues } }
const phases = new Set<BattlePhase>(["player", "enemy", "victory", "defeat"]);
const screens = new Set(["home", "mission-select", "mission", "reward", "return"]);
const statuses = new Set<keyof Statuses>(["arm", "leg", "immobilized", "blind", "shocked", "head"]);
const postures = new Set<Posture>(["stand", "crouch", "prone"]);
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const int = (v: unknown, min = 0) => typeof v === "number" && Number.isInteger(v) && v >= min;
const string = (v: unknown) => typeof v === "string" && v.length > 0;
const issue = (issues: SaveIssue[], path: string, message: string) => issues.push({ path, message });
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const weaponDefinitionFields = ["name", "baseDamage", "accuracyModifier", "critModifier", "penetration", "magazineSize", "reloadAp", "durabilityPerShot", "makeshift"] as const;
const linkedWeaponFields = ["weaponInstanceId", "weaponId", "ammoId", "name", "baseDamage", "accuracyModifier", "critModifier", "penetration", "damageModifier", "penetrationModifier", "ammoDamageModifier", "ammoPenetrationModifier", "magazine", "magazineSize", "reserveAmmo", "durability", "maxDurability", "durabilityPerShot", "reloadAp", "makeshift", "malfunctioned"] as const;
const armorReductionParts = ["head", "torso", "arm", "leg", "eye", "groin"] as const;
const sameCachedValue = (actual: unknown, expected: unknown) => actual === expected;

const armorPartsForId = (armorId: string) => armorId.split("+");

function armorDefinitionForId(catalog: CampaignCatalog | undefined, armorId: string): ArmorDefinition | undefined {
  if (!catalog?.armorForId) return undefined;
  const definitions = armorPartsForId(armorId).map((part) => catalog.armorForId!(part));
  if (definitions.some((definition): definition is undefined => !definition)) return undefined;
  const first = definitions[0]!;
  if (definitions.some((definition) => definition!.slot !== first.slot)) return undefined;
  const maxDurability = definitions.every((definition) => definition!.maxDurability !== undefined)
    ? definitions.reduce((sum, definition) => sum + definition!.maxDurability!, 0)
    : undefined;
  return {
    ...first,
    ...(maxDurability === undefined ? {} : { maxDurability }),
    id: armorId,
    reduction: definitions.reduce<ArmorDefinition["reduction"]>((combined, definition) => {
      for (const [part, amount] of Object.entries(definition!.reduction)) {
        combined[part as keyof ArmorDefinition["reduction"]] = (combined[part as keyof ArmorDefinition["reduction"]] ?? 0) + amount;
      }
      return combined;
    }, {}),
  };
}

function armorKnownInCatalog(catalog: CampaignCatalog | undefined, armorId: string): boolean {
  if (!catalog?.armorIds) return true;
  const parts = armorPartsForId(armorId);
  const known = parts.every((part) => catalog.armorIds!.has(part));
  return known && (!catalog.armorForId || parts.every((part) => Boolean(catalog.armorForId!(part))));
}

function armorSlotInCatalog(catalog: CampaignCatalog | undefined, armorId: string): string | undefined {
  return catalog?.armorSlotForId?.(armorId) ?? armorDefinitionForId(catalog, armorId)?.slot;
}

function checkStack(value: unknown, path: string, issues: SaveIssue[], resource: boolean, catalog?: CampaignCatalog) {
  if (!record(value)) return issue(issues, path, "объект стека");
  if (!string(value.id) || (resource && !isResourceId(value.id))) issue(issues, `${path}.id`, "известный id");
  if (!resource && catalog?.itemIds && (!string(value.id) || !catalog.itemIds.has(value.id))) issue(issues, `${path}.id`, "известный item id runtime-каталога");
  if (!int(value.quantity) || value.quantity < 1) issue(issues, `${path}.quantity`, "положительное целое");
  if (!finite(value.weight) || value.weight < 0) issue(issues, `${path}.weight`, "неотрицательное число");
  if (!resource && catalog?.itemWeightForId && string(value.id)) {
    const expectedWeight = catalog.itemWeightForId(value.id);
    if (expectedWeight !== undefined && value.weight !== expectedWeight) issue(issues, `${path}.weight`, "вес совпадает с runtime-каталогом");
  }
}
function checkContainer(value: unknown, path: string, issues: SaveIssue[], catalog?: CampaignCatalog) {
  if (!record(value)) return issue(issues, path, "объект контейнера");
  for (const [key, resource] of [["resources", true], ["items", false]] as const) {
    if (!Array.isArray(value[key])) issue(issues, `${path}.${key}`, "массив");
    else {
      const ids = new Set<string>();
      value[key].forEach((entry: unknown, i: number) => {
        checkStack(entry, `${path}.${key}[${i}]`, issues, resource, catalog);
        if (record(entry) && string(entry.id)) {
          if (ids.has(entry.id)) issue(issues, `${path}.${key}[${i}].id`, "уникальный id в контейнере");
          ids.add(entry.id);
        }
      });
    }
  }
}
function checkInventory(value: unknown, issues: SaveIssue[], catalog?: CampaignCatalog) {
  if (!record(value)) return issue(issues, "$.inventory", "объект инвентаря");
  if (!finite(value.backpackCapacity) || value.backpackCapacity < 0) issue(issues, "$.inventory.backpackCapacity", "неотрицательное число");
  checkContainer(value.backpack, "$.inventory.backpack", issues, catalog); checkContainer(value.stash, "$.inventory.stash", issues, catalog);
  if (!Array.isArray(value.quickSlots) || value.quickSlots.length !== 4 || value.quickSlots.some((x: unknown) => x !== null && !string(x))) issue(issues, "$.inventory.quickSlots", "четыре item id или null");
  else {
    const slots = new Set<string>();
    for (const [index, itemId] of value.quickSlots.entries()) {
      if (itemId === null) continue;
      if (catalog?.itemIds && !catalog.itemIds.has(itemId)) issue(issues, `$.inventory.quickSlots[${index}]`, "известный item id runtime-каталога");
      const backpackItems = record(value.backpack) && Array.isArray(value.backpack.items) ? value.backpack.items : [];
      const stack = backpackItems.find((entry: unknown) => record(entry) && entry.id === itemId);
      if (!stack || !int(stack.quantity, 1)) issue(issues, `$.inventory.quickSlots[${index}]`, "item присутствует в backpack");
      if (slots.has(itemId)) issue(issues, `$.inventory.quickSlots[${index}]`, "item не дублируется в quick slots");
      slots.add(itemId);
    }
  }
  if (!Array.isArray(value.equipment)) issue(issues, "$.inventory.equipment", "массив");
  else {
    const instanceIds = new Set<string>();
    value.equipment.forEach((e: unknown, i: number) => {
      const p = `$.inventory.equipment[${i}]`;
      if (!record(e)) return issue(issues, p, "объект экипировки");
      if (!string(e.instanceId) || !string(e.itemId)) issue(issues, p, "instanceId и itemId");
      if (string(e.instanceId)) {
        if (instanceIds.has(e.instanceId)) issue(issues, `${p}.instanceId`, "уникальный instanceId");
        instanceIds.add(e.instanceId);
      }
      const isKnownWeapon = catalog?.weaponIds && string(e.itemId) ? catalog.weaponIds.has(e.itemId) : false;
      const isKnownArmor = string(e.itemId) ? armorKnownInCatalog(catalog, e.itemId) : false;
      if (catalog?.weaponIds && catalog?.armorIds && string(e.itemId) && !isKnownWeapon && !isKnownArmor) issue(issues, `${p}.itemId`, "известный weapon или armor id runtime-каталога");
      if (!isEquipmentSlot(e.slot)) issue(issues, `${p}.slot`, "известный слот");
      if (catalog?.weaponIds && catalog?.armorIds && string(e.itemId) && isEquipmentSlot(e.slot)) {
        if ((e.slot === "primary" || e.slot === "secondary") && !isKnownWeapon) issue(issues, `${p}.slot`, "weapon занимает weapon slot");
        if ((e.slot === "head" || e.slot === "torso") && !isKnownArmor) issue(issues, `${p}.slot`, "armor занимает armor slot");
        const expectedArmorSlot = isKnownArmor ? armorSlotInCatalog(catalog, e.itemId) : undefined;
        if (expectedArmorSlot && e.slot !== expectedArmorSlot) issue(issues, `${p}.slot`, "slot совпадает с runtime-каталогом");
        if (isKnownArmor && (e.slot === "primary" || e.slot === "secondary")) issue(issues, `${p}.slot`, "armor не может быть оружием");
        if (isKnownWeapon && (e.slot === "head" || e.slot === "torso")) issue(issues, `${p}.slot`, "weapon не может быть бронёй");
      }
       if (!int(e.durability) || !int(e.maxDurability, 1) || e.durability > e.maxDurability) issue(issues, p, "корректная durability");
       if (e.magazine !== undefined && !int(e.magazine)) issue(issues, `${p}.magazine`, "неотрицательное целое");
       if (e.reserveAmmo !== undefined && !int(e.reserveAmmo)) issue(issues, `${p}.reserveAmmo`, "неотрицательное целое");
       if (e.malfunctioned !== undefined && typeof e.malfunctioned !== "boolean") issue(issues, `${p}.malfunctioned`, "boolean");
    });
  }
}
function checkUnit(value: unknown, path: string, issues: SaveIssue[]) {
  if (!record(value)) return issue(issues, path, "объект юнита");
  for (const key of ["id", "name", "color"] as const) if (!string(value[key])) issue(issues, `${path}.${key}`, "непустая строка");
  if (value.team !== "player" && value.team !== "enemy") issue(issues, `${path}.team`, "player | enemy");
  for (const key of ["x", "y", "ap", "aim", "maxHp"] as const) if (!int(value[key])) issue(issues, `${path}.${key}`, "целое число");
  if (!int(value.hp) || !int(value.maxHp, 1) || value.hp > value.maxHp) issue(issues, `${path}.hp`, "0..maxHp");
  if (value.posture !== undefined && !postures.has(value.posture)) issue(issues, `${path}.posture`, "valid posture");
  if (value.statuses !== undefined && (!record(value.statuses) || Object.entries(value.statuses).some(([k, n]) => !statuses.has(k as keyof Statuses) || !int(n)))) issue(issues, `${path}.statuses`, "валидные статусы");
}
function checkArmorReduction(actual: unknown, expected: ArmorDefinition["reduction"], path: string, issues: SaveIssue[]) {
  if (!record(actual)) return issue(issues, path, "reduction совпадает с armor definition");
  for (const part of armorReductionParts) {
    if (actual[part] !== expected[part] && (actual[part] !== undefined || expected[part] !== undefined)) issue(issues, `${path}.${part}`, "reduction совпадает с armor definition");
  }
  for (const key of Object.keys(actual)) {
    if (!armorReductionParts.includes(key as typeof armorReductionParts[number]) || !(key in expected)) issue(issues, `${path}.${key}`, "нет лишних mutable armor stats");
  }
}

function checkEquipmentLinks(units: unknown, inventory: unknown, issues: SaveIssue[], catalog?: CampaignCatalog) {
  if (!Array.isArray(units) || !record(inventory) || !Array.isArray(inventory.equipment)) return;
  const byInstance = new Map<string, Record<string, any>>();
  inventory.equipment.forEach((entry: unknown) => {
    if (record(entry) && string(entry.instanceId)) byInstance.set(entry.instanceId, entry);
  });
  units.forEach((unit: unknown, index: number) => {
    if (!record(unit)) return;
    const unitPath = `$.units[${index}]`;
    if (unit.weaponState !== undefined) {
      if (!record(unit.weaponState)) issue(issues, `${unitPath}.weaponState`, "объект состояния оружия");
      else {
        const weapon = unit.weaponState;
        for (const key of ["weaponInstanceId", "weaponId", "ammoId"] as const) if (!string(weapon[key])) issue(issues, `${unitPath}.weaponState.${key}`, "непустая строка");
         if (catalog?.weaponIds && string(weapon.weaponId) && !catalog.weaponIds.has(weapon.weaponId)) issue(issues, `${unitPath}.weaponState.weaponId`, "известный weapon id runtime-каталога");
         if (catalog?.weaponForId && string(weapon.weaponId)) {
           const definition = catalog.weaponForId(weapon.weaponId);
           if (!definition) issue(issues, `${unitPath}.weaponState.weaponId`, "weapon definition runtime-каталога");
           else {
              if (weapon.ammoId !== definition.ammoId) issue(issues, `${unitPath}.weaponState.ammoId`, "совпадает с ammoId weapon definition");
              for (const key of weaponDefinitionFields) {
                if (!(key in weapon) || !sameCachedValue(weapon[key], definition[key])) issue(issues, `${unitPath}.weaponState.${key}`, "обязательное поле совпадает с weapon definition");
              }
              const ammo = catalog.ammoForId?.(definition.ammoId);
              if (ammo) {
                for (const [key, expected] of [["ammoDamageModifier", ammo.damageModifier], ["ammoPenetrationModifier", ammo.penetrationModifier]] as const) {
                  if (!(key in weapon) || weapon[key] !== expected) issue(issues, `${unitPath}.weaponState.${key}`, "обязательное поле совпадает с ammo definition");
                }
                for (const [key, expected] of [["damageModifier", ammo.damageModifier], ["penetrationModifier", ammo.penetrationModifier]] as const) {
                  if (key in weapon && weapon[key] !== expected) issue(issues, `${unitPath}.weaponState.${key}`, "совпадает с ammo definition");
                }
              }
           }
         }
         if (catalog?.ammoIds && string(weapon.ammoId) && !catalog.ammoIds.has(weapon.ammoId)) issue(issues, `${unitPath}.weaponState.ammoId`, "известный ammo id runtime-каталога");
         for (const key of ["magazine", "magazineSize", "reserveAmmo", "durability", "maxDurability", "durabilityPerShot", "reloadAp"] as const) if (!int(weapon[key])) issue(issues, `${unitPath}.weaponState.${key}`, "неотрицательное целое");
         if (typeof weapon.magazine === "number" && typeof weapon.magazineSize === "number" && (weapon.magazine < 0 || weapon.magazine > weapon.magazineSize)) issue(issues, `${unitPath}.weaponState.magazine`, "значение в диапазоне 0..magazineSize");
         if (typeof weapon.reserveAmmo === "number" && weapon.reserveAmmo < 0) issue(issues, `${unitPath}.weaponState.reserveAmmo`, "неотрицательное число");
         if (typeof weapon.durability === "number" && typeof weapon.maxDurability === "number" && (weapon.durability < 0 || weapon.durability > weapon.maxDurability)) issue(issues, `${unitPath}.weaponState.durability`, "значение в диапазоне 0..maxDurability");
         if (typeof weapon.malfunctioned !== "undefined" && typeof weapon.malfunctioned !== "boolean") issue(issues, `${unitPath}.weaponState.malfunctioned`, "boolean");
         if (unit.team === "player") {
           const linked = string(weapon.weaponInstanceId) ? byInstance.get(weapon.weaponInstanceId) : undefined;
           if (!linked) issue(issues, `${unitPath}.weaponState.weaponInstanceId`, "ссылка на inventory equipment instance");
           else {
             const linkedPath = `${unitPath}.weaponState`;
             if (linked.itemId !== weapon.weaponId) issue(issues, `${linkedPath}.weaponId`, "совпадает с inventory equipment itemId");
             if (linked.instanceId !== weapon.weaponInstanceId) issue(issues, `${linkedPath}.weaponInstanceId`, "совпадает с inventory equipment instanceId");
             if (linked.slot !== "primary" && linked.slot !== "secondary") issue(issues, `${linkedPath}.weaponInstanceId`, "ссылка на weapon slot");
             for (const key of linkedWeaponFields) {
                const inventoryKey = key === "weaponInstanceId" ? "instanceId" : key === "weaponId" ? "itemId" : key;
                if (linked[inventoryKey] !== weapon[key]) issue(issues, `${linkedPath}.${key}`, "совпадает с inventory equipment instance");
             }
           }
         }
      }
    }
    if (unit.armor !== undefined) {
      if (unit.team === "enemy" && record(unit.armor) && unit.armor.armorId === "" && record(unit.armor.reduction) && Object.keys(unit.armor.reduction).length === 0) return;
      if (!record(unit.armor)) issue(issues, `${unitPath}.armor`, "объект состояния брони");
      else {
        const armor = unit.armor;
        if (!string(armor.armorInstanceId) || !string(armor.armorId)) issue(issues, `${unitPath}.armor`, "armorInstanceId и armorId");
        if (catalog?.armorIds && string(armor.armorId) && !armorKnownInCatalog(catalog, armor.armorId)) issue(issues, `${unitPath}.armor.armorId`, "известный armor id runtime-каталога");
        const definition = string(armor.armorId) ? armorDefinitionForId(catalog, armor.armorId) : undefined;
        if (catalog?.armorForId && string(armor.armorId) && !definition) issue(issues, `${unitPath}.armor.armorId`, "armor definition runtime-каталога");
        if (definition) {
          const expectedSlot = definition.slot;
          if (armorSlotInCatalog(catalog, armor.armorId) !== undefined && armorSlotInCatalog(catalog, armor.armorId) !== expectedSlot) issue(issues, `${unitPath}.armor.slot`, "slot совпадает с armor definition");
          if (definition.maxDurability !== undefined && armor.maxDurability !== definition.maxDurability) issue(issues, `${unitPath}.armor.maxDurability`, "maxDurability совпадает с armor definition");
          checkArmorReduction(armor.reduction, definition.reduction, `${unitPath}.armor.reduction`, issues);
        }
        if (!int(armor.durability) || !int(armor.maxDurability, 1) || armor.durability > armor.maxDurability) issue(issues, `${unitPath}.armor`, "корректная durability");
        if (unit.team === "player") {
          const linked = string(armor.armorInstanceId) ? byInstance.get(armor.armorInstanceId) : undefined;
          if (!linked) issue(issues, `${unitPath}.armor.armorInstanceId`, "ссылка на inventory equipment instance");
          else {
            if (linked.itemId !== armor.armorId) issue(issues, `${unitPath}.armor.armorId`, "совпадает с inventory equipment itemId");
            if (linked.slot !== "head" && linked.slot !== "torso") issue(issues, `${unitPath}.armor.armorInstanceId`, "ссылка на armor slot");
            if (definition && linked.slot !== definition.slot) issue(issues, `${unitPath}.armor.armorInstanceId`, "ссылка на armor definition slot");
            if (linked.durability !== armor.durability || linked.maxDurability !== armor.maxDurability) issue(issues, `${unitPath}.armor`, "durability синхронизирована с inventory");
          }
        }
      }
    }
  });
}
function catalogOf(options?: SaveValidationOptions): CampaignCatalog | undefined {
  if (options?.campaignCatalog) return options.campaignCatalog
  const missions = options?.campaignMissions
  if (!missions) return undefined
  return {
    catalogId: "test-catalog",
    missions,
    missionIds: new Set(missions.map((m) => m.id)),
    rewardIds: new Set(missions.map((m) => m.rewardId)),
    arenaIds: new Set(missions.map((m) => m.arenaId ?? m.mapId ?? m.id)),
    zoneIds: new Set(missions.map((m) => m.zoneId)),
    rewardIdForMission: (id) => missions.find((m) => m.id === id)?.rewardId,
    arenaIdForMission: (id) => {
      const mission = missions.find((m) => m.id === id)
      return mission?.arenaId ?? mission?.mapId ?? mission?.id
    },
  }
}
const progressKeys = ["id", "status", "victories", "firstRewardClaimed", "rewardId", "mapId", "arenaId"] as const;
const validMissionStatuses = new Set(["locked", "available", "active", "completed", "failed"]);
const checkProgressShape = (value: unknown, path: string, issues: SaveIssue[]) => {
  if (!record(value)) { issue(issues, path, "объект прогресса миссии"); return false; }
  if (!string(value.id) || !validMissionStatuses.has(value.status) || !int(value.victories) || typeof value.firstRewardClaimed !== "boolean" || !string(value.rewardId) || !string(value.mapId) || !string(value.arenaId)) issue(issues, path, "id/status/victories/firstRewardClaimed/rewardId/mapId/arenaId");
  return true;
};
const mirrorProgress = (left: Record<string, any>, right: Record<string, any>) => progressKeys.every((key) => left[key] === right[key]);

function validateCampaign(value: unknown, issues: SaveIssue[], catalog: CampaignCatalog | undefined, activeEncounterId: unknown, phase: unknown) {
  if (!record(value)) return issue(issues, "$.campaign", "объект кампании");
  if (!string(value.catalogId) || !screens.has(value.screen) || (value.activeMissionId !== null && !string(value.activeMissionId)) || (value.activeMapId !== null && !string(value.activeMapId))) issue(issues, "$.campaign", "корректное состояние кампании");
  // Terminal battle phases are represented only by the explicit reward/return screens.
  // Home and mission selection must always be inert player snapshots; otherwise a global
  // combat key could resume an enemy turn after navigation.
  if ((value.screen === "home" || value.screen === "mission-select") && phase !== "player") issue(issues, "$.phase", "home/mission-select допускают только player phase");
  if (value.screen === "mission" && phase !== "player" && phase !== "enemy") issue(issues, "$.phase", "mission допускает только player/enemy phase");
  if (value.screen === "reward" && phase !== "victory") issue(issues, "$.phase", "reward допускает только victory phase");
  if (value.screen === "return" && phase !== "defeat") issue(issues, "$.phase", "return допускает только defeat phase");
  if (!Array.isArray(value.encounters) || !record(value.mission)) issue(issues, "$.campaign", "mission и encounters");
  const entries = Array.isArray(value.encounters) ? value.encounters : [];
  entries.forEach((entry, index) => checkProgressShape(entry, `$.campaign.encounters[${index}]`, issues));
  const missionShape = checkProgressShape(value.mission, "$.campaign.mission", issues);
  if (!Array.isArray(value.claimedRewards) || value.claimedRewards.some((reward: unknown) => !string(reward))) issue(issues, "$.campaign.claimedRewards", "массив reward id");
  if (!catalog) return issue(issues, "$.campaign", "runtime campaign catalog is required");
  if (Array.isArray(value.claimedRewards) && value.claimedRewards.some((reward: unknown) => typeof reward !== "string" || !catalog.rewardIds.has(reward))) issue(issues, "$.campaign.claimedRewards", "массив известных reward id");
  if (!record(value.zone)) issue(issues, "$.campaign.zone", "объект зоны");
  else {
    if (!string(value.zone.id)) issue(issues, "$.campaign.zone.id", "непустой id зоны");
    if (catalog.zoneIds && string(value.zone.id) && !catalog.zoneIds.has(value.zone.id)) issue(issues, "$.campaign.zone.id", "известный id зоны runtime-каталога");
    if (value.zone.status !== "available" && value.zone.status !== "completed") issue(issues, "$.campaign.zone.status", "available | completed");
    const missionZoneIds = new Set(catalog.missions.map((mission) => mission.zoneId));
    if (string(value.zone.id) && !missionZoneIds.has(value.zone.id)) issue(issues, "$.campaign.zone.id", "зона присутствует в mission catalog");
  }
  if (typeof value.firstDeathReturnUsed !== "boolean") issue(issues, "$.campaign.firstDeathReturnUsed", "boolean");
  if (!finite(value.xp) || value.xp < 0) issue(issues, "$.campaign.xp", "конечное неотрицательное число");
  if (!catalog.zoneIds) {
    const expectedZone = catalog.missions[0]?.zoneId;
    if (record(value.zone) && string(expectedZone) && value.zone.id !== expectedZone) issue(issues, "$.campaign.zone.id", "id зоны из runtime mission catalog");
  }
  if (Array.isArray(value.encounters) && record(value.zone) && value.zone.status === "completed" && value.zone.id !== value.encounters.map((entry: unknown) => record(entry) ? catalog.missions.find((mission) => mission.id === entry.id)?.zoneId : undefined).find((zoneId): zoneId is string => Boolean(zoneId))) issue(issues, "$.campaign.zone.id", "зона соответствует encounter catalog");
  if (catalog.catalogId && value.catalogId !== catalog.catalogId) issue(issues, "$.campaign.catalogId", "неверный catalog id");

  const byId = new Map<string, Record<string, any>>();
  for (const [index, entry] of entries.entries()) {
    if (!record(entry)) continue;
    if (byId.has(entry.id)) issue(issues, `$.campaign.encounters[${index}].id`, "дублирующийся id миссии");
    byId.set(entry.id, entry);
    const expectedRewardId = catalog.rewardIdForMission(entry.id);
    const expectedArenaId = catalog.arenaIdForMission(entry.id);
    const expectedZoneId = catalog.missions.find((mission) => mission.id === entry.id)?.zoneId;
    if (!catalog.missionIds.has(entry.id) || entry.rewardId !== expectedRewardId || entry.mapId !== expectedArenaId || entry.arenaId !== expectedArenaId || (record(value.zone) && entry.id && expectedZoneId !== value.zone.id)) issue(issues, `$.campaign.encounters[${index}]`, "точная ссылка на каталог и текущую zone");
  }
  if (entries.length !== catalog.missions.length) issue(issues, "$.campaign.encounters", "точное покрытие каталога миссий");
  for (const definition of catalog.missions) {
    const entry = byId.get(definition.id);
    if (!entry) issue(issues, `$.campaign.encounters.${definition.id}`, "отсутствует миссия из каталога");
  }

  const orderedMissions = [...catalog.missions].sort((left, right) => left.order - right.order);
  const claimedRewards = Array.isArray(value.claimedRewards) ? value.claimedRewards.filter((reward): reward is string => typeof reward === "string") : [];
  const claimedRewardSet = new Set(claimedRewards);
  if (claimedRewardSet.size !== claimedRewards.length) issue(issues, "$.campaign.claimedRewards", "уникальные reward id");
  const pendingRewardMissionId = value.screen === "reward" && phase === "victory" && activeEncounterId === value.activeMissionId
    ? value.activeMissionId
    : null;

  for (const [index, definition] of orderedMissions.entries()) {
    const entry = byId.get(definition.id);
    if (!entry) continue;
    const path = `$.campaign.encounters[${entries.indexOf(entry)}]`;
    const rewardClaimed = claimedRewardSet.has(definition.rewardId);
    const pendingReward = pendingRewardMissionId === definition.id;
    if (index === 0 && entry.status === "locked") issue(issues, `${path}.status`, "первая encounter доступна изначально");
    if (entry.status !== "locked" && index > 0) {
      const prior = orderedMissions[index - 1];
      if (byId.get(prior.id)?.status !== "completed") issue(issues, `${path}.status`, "encounter открывается только после завершения предыдущей");
    }
    if (entry.victories > 0 && entry.status !== "completed") issue(issues, `${path}.status`, "завершённую encounter нельзя сбросить или переиграть");
    if (entry.status === "completed" && entry.victories < 1) issue(issues, `${path}.victories`, "completed encounter имеет победу");
    if (entry.status !== "completed" && entry.firstRewardClaimed) issue(issues, `${path}.firstRewardClaimed`, "награда отмечается только для completed encounter");
    if (entry.status === "completed" && !entry.firstRewardClaimed && !pendingReward) issue(issues, `${path}.firstRewardClaimed`, "completed encounter не теряет claim награды");
    if (rewardClaimed && (!entry.firstRewardClaimed || entry.status !== "completed")) issue(issues, `${path}.firstRewardClaimed`, "claimed reward соответствует completed encounter");
    if (entry.firstRewardClaimed && !rewardClaimed) issue(issues, `${path}.firstRewardClaimed`, "claim награды присутствует в campaign.claimedRewards");
  }
  for (const rewardId of claimedRewardSet) {
    const entry = orderedMissions.find((mission) => mission.rewardId === rewardId);
    if (!entry || byId.get(entry.id)?.status !== "completed" || byId.get(entry.id)?.firstRewardClaimed !== true) issue(issues, `$.campaign.claimedRewards.${rewardId}`, "reward принадлежит completed encounter");
  }
  if (value.zone?.status === "completed" && orderedMissions.some((definition) => byId.get(definition.id)?.status !== "completed")) issue(issues, "$.campaign.zone.status", "зона completed только после завершения всех encounter");

  const mission = value.mission;
  if (missionShape && record(mission)) {
    const matching = byId.get(mission.id);
    if (!matching) issue(issues, "$.campaign.mission", "matching encounter отсутствует");
    else if (!mirrorProgress(mission, matching)) issue(issues, "$.campaign.mission", "точная копия matching encounter");
    const expectedRewardId = catalog.rewardIdForMission(mission.id);
    const expectedArenaId = catalog.arenaIdForMission(mission.id);
    if (!string(mission.id) || !catalog.missionIds.has(mission.id)) issue(issues, "$.campaign.mission.id", "существующий id миссии в каталоге");
    if (mission.rewardId !== expectedRewardId) issue(issues, "$.campaign.mission.rewardId", "reward id из каталога");
    if (mission.mapId !== expectedArenaId || mission.arenaId !== expectedArenaId) issue(issues, "$.campaign.mission.mapId", "map/arena id из каталога");
    const rewardClaimed = Array.isArray(value.claimedRewards) && value.claimedRewards.includes(mission.rewardId);
    if (rewardClaimed !== mission.firstRewardClaimed) issue(issues, "$.campaign.mission.firstRewardClaimed", "согласованное состояние награды");
    if (mission.status !== "completed" && (mission.firstRewardClaimed || rewardClaimed)) issue(issues, "$.campaign.mission.status", "неполученная награда для незавершенной миссии");
    const activeScreen = value.screen === "mission" || value.screen === "reward" || value.screen === "return";
    const active = activeEncounterId === mission.id && value.activeMissionId === mission.id && value.activeMapId === expectedArenaId;
    if (activeScreen && !active) issue(issues, "$.campaign.mission", "активная миссия совпадает с текущей встречей");
    if (!activeScreen && (activeEncounterId !== null || value.activeMissionId !== null || value.activeMapId !== null)) issue(issues, "$.campaign.mission", "нет активной встречи вне миссии");
    if (value.screen === "mission" && (mission.status !== "active" || (phase !== "player" && phase !== "enemy"))) issue(issues, "$.campaign.mission.status", "active только во время миссии");
    if (value.screen === "reward" && (mission.status !== "completed" || phase !== "victory")) issue(issues, "$.campaign.mission.status", "completed только на экране награды");
    if (value.screen === "return" && (mission.status !== "failed" || phase !== "defeat")) issue(issues, "$.campaign.mission.status", "failed только при возврате после поражения");
    if ((value.screen === "home" || value.screen === "mission-select") && mission.status === "active") issue(issues, "$.campaign.mission.status", "active только во время миссии");
  }
}
export function validateSave(input: unknown, options?: CampaignCatalog | SaveValidationOptions): SaveResult {
  const normalized = options && "missions" in options && !("campaignCatalog" in options) ? { campaignCatalog: options as CampaignCatalog } : options as SaveValidationOptions | undefined;
  const issues: SaveIssue[] = []; if (!record(input)) { issue(issues, "$", "объект"); return { ok: false, error: new SaveValidationError("shape", issues) }; }
  if (input.schemaVersion !== SAVE_SCHEMA_VERSION) return { ok: false, error: new SaveValidationError("version", [{ path: "$.schemaVersion", message: "поддерживается только версия 4" }]) };
  if (!string(input.arenaId) || (input.activeEncounterId !== null && !string(input.activeEncounterId)) || !phases.has(input.phase) || !int(input.turn, 1) || !int(input.rngState) || !Array.isArray(input.units)) issue(issues, "$", "корректные поля сохранения");
  if (Array.isArray(input.units)) { const ids = new Set<string>(); input.units.forEach((u: unknown, i: number) => { checkUnit(u, `$.units[${i}]`, issues); if (record(u) && string(u.id)) ids.add(u.id) }); if (ids.size !== input.units.length || input.units.filter((u: any) => u?.id === "hero" && u?.team === "player").length !== 1) issue(issues, "$.units", "уникальные id и ровно один hero"); }
  const campaignCatalog = catalogOf(normalized);
  validateCampaign(input.campaign, issues, campaignCatalog, input.activeEncounterId, input.phase);
  checkInventory(input.inventory, issues, campaignCatalog);
  checkEquipmentLinks(input.units, input.inventory, issues, campaignCatalog);
  if (!isValidBase(input.base)) issue(issues, "$.base", "валидная база");
  const c = input.campaign as any; const active = input.activeEncounterId; const expectedMap = active && campaignCatalog?.arenaIdForMission(active) || (active ? c?.mission?.mapId : null);
  if (active === null && c?.activeMissionId !== null) issue(issues, "$.activeEncounterId", "совпадает с activeMissionId");
  if (active !== null && (!c || c.activeMissionId !== active || c.activeMapId !== input.arenaId || (expectedMap && expectedMap !== input.arenaId))) issue(issues, "$.activeEncounterId", "согласованная активная арена и карта");
  if (active === null && c?.activeMapId !== null) issue(issues, "$.campaign.activeMapId", "null без активной встречи");
  if (issues.length) return { ok: false, error: new SaveValidationError("shape", issues) };
  try {
    return { ok: true, value: structuredClone(input) as SaveData };
  } catch {
    return { ok: false, error: new SaveValidationError("shape", [{ path: "$", message: "сохранение содержит неподдерживаемые значения" }]) };
  }
}
function normalizeV4(raw: any, catalog?: CampaignCatalog): any {
  if (!catalog) return raw
  const screen = raw.campaign?.screen
  const activeState = screen === "mission" || screen === "reward" || screen === "return"
  const rawActiveId = raw.activeEncounterId ?? raw.campaign?.activeMissionId
  const rawMissionId = raw.campaign?.mission?.id
  const activeEncounterId = activeState ? (rawActiveId ?? (typeof rawMissionId === "string" ? rawMissionId : null)) : null
  const arenaFor = (id: unknown) => typeof id === "string" ? catalog.arenaIdForMission(id) : undefined
  const map = activeEncounterId ? (arenaFor(activeEncounterId) ?? raw.arenaId) : raw.arenaId
  const normalizeProgress = (entry: any) => {
    if (!entry || typeof entry !== "object") return entry
    const expectedMap = arenaFor(entry.id)
    return { ...entry, mapId: expectedMap ?? entry.mapId, arenaId: expectedMap ?? entry.arenaId ?? entry.mapId, rewardId: catalog.rewardIdForMission(entry.id) ?? entry.rewardId }
  }
  const rawCampaign = raw.campaign
  const campaign = rawCampaign ? {
    ...rawCampaign,
    catalogId: rawCampaign.catalogId ?? catalog.catalogId,
    activeMissionId: activeEncounterId,
    activeMapId: activeEncounterId ? map : null,
    mission: normalizeProgress(rawCampaign.mission),
    encounters: Array.isArray(rawCampaign.encounters) ? rawCampaign.encounters.map(normalizeProgress) : rawCampaign.encounters,
  } : rawCampaign
  return { ...raw, schemaVersion: 4, arenaId: map, activeEncounterId, campaign }
}
export function migrateSave(input: unknown, _fallbackArenaId?: string, options?: CampaignCatalog | SaveValidationOptions): SaveResult { if (!record(input)) return { ok: false, error: new SaveValidationError("shape", [{ path: "$", message: "объект" }]) }; const normalized = options && "missions" in options && !("campaignCatalog" in options) ? { campaignCatalog: options as CampaignCatalog } : options as SaveValidationOptions | undefined; if (input.schemaVersion === 4) return validateSave(input, normalized); if (input.schemaVersion !== 3) return validateSave(input, normalized); const catalog = catalogOf(normalized); if (!catalog) return { ok: false, error: new SaveValidationError("shape", [{ path: "$.campaign", message: "migration requires a validated campaign catalog" }]) }; return validateSave(normalizeV4(input, catalog), normalized); }
export const serializeSave = (save: SaveData) => JSON.stringify(save);
export function deserializeSave(raw: string, options?: CampaignCatalog | SaveValidationOptions): SaveResult { try { return migrateSave(JSON.parse(raw), undefined, options); } catch { return { ok: false, error: new SaveValidationError("parse", [{ path: "$", message: "некорректный JSON" }]) }; } }
export function defaultSave(arenaId: string, units: Unit[], equipmentOrCatalog?: EquipmentInstance[] | CampaignCatalog, missions?: readonly CampaignMission[], equipmentCatalog?: EquipmentCatalog): SaveData {
  const catalog = Array.isArray(equipmentOrCatalog) ? undefined : equipmentOrCatalog
  const suppliedEquipment = Array.isArray(equipmentOrCatalog) ? equipmentOrCatalog : []
  const campaignMissions = missions ?? catalog?.missions
  if (!campaignMissions?.length) throw new Error("Campaign catalog is required to create a save.")
  const campaign = createCampaign(campaignMissions, catalog?.catalogId ?? "test-catalog")
  const sourceUnits = structuredClone(units).map((unit) => ({ ...unit, statuses: unit.statuses ?? {} }))
  const weaponForId = (id: string) => equipmentCatalog?.weapons.find((definition) => definition.id === id) ?? catalog?.weaponForId?.(id)
  const armorSlotForId = (id: string) => {
    const direct = equipmentCatalog?.armor.find((definition) => definition.id === id) ?? catalog?.armorForId?.(id)
    if (direct) return direct.slot
    const parts = id.split("+").map((part) => equipmentCatalog?.armor.find((definition) => definition.id === part) ?? catalog?.armorForId?.(part))
    return parts.length > 0 && parts.every(Boolean) && parts.every((definition) => definition!.slot === parts[0]!.slot) ? parts[0]!.slot : catalog?.armorSlotForId?.(id)
  }
  const armorMaxDurabilityForId = (id: string) => {
    const definitions = id.split("+").map((part) => equipmentCatalog?.armor.find((definition) => definition.id === part) ?? catalog?.armorForId?.(part))
    return definitions.length > 0 && definitions.every((definition) => definition?.maxDurability !== undefined) ? definitions.reduce((sum, definition) => sum + definition!.maxDurability!, 0) : undefined
  }
  const linked: EquipmentInstance[] = []
  for (const unit of sourceUnits.filter((candidate) => candidate.team === "player")) {
    if (unit.weaponState) {
      const definition = weaponForId(unit.weaponState.weaponId)
       linked.push({ instanceId: unit.weaponState.weaponInstanceId, itemId: definition?.id ?? unit.weaponState.weaponId, slot: "primary", ...unit.weaponState })
    }
    if (unit.armor?.armorInstanceId && unit.armor.armorId) {
      const knownInstance = suppliedEquipment.find((entry) => entry.instanceId === unit.armor!.armorInstanceId)
      const slotCandidate = armorSlotForId(unit.armor.armorId) ?? knownInstance?.slot ?? (unit.armor.reduction.head !== undefined ? "head" : "torso")
      const slot: EquipmentSlot = isEquipmentSlot(slotCandidate) ? slotCandidate : (unit.armor.reduction.head !== undefined ? "head" : "torso")
      linked.push({ instanceId: unit.armor.armorInstanceId, itemId: unit.armor.armorId, slot, durability: unit.armor.durability, maxDurability: armorMaxDurabilityForId(unit.armor.armorId) ?? unit.armor.maxDurability })
    }
  }
  const equipment = suppliedEquipment.map((entry) => {
    const linkedEntry = linked.find((candidate) => candidate.instanceId === entry.instanceId)
    return linkedEntry ? { ...entry, ...linkedEntry } : entry
  }).concat(linked.filter((link) => !suppliedEquipment.some((entry) => entry.instanceId === link.instanceId)))
  const inventory = createInventory(20, equipment)
  const runtimeEquipment: EquipmentCatalog | undefined = equipmentCatalog ?? (catalog?.weaponForId || catalog?.armorForId ? {
    weapons: [...(catalog?.weaponIds ?? [])].map((id) => catalog!.weaponForId?.(id)).filter((definition): definition is WeaponDefinition => Boolean(definition)),
    ammo: [...(catalog?.ammoIds ?? [])].map((id) => ({ id, name: id, ...(catalog!.ammoForId?.(id) ?? { damageModifier: 0, penetrationModifier: 0 }) })),
    armor: [...(catalog?.armorIds ?? [])].map((id) => catalog!.armorForId?.(id)).filter((definition): definition is ArmorDefinition => Boolean(definition)),
    enemies: [],
  } : undefined)
  const hydratedUnits = runtimeEquipment ? hydrateArenaUnits({ units: sourceUnits }, runtimeEquipment, inventory, sourceUnits) : sourceUnits
  const synchronizedInventory: Inventory = {
    ...inventory,
    equipment: inventory.equipment.map((entry) => {
      const weapon = hydratedUnits.find((unit) => unit.weaponState?.weaponInstanceId === entry.instanceId)?.weaponState
      return weapon ? {
        ...entry,
        itemId: weapon.weaponId,
        ...(weapon.ammoId === undefined ? {} : { ammoId: weapon.ammoId }),
        ...(weapon.name === undefined ? {} : { name: weapon.name }),
        ...(weapon.baseDamage === undefined ? {} : { baseDamage: weapon.baseDamage }),
        ...(weapon.accuracyModifier === undefined ? {} : { accuracyModifier: weapon.accuracyModifier }),
        ...(weapon.critModifier === undefined ? {} : { critModifier: weapon.critModifier }),
        ...(weapon.penetration === undefined ? {} : { penetration: weapon.penetration }),
        ...(weapon.damageModifier === undefined ? {} : { damageModifier: weapon.damageModifier }),
        ...(weapon.penetrationModifier === undefined ? {} : { penetrationModifier: weapon.penetrationModifier }),
        ...(weapon.ammoDamageModifier === undefined ? {} : { ammoDamageModifier: weapon.ammoDamageModifier }),
        ...(weapon.ammoPenetrationModifier === undefined ? {} : { ammoPenetrationModifier: weapon.ammoPenetrationModifier }),
        magazine: weapon.magazine,
        magazineSize: weapon.magazineSize,
        reserveAmmo: weapon.reserveAmmo,
        durability: weapon.durability,
        maxDurability: weapon.maxDurability,
        ...(weapon.durabilityPerShot === undefined ? {} : { durabilityPerShot: weapon.durabilityPerShot }),
        ...(weapon.reloadAp === undefined ? {} : { reloadAp: weapon.reloadAp }),
        ...(weapon.makeshift === undefined ? {} : { makeshift: weapon.makeshift }),
        ...(weapon.malfunctioned === undefined ? {} : { malfunctioned: weapon.malfunctioned }),
      } : entry
    }),
  }
  return { schemaVersion: 4, arenaId, activeEncounterId: null, phase: "player", turn: 1, rngState: DEFAULT_RNG_STATE, units: hydratedUnits, campaign, inventory: synchronizedInventory, base: defaultBase() };
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const createMemoryStorage = (initial: Record<string, string> = {}): StorageLike => { const data = new Map(Object.entries(initial)); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) }; };
export type SaveWriteResult = { ok: boolean; error?: string }
export interface SaveAdapter { save(save: SaveData): boolean; saveDetailed(save: SaveData): SaveWriteResult; load(fallbackArenaId?: string, options?: CampaignCatalog | SaveValidationOptions): SaveResult | null; backupCorrupt(): boolean; reset(): boolean; setValidationOptions(options: CampaignCatalog | SaveValidationOptions): void }
export function createLocalStorageAdapter(storage?: StorageLike | null, initialOptions?: CampaignCatalog | SaveValidationOptions): SaveAdapter { const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage; let options = initialOptions; const detailed = (save: SaveData): SaveWriteResult => { if (!target) return { ok: false, error: "storage unavailable" }; const checked = validateSave(save, options); if (!checked.ok) return { ok: false, error: checked.error.message }; try { target.setItem(SAVE_STORAGE_KEY, serializeSave(checked.value)); return { ok: true }; } catch { return { ok: false, error: "storage unavailable" }; } }; return { save: s => detailed(s).ok, saveDetailed: detailed, load: (_fallback, loadOptions) => { if (!target) return { ok: false, error: new SaveValidationError("parse", [{ path: "$", message: "storage unavailable" }]) }; const raw = target.getItem(SAVE_STORAGE_KEY); if (raw === null) return null; return deserializeSave(raw, loadOptions ?? options)!; }, setValidationOptions: nextOptions => { options = nextOptions }, backupCorrupt: () => { if (!target) return false; const raw = target.getItem(SAVE_STORAGE_KEY); if (raw === null) return false; try { target.setItem(SAVE_BACKUP_KEY, raw); return true; } catch { return false; } }, reset: () => { if (!target) return false; try { target.removeItem(SAVE_STORAGE_KEY); return true; } catch { return false; } } };
}
