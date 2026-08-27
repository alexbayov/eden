/* eslint-disable @typescript-eslint/no-explicit-any */
import { AP_MAX, type Posture, type Statuses, type Unit } from "./combat";
import { isOverwatchState } from "./combat-overwatch";
import { createCampaign, orderedCampaignMissions, type CampaignMission, type CampaignState } from "./campaign";
import { defaultBase, isValidBase, type BaseState } from "./base";
import { createInventory, isEquipmentSlot, isResourceId, type EquipmentInstance, type EquipmentSlot, type Inventory } from "./inventory";
import { DEFAULT_RNG_STATE } from "./rng";
import { hydrateArenaUnits, type ArmorDefinition, type EquipmentCatalog, type WeaponDefinition } from "./equipment-content";
import { DEFAULT_LEVEL_CURVE, characterForXp, levelForXp, maxLevel, skillPointsGranted, type CharacterState, type LevelCurve } from "./progression";
import { initialObjectiveState, isObjectiveState, type ObjectiveState } from "./objective";
import { isZoneLadder, isZoneLadderReachable } from "./zone-progress";

export const SAVE_SCHEMA_VERSION = 7;
export const SAVE_STORAGE_KEY = "eden.save.v7";
export const SAVE_BACKUP_KEY = "eden.save.v7.corrupt-backup";
/**
 * Keys written by earlier schema versions, newest first. Read-only: the adapter falls back to them
 * when the current key is empty, migrates what it finds and writes the result under the current
 * key. Without this, bumping the key would make every existing player's save invisible and start
 * them at a fresh campaign — the exact failure W4-05 criterion 6 exists to catch. The old key is
 * left in place rather than deleted, so a failed upgrade is recoverable by downgrading.
 */
export const LEGACY_SAVE_STORAGE_KEYS = ["eden.save.v6", "eden.save.v5", "eden.save.v4"] as const;
export type BattlePhase = "player" | "enemy" | "victory" | "defeat";
export interface SaveData {
  schemaVersion: 7;
  arenaId: string;
  activeEncounterId: string | null;
  phase: BattlePhase;
  turn: number;
  rngState: number;
  units: Unit[];
  campaign: CampaignState;
  character: CharacterState;
  inventory: Inventory;
  base: BaseState;
  /**
   * W6-01 — the only objective facts the board cannot reproduce: consecutive held turns, and whether
   * the objective item has been picked up.
   *
   * Everything else an objective needs — enemies alive, hero position, turn number — is already in
   * this save, and copying it here would create a second source of truth that can drift from `units`.
   */
  objective: ObjectiveState;
}
export interface SaveIssue { path: string; message: string }
export interface CampaignCatalog { catalogId?: string; missions: readonly CampaignMission[]; missionIds: ReadonlySet<string>; rewardIds: ReadonlySet<string>; arenaIds: ReadonlySet<string>; zoneIds?: ReadonlySet<string>; itemIds?: ReadonlySet<string>; itemWeightForId?: (itemId: string) => number | undefined; weaponIds?: ReadonlySet<string>; weaponForId?: (weaponId: string) => WeaponDefinition | undefined; armorIds?: ReadonlySet<string>; armorSlotForId?: (itemId: string) => string | undefined; armorForId?: (armorId: string) => ArmorDefinition | undefined; ammoIds?: ReadonlySet<string>; ammoForId?: (ammoId: string) => { damageModifier: number; penetrationModifier: number } | undefined; /** Level curve the save's `character` block is validated against; defaults to the shipped curve. */ progression?: LevelCurve; rewardIdForMission: (missionId: string) => string | undefined; arenaIdForMission: (missionId: string) => string | undefined }
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
  /**
   * W6-04 — `overwatch` was **not validated at all** before this ticket.
   *
   * `grep overwatch src/game/save.ts` returned nothing, and every one of these loaded cleanly:
   * `reservedAp: 9999`, `-5`, `1.5`, `'lots'`, `{}`, and a block attached to an enemy unit. The first is a
   * free reaction far stronger than the game can grant, the string would flow into `combatAttack`'s AP
   * comparison, and an enemy carrying the block is a state no transition produces — enemy Overwatch does not
   * exist (explicitly out of scope in W6-04).
   *
   * Bounded by `AP_MAX` rather than `AP_PER_TURN` because `startTurn` can grant up to 15 AP, so a legitimate
   * reserve can exceed the nominal 10.
   */
  if (value.overwatch !== undefined) {
    if (value.team !== "player") issue(issues, `${path}.overwatch`, "только у игрока");
    else if (!isOverwatchState(value.overwatch, AP_MAX)) issue(issues, `${path}.overwatch`, `{ reservedAp: 0..${AP_MAX} }`);
  }
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
/**
 * Versions this module can validate. v5 is the current schema; v4 is validated **only** as the
 * source of a migration, which is what doc 23 §5.3 rule 4 demands ("невалидный источник
 * отклоняется до миграции"). Everything the two share is one code path; the two fields that differ
 * (`character`, `campaign.returnReason`) are gated on the version rather than duplicated.
 */
export type SupportedSchemaVersion = 4 | 5 | 6 | 7;
const progressKeys = ["id", "status", "victories", "firstRewardClaimed", "rewardId", "mapId", "arenaId"] as const;
const validMissionStatuses = new Set(["locked", "available", "active", "completed", "failed"]);
const checkProgressShape = (value: unknown, path: string, issues: SaveIssue[]) => {
  if (!record(value)) { issue(issues, path, "объект прогресса миссии"); return false; }
  if (!string(value.id) || !validMissionStatuses.has(value.status) || !int(value.victories) || typeof value.firstRewardClaimed !== "boolean" || !string(value.rewardId) || !string(value.mapId) || !string(value.arenaId)) issue(issues, path, "id/status/victories/firstRewardClaimed/rewardId/mapId/arenaId");
  return true;
};
const mirrorProgress = (left: Record<string, any>, right: Record<string, any>) => progressKeys.every((key) => left[key] === right[key]);

function validateCampaign(value: unknown, issues: SaveIssue[], catalog: CampaignCatalog | undefined, activeEncounterId: unknown, phase: unknown, version: SupportedSchemaVersion) {
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
  // W4-02: the return screen must say *why* it was reached, because the XP penalty is charged on
  // leaving it and a defeat costs what a retreat does not. A reason outside the return screen would
  // be a stale value the penalty could later read. A v4 source predates the field entirely, so it
  // is not required there — the migration supplies it.
  if (version >= 5 && (value.screen === "return" ? value.returnReason !== "defeat" && value.returnReason !== "retreat" : value.returnReason !== null)) issue(issues, "$.campaign.returnReason", "defeat | retreat на экране return и null вне него");
  if (!finite(value.xp) || value.xp < 0) issue(issues, "$.campaign.xp", "конечное неотрицательное число");
  if (!catalog.zoneIds) {
    const expectedZone = catalog.missions[0]?.zoneId;
    if (record(value.zone) && string(expectedZone) && value.zone.id !== expectedZone) issue(issues, "$.campaign.zone.id", "id зоны из runtime mission catalog");
  }
  /*
   * A `completed` active zone must name a zone the encounter catalog actually knows.
   *
   * It used to be compared against the zone of the **first** entry in `campaign.encounters`, which silently meant "a
   * finished campaign is always in zone one". True with one shipped zone, and wrong for every later zone: finishing the
   * campaign in the last zone was rejected as malformed. Membership is the real rule — *which* zone may be completed is
   * already decided by the ladder checks (`$.campaign.zones`), which enforce order and agreement with `zone`.
   */
  if (Array.isArray(value.encounters) && record(value.zone) && value.zone.status === "completed") {
    const catalogZoneIds = new Set(catalog.missions.map((mission) => mission.zoneId));
    if (string(value.zone.id) && !catalogZoneIds.has(value.zone.id)) issue(issues, "$.campaign.zone.id", "зона соответствует encounter catalog");
  }
  if (catalog.catalogId && value.catalogId !== catalog.catalogId) issue(issues, "$.campaign.catalogId", "неверный catalog id");

  const byId = new Map<string, Record<string, any>>();
  for (const [index, entry] of entries.entries()) {
    if (!record(entry)) continue;
    if (byId.has(entry.id)) issue(issues, `$.campaign.encounters[${index}].id`, "дублирующийся id миссии");
    byId.set(entry.id, entry);
    const expectedRewardId = catalog.rewardIdForMission(entry.id);
    const expectedArenaId = catalog.arenaIdForMission(entry.id);
    /*
     * W7-01/D-03 — an encounter must reference its catalog exactly, and that is *all* this check asserts.
     *
     * It used to additionally require every stored encounter's zone to equal the **active** `zone.id`. That was
     * indistinguishable from correct while the build shipped one zone, and it made a second zone unrepresentable:
     * `campaign.encounters` covers the whole catalog (asserted just below), so as soon as two zones exist some
     * encounter necessarily belongs to a zone the player is not standing in. The active zone is still validated —
     * against the zone *ladder*, which is the thing that actually knows which zone is current — near
     * `$.campaign.zone`. Conflating the two questions here is what hid that.
     */
    if (!catalog.missionIds.has(entry.id) || entry.rewardId !== expectedRewardId || entry.mapId !== expectedArenaId || entry.arenaId !== expectedArenaId) issue(issues, `$.campaign.encounters[${index}]`, "точная ссылка на каталог");
  }
  if (entries.length !== catalog.missions.length) issue(issues, "$.campaign.encounters", "точное покрытие каталога миссий");
  for (const definition of catalog.missions) {
    const entry = byId.get(definition.id);
    if (!entry) issue(issues, `$.campaign.encounters.${definition.id}`, "отсутствует миссия из каталога");
  }

  /* The *same* sequence rule the campaign uses (`orderedCampaignMissions`), not a copy of it: this loop decides
     which encounter may be unlocked, so a validator that ordered missions differently from the game would reject
     saves the game itself produces. With one zone it is still `order` alone. */
  const orderedMissions = orderedCampaignMissions(catalog.missions);
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
/**
 * W4-05 — the v5 `character` block, validated against the **progression catalog**, not against
 * itself. `level` and `unspentSkillPoints` are derived values, so a save is only consistent if the
 * curve agrees: `level === levelForXp(xp)` and the points never exceed what those levels granted.
 * That closes the obvious hand-edit (level 6 on 0 XP) and, more importantly, makes a curve change
 * a detectable save inconsistency instead of a silently wrong level on the base screen.
 *
 * `character.xp` must equal `campaign.xp`. XP has one home; the mirror exists because progression
 * reads `character` while every existing reward/validation rule reads `campaign.xp`, and two fields
 * that may disagree are exactly the class of bug doc 23 §5.3 rule 1 forbids.
 */
function checkCharacter(value: unknown, campaign: unknown, issues: SaveIssue[], curve: LevelCurve) {
  if (!record(value)) return issue(issues, "$.character", "объект персонажа");
  if (!int(value.xp)) issue(issues, "$.character.xp", "неотрицательное целое");
  if (!int(value.level, 1) || value.level > maxLevel(curve)) issue(issues, "$.character.level", `целое 1..${maxLevel(curve)}`);
  if (!int(value.unspentSkillPoints)) issue(issues, "$.character.unspentSkillPoints", "неотрицательное целое");
  if (!int(value.xp) || !int(value.level, 1)) return;
  if (record(campaign) && finite(campaign.xp) && campaign.xp !== value.xp) issue(issues, "$.character.xp", "совпадает с campaign.xp");
  if (value.level !== levelForXp(value.xp, curve)) issue(issues, "$.character.level", "уровень соответствует xp по кривой прогрессии");
  if (int(value.unspentSkillPoints) && value.unspentSkillPoints > skillPointsGranted(value.level, curve)) issue(issues, "$.character.unspentSkillPoints", "не больше начисленных за достигнутые уровни");
}
export function validateSave(input: unknown, options?: CampaignCatalog | SaveValidationOptions): SaveResult {
  return validateVersioned(input, SAVE_SCHEMA_VERSION, options);
}
/**
 * The shared validation body. `expected` is the version being validated, so a v4 payload can be
 * checked *as a v4 payload* before migration without weakening any rule the two versions share.
 */
function validateVersioned(input: unknown, expected: SupportedSchemaVersion, options?: CampaignCatalog | SaveValidationOptions): SaveResult {
  const normalized = options && "missions" in options && !("campaignCatalog" in options) ? { campaignCatalog: options as CampaignCatalog } : options as SaveValidationOptions | undefined;
  const issues: SaveIssue[] = []; if (!record(input)) { issue(issues, "$", "объект"); return { ok: false, error: new SaveValidationError("shape", issues) }; }
  if (input.schemaVersion !== expected) return { ok: false, error: new SaveValidationError("version", [{ path: "$.schemaVersion", message: `поддерживается только версия ${expected}` }]) };
  if (!string(input.arenaId) || (input.activeEncounterId !== null && !string(input.activeEncounterId)) || !phases.has(input.phase) || !int(input.turn, 1) || !int(input.rngState) || !Array.isArray(input.units)) issue(issues, "$", "корректные поля сохранения");
  if (Array.isArray(input.units)) { const ids = new Set<string>(); input.units.forEach((u: unknown, i: number) => { checkUnit(u, `$.units[${i}]`, issues); if (record(u) && string(u.id)) ids.add(u.id) }); if (ids.size !== input.units.length || input.units.filter((u: any) => u?.id === "hero" && u?.team === "player").length !== 1) issue(issues, "$.units", "уникальные id и ровно один hero"); }
  const campaignCatalog = catalogOf(normalized);
  validateCampaign(input.campaign, issues, campaignCatalog, input.activeEncounterId, input.phase, expected);
  if (expected >= 5) checkCharacter(input.character, input.campaign, issues, campaignCatalog?.progression ?? DEFAULT_LEVEL_CURVE);
  /**
   * W6-01 — objective state, from v6.
   *
   * Validated even though both fields have safe defaults, because a hand-edited `heldTurns` is a free
   * mission completion: `evaluateObjective` compares it against `holdTurns` and does not re-derive it
   * from the board. The state is also required to be *inert* outside an active mission — a save sitting
   * on the home screen carrying `carrying: true` would hand the player a delivered objective the moment
   * the next retrieval mission starts.
   */
  /**
   * W6-04 — Overwatch cannot exist outside an active mission.
   *
   * A block on the home screen was accepted before this ticket, which would arm a reaction on a screen where
   * Overwatch cannot be activated and where no enemy phase runs. `runEnemyTurn` clears it at the end of every
   * phase, so a persisted block anywhere but a live mission is a state the game does not produce.
   */
  if (record(input.campaign) && input.campaign.screen !== "mission" && Array.isArray(input.units))
    input.units.forEach((unit: unknown, index: number) => {
      if (record(unit) && unit.overwatch !== undefined)
        issue(issues, `$.units[${index}].overwatch`, "только в активной миссии");
    });
  /**
   * W7-01 — the zone ladder, from v7.
   *
   * Validated rather than trusted for the same reason `overwatch` is: a hand-edited ladder is a skipped campaign. The
   * reachability check refuses a payload where a later zone is `available` while an earlier one is still `locked`,
   * and the agreement check refuses one where `zone` names a different zone than the ladder's available entry —
   * because every screen reads `zone` while unlocking reads `zones`, so a mismatch would show the player one zone
   * and let them play another.
   */
  if (expected >= 7 && record(input.campaign)) {
    const campaign = input.campaign as Record<string, any>;
    if (!isZoneLadder(campaign.zones)) issue(issues, "$.campaign.zones", "непустой список зон с уникальным order");
    else if (!isZoneLadderReachable(campaign.zones))
      issue(issues, "$.campaign.zones", "достижимая последовательность: completed, затем available, затем locked");
    else {
      const active = campaign.zones.find((zone: { status: string }) => zone.status === "available");
      const declared = record(campaign.zone) ? campaign.zone : undefined;
      if (active && declared && declared.id !== active.id)
        issue(issues, "$.campaign.zone", "совпадает с доступной зоной в zones");
      /* No available zone means the campaign is finished, and `zone` must say so rather than staying open. */
      if (!active && declared && declared.status !== "completed")
        issue(issues, "$.campaign.zone", "completed, когда все зоны пройдены");
    }
  }
  if (expected >= 6) {
    if (!isObjectiveState(input.objective)) issue(issues, "$.objective", "heldTurns >= 0 и carrying");
    else if (record(input.campaign) && input.campaign.screen !== "mission" && (input.objective.heldTurns !== 0 || input.objective.carrying))
      issue(issues, "$.objective", "сброшено вне активной миссии");
  }
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
/**
 * v4 → v5 (W4-05). Adds exactly two things and changes nothing else, per doc 23 §5.3 rule 1:
 *
 * | v4                  | v5                            | rule                                  | default            |
 * |---------------------|-------------------------------|---------------------------------------|--------------------|
 * | `campaign.xp`       | `campaign.xp`                 | unchanged                             | —                  |
 * | —                   | `character.xp`                | mirrors `campaign.xp`                 | `campaign.xp`      |
 * | —                   | `character.level`             | derived from the curve                | `levelForXp(xp)`   |
 * | —                   | `character.unspentSkillPoints`| everything the reached levels granted | `skillPointsGranted(level)` |
 * | —                   | `campaign.returnReason`       | `'retreat'` on the return screen, else `null` | see below  |
 *
 * Why `'retreat'` and not `'defeat'` for a migrated return screen. In v4 a retreat *was* a defeat,
 * so the payload genuinely does not record which happened, and both produced `phase: 'defeat'`.
 * Guessing `'defeat'` would charge an XP penalty for a state the player entered before the penalty
 * existed — a retroactive punishment for upgrading. Guessing `'retreat'` costs at most one skipped
 * penalty, once, on a save that is mid-return at the moment of the upgrade, and cannot be repeated
 * because every later return records its own reason. The ambiguity is resolved in the player's
 * favour and named here rather than left implicit.
 *
 * `unspentSkillPoints` is granted rather than zeroed: the levels were earned under the old save, and
 * nothing spends points until W4-03, so zeroing them would silently delete earned progression the
 * first time the spending UI ships.
 */
function normalizeV5(raw: any, curve: LevelCurve): any {
  const campaign = record(raw.campaign) ? raw.campaign : undefined;
  const xp = campaign && finite(campaign.xp) && campaign.xp >= 0 ? Math.floor(campaign.xp) : 0;
  return {
    ...raw,
    schemaVersion: 5,
    character: characterForXp(xp, curve),
    ...(campaign ? { campaign: { ...campaign, xp, returnReason: campaign.screen === "return" ? "retreat" : null } } : {}),
  };
}
/**
 * v5 → v6 (W6-01). Adds exactly one field and changes nothing else, per doc 23 §5.3 rule 1:
 *
 * | v5 | v6          | rule                                            | default                    |
 * |----|-------------|-------------------------------------------------|----------------------------|
 * | —  | `objective` | fresh state; mid-mission progress is not invented | `{ heldTurns: 0, carrying: false }` |
 *
 * Why a *fresh* state rather than a guess, even for a save caught mid-mission. A v5 payload predates
 * objectives entirely: every shipped mission was resolved by clearing the map, so there is no held-turn
 * count or pickup flag to recover — the information was never recorded. Zeroing is also the only choice
 * that cannot *give* anything away: inventing `carrying: true` would hand out a delivered objective, and
 * inventing `heldTurns` would hand out mission completion. The cost is bounded and one-off — a player
 * mid-`secure` at the moment of the upgrade re-holds the point — and it is paid in the direction that
 * cannot be exploited.
 */
function normalizeV6(raw: any): any {
  return { ...raw, schemaVersion: 6, objective: initialObjectiveState() };
}
/**
 * v6 → v7 (W7-01). Adds exactly one field and rewrites none:
 *
 * | v6 | v7               | rule                                              | default |
 * |----|------------------|---------------------------------------------------|---------|
 * | —  | `campaign.zones` | ladder rebuilt from the encounters already stored  | see below |
 *
 * **Why the ladder is rebuilt rather than defaulted to "first zone available".** A v6 save can be mid-campaign with
 * every encounter of its only zone completed, and defaulting would reopen a zone the player had finished. The
 * encounters carry the answer: a zone whose missions are all `completed` is `completed`, the first zone that is not
 * is `available`, and anything after it is `locked`. That reads progress the player actually made instead of
 * guessing.
 *
 * Since v6 shipped with exactly one zone, in practice this produces a one-entry ladder — but the rule is written for
 * the general case so a v6 save from a build with more zones would still migrate correctly.
 */
function normalizeV7(raw: any): any {
  const campaign = record(raw.campaign) ? raw.campaign : undefined;
  if (!campaign) return { ...raw, schemaVersion: 7 };
  const encounters: any[] = Array.isArray(campaign.encounters) ? campaign.encounters : [];
  /* v6 has no per-encounter zone id, so the single stored zone owns every encounter — which is exactly the shape v6
     could express. */
  const zoneId = record(campaign.zone) && string(campaign.zone.id) ? campaign.zone.id : "unknown-zone";
  const cleared = encounters.length > 0 && encounters.every((entry) => entry?.status === "completed");
  return {
    ...raw,
    schemaVersion: 7,
    campaign: {
      ...campaign,
      zones: [{ id: zoneId, order: 1, status: cleared ? "completed" : "available" }],
      /* Kept in step with the ladder, since the validator now requires the two to agree. */
      zone: { id: zoneId, status: cleared ? "completed" : "available" },
    },
  };
}
/**
 * Forward-only migration with the invalid source rejected **before** any field is rewritten:
 * each stage is validated by the rules its own version had, so a save either upgrades cleanly or fails
 * with the offending stage's issue list. The chain is explicit rather than silent — v3 → v4 → v5 → v6 —
 * which is what keeps a two-version-old save from being rewritten by rules it never satisfied.
 */
export function migrateSave(input: unknown, _fallbackArenaId?: string, options?: CampaignCatalog | SaveValidationOptions): SaveResult {
  if (!record(input)) return { ok: false, error: new SaveValidationError("shape", [{ path: "$", message: "объект" }]) };
  const normalized = options && "missions" in options && !("campaignCatalog" in options) ? { campaignCatalog: options as CampaignCatalog } : options as SaveValidationOptions | undefined;
  if (input.schemaVersion === SAVE_SCHEMA_VERSION) return validateSave(input, normalized);
  if (input.schemaVersion !== 6 && input.schemaVersion !== 5 && input.schemaVersion !== 4 && input.schemaVersion !== 3)
    return validateSave(input, normalized);
  const catalog = catalogOf(normalized);
  if (!catalog) return { ok: false, error: new SaveValidationError("shape", [{ path: "$.campaign", message: "migration requires a validated campaign catalog" }]) };
  const curve = catalog.progression ?? DEFAULT_LEVEL_CURVE;
  /* Each source skips the stages it is already past. */
  if (input.schemaVersion === 6) {
    const checkedV6 = validateVersioned(input, 6, normalized);
    return checkedV6.ok ? validateSave(normalizeV7(checkedV6.value), normalized) : checkedV6;
  }
  if (input.schemaVersion === 5) {
    const checkedV5 = validateVersioned(input, 5, normalized);
    if (!checkedV5.ok) return checkedV5;
    const v6 = validateVersioned(normalizeV6(checkedV5.value), 6, normalized);
    return v6.ok ? validateSave(normalizeV7(v6.value), normalized) : v6;
  }
  const v4 = input.schemaVersion === 3 ? normalizeV4(input, catalog) : input;
  const checked = validateVersioned(v4, 4, normalized);
  if (!checked.ok) return checked;
  const v5 = validateVersioned(normalizeV5(checked.value, curve), 5, normalized);
  if (!v5.ok) return v5;
  const v6 = validateVersioned(normalizeV6(v5.value), 6, normalized);
  if (!v6.ok) return v6;
  return validateSave(normalizeV7(v6.value), normalized);
}
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
  return { schemaVersion: SAVE_SCHEMA_VERSION, arenaId, activeEncounterId: null, phase: "player", turn: 1, rngState: DEFAULT_RNG_STATE, units: hydratedUnits, campaign, character: characterForXp(campaign.xp, catalog?.progression ?? DEFAULT_LEVEL_CURVE), inventory: synchronizedInventory, base: defaultBase(), objective: initialObjectiveState() };
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const createMemoryStorage = (initial: Record<string, string> = {}): StorageLike => { const data = new Map(Object.entries(initial)); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) }; };
export type SaveWriteResult = { ok: boolean; error?: string }
export interface SaveAdapter {
  save(save: SaveData): boolean
  saveDetailed(save: SaveData): SaveWriteResult
  load(fallbackArenaId?: string, options?: CampaignCatalog | SaveValidationOptions): SaveResult | null
  /**
   * True when the payload `load` would return lives under a **legacy** key, i.e. the installation
   * has not yet been written in the current schema. The shell uses this to persist the migrated
   * result immediately instead of leaving the old key as the live copy until the next transition.
   */
  hasPendingUpgrade(): boolean
  backupCorrupt(): boolean
  reset(): boolean
  setValidationOptions(options: CampaignCatalog | SaveValidationOptions): void
}
export function createLocalStorageAdapter(storage?: StorageLike | null, initialOptions?: CampaignCatalog | SaveValidationOptions): SaveAdapter {
  const target = storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : storage;
  let options = initialOptions;
  /**
   * The key the *current* payload lives under. On a first boot after a schema bump the current key
   * is empty and a legacy key holds the player's save; `readSlot` reports which one answered, so
   * `backupCorrupt` copies the payload that actually failed rather than an unrelated empty key.
   */
  const readSlot = (): { key: string; raw: string } | null => {
    if (!target) return null;
    for (const key of [SAVE_STORAGE_KEY, ...LEGACY_SAVE_STORAGE_KEYS]) {
      const raw = target.getItem(key);
      if (raw !== null) return { key, raw };
    }
    return null;
  };
  const detailed = (save: SaveData): SaveWriteResult => {
    if (!target) return { ok: false, error: "storage unavailable" };
    const checked = validateSave(save, options);
    if (!checked.ok) return { ok: false, error: checked.error.message };
    try {
      target.setItem(SAVE_STORAGE_KEY, serializeSave(checked.value));
      return { ok: true };
    } catch {
      return { ok: false, error: "storage unavailable" };
    }
  };
  return {
    save: (s) => detailed(s).ok,
    saveDetailed: detailed,
    load: (_fallback, loadOptions) => {
      if (!target) return { ok: false, error: new SaveValidationError("parse", [{ path: "$", message: "storage unavailable" }]) };
      const slot = readSlot();
      if (!slot) return null;
      return deserializeSave(slot.raw, loadOptions ?? options)!;
    },
    hasPendingUpgrade: () => {
      const slot = readSlot();
      return slot !== null && slot.key !== SAVE_STORAGE_KEY;
    },
    setValidationOptions: (nextOptions) => { options = nextOptions },
    backupCorrupt: () => {
      const slot = readSlot();
      if (!target || !slot) return false;
      try {
        target.setItem(SAVE_BACKUP_KEY, slot.raw);
        return true;
      } catch {
        return false;
      }
    },
    /* Clears every slot: leaving a legacy payload behind would resurrect it on the next boot. */
    reset: () => {
      if (!target) return false;
      try {
        for (const key of [SAVE_STORAGE_KEY, ...LEGACY_SAVE_STORAGE_KEYS]) target.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}
