import type { BaseUpgradeDefinition, RecipeDefinition } from "./base";
import type { Reward } from "./rewards";
import type { ResourceCost, ResourceId } from "./inventory";
import { isResourceId } from "./inventory";
import {
  ContentValidationError,
  fetchContent,
  isInt,
  isNonEmptyString,
  isRecord,
  validateCollection,
  type ContentIssue,
  type ContentResult,
} from "./content-format";

export interface ItemDefinition {
  id: string;
  name: string;
  weight: number;
  kind: "consumable" | "material";
}
export interface ZoneDefinition {
  id: string;
  name: string;
  order: number;
  description: string;
  unlocked: boolean;
}
export type ObjectiveType = "eliminate" | "secure";
export interface MissionDefinition {
  id: string;
  zoneId: string;
  order: number;
  name: string;
  description: string;
  objective: ObjectiveType;
  arenaId: string;
  difficulty: 0 | 1 | 2;
  rewardId: string;
}
export interface RewardDefinition extends Reward {
  name: string;
}
export interface CampaignCatalog {
  zones: ZoneDefinition[];
  missions: MissionDefinition[];
  rewards: RewardDefinition[];
  items?: ItemDefinition[];
  recipes?: RecipeDefinition[];
}

function checkCost(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ResourceCost | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект стоимости" });
    return null;
  }
  const cost: ResourceCost = {};
  for (const [id, quantity] of Object.entries(value)) {
    if (!isResourceId(id))
      issues.push({ path: `${path}.${id}`, message: "известный ресурс" });
    else if (!isInt(quantity) || quantity < 0)
      issues.push({ path: `${path}.${id}`, message: "неотрицательное целое" });
    else cost[id] = quantity;
  }
  return cost;
}
function checkItem(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ItemDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект предмета" });
    return null;
  }
  const before = issues.length;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name))
    issues.push({ path, message: "id и name — непустые строки" });
  if (typeof value.weight !== "number" || value.weight < 0)
    issues.push({ path: `${path}.weight`, message: "число >= 0" });
  if (value.kind !== "consumable" && value.kind !== "material")
    issues.push({ path: `${path}.kind`, message: "consumable | material" });
  return issues.length === before ? (value as unknown as ItemDefinition) : null;
}
function checkRecipe(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): RecipeDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект рецепта" });
    return null;
  }
  const before = issues.length;
  const cost = checkCost(value.cost, `${path}.cost`, issues);
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description)
  )
    issues.push({ path, message: "id/name/description" });
  if (
    value.node !== "workbench" &&
    value.node !== "medbay" &&
    value.node !== "stash"
  )
    issues.push({ path: `${path}.node`, message: "узел базы" });
  if (!isInt(value.nodeLevel) || value.nodeLevel < 1 || value.nodeLevel > 3)
    issues.push({ path: `${path}.nodeLevel`, message: "1..3" });
  if (
    !isRecord(value.output) ||
    !isNonEmptyString(value.output.itemId) ||
    !isInt(value.output.quantity) ||
    value.output.quantity < 1
  )
    issues.push({ path: `${path}.output`, message: "itemId + quantity" });
  return issues.length === before && cost
    ? ({ ...value, cost } as RecipeDefinition)
    : null;
}
function checkUpgrade(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): BaseUpgradeDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект улучшения" });
    return null;
  }
  const before = issues.length;
  const cost = checkCost(value.cost, `${path}.cost`, issues);
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description)
  )
    issues.push({ path, message: "id/name/description" });
  if (
    value.node !== "workbench" &&
    value.node !== "medbay" &&
    value.node !== "stash"
  )
    issues.push({ path: `${path}.node`, message: "узел базы" });
  if (
    !isInt(value.targetLevel) ||
    value.targetLevel < 2 ||
    value.targetLevel > 3
  )
    issues.push({ path: `${path}.targetLevel`, message: "2..3" });
  if (!isInt(value.capacityBonus) || value.capacityBonus < 0)
    issues.push({
      path: `${path}.capacityBonus`,
      message: "неотрицательное целое",
    });
  return issues.length === before && cost
    ? ({ ...value, cost } as BaseUpgradeDefinition)
    : null;
}
function checkZone(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ZoneDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект зоны" });
    return null;
  }
  const before = issues.length;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description)
  )
    issues.push({ path, message: "id/name/description" });
  if (!isInt(value.order) || value.order < 1)
    issues.push({ path: `${path}.order`, message: ">=1" });
  if (typeof value.unlocked !== "boolean")
    issues.push({ path: `${path}.unlocked`, message: "boolean" });
  return issues.length === before ? (value as unknown as ZoneDefinition) : null;
}
function checkMission(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): MissionDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект encounter" });
    return null;
  }
  const before = issues.length;
  for (const key of ["id", "zoneId", "name", "arenaId", "rewardId"] as const)
    if (!isNonEmptyString(value[key]))
      issues.push({ path: `${path}.${key}`, message: "непустая строка" });
  const order = value.order === undefined ? 1 : value.order;
  const description =
    value.description === undefined ? value.name : value.description;
  if (!isInt(order) || order < 1)
    issues.push({ path: `${path}.order`, message: ">=1" });
  if (
    value.objective !== "eliminate" &&
    value.objective !== "secure" &&
    value.objective !== "retrieve" &&
    value.objective !== "escape"
  )
    issues.push({ path: `${path}.objective`, message: "eliminate | secure" });
  if (!isInt(value.difficulty) || value.difficulty < 0 || value.difficulty > 2)
    issues.push({ path: `${path}.difficulty`, message: "0..2" });
  return issues.length === before
    ? ({
        ...value,
        order,
        description,
        objective:
          value.objective === "retrieve" || value.objective === "escape"
            ? "secure"
            : value.objective,
      } as unknown as MissionDefinition)
    : null;
}
function checkReward(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): RewardDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект награды" });
    return null;
  }
  const before = issues.length;
  const resources = checkCost(value.resources, `${path}.resources`, issues);
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name))
    issues.push({ path, message: "id/name" });
  if (!isInt(value.xp) || value.xp < 0 || typeof value.oneTime !== "boolean")
    issues.push({ path, message: "xp >= 0, oneTime boolean" });
  const items = Array.isArray(value.items) ? value.items : [];
  if (!Array.isArray(value.items))
    issues.push({ path: `${path}.items`, message: "массив" });
  const checked = items.flatMap((item, index) =>
    isRecord(item) &&
    isNonEmptyString(item.id) &&
    isInt(item.quantity) &&
    item.quantity > 0 &&
    typeof item.weight === "number" &&
    item.weight >= 0
      ? [{ id: item.id, quantity: item.quantity, weight: item.weight }]
      : (issues.push({
          path: `${path}.items[${index}]`,
          message: "валидный item reward",
        }),
        []),
  );
  return issues.length === before && resources
    ? {
        id: value.id as string,
        name: value.name as string,
        xp: value.xp as number,
        resources,
        items: checked,
        oneTime: value.oneTime as boolean,
      }
    : null;
}
export const validateItems = (value: unknown) =>
  validateCollection(value, "items", checkItem);
export const validateRecipes = (value: unknown) =>
  validateCollection(value, "recipes", checkRecipe);
export const validateBaseUpgrades = (value: unknown) =>
  validateCollection(value, "base-upgrades", checkUpgrade);
export const validateZones = (value: unknown) =>
  validateCollection(value, "zones", checkZone);
export const validateMissions = (value: unknown) =>
  validateCollection(value, "missions", checkMission);
export const validateRewards = (value: unknown) =>
  validateCollection(value, "rewards", checkReward);
export function validateCampaignCatalog(
  catalog: CampaignCatalog,
  arenaIds: ReadonlySet<string>,
  itemIds?: ReadonlySet<string>,
): ContentResult<CampaignCatalog> {
  const resolvedItemIds = itemIds ?? new Set(catalog.items?.map((item) => item.id) ?? []);
  const issues: ContentIssue[] = [];
  const zoneIds = new Set(catalog.zones.map((zone) => zone.id));
  const rewardIds = new Set(catalog.rewards.map((reward) => reward.id));
  const recipeList = catalog.recipes ?? [];
  const itemIdsProvided = catalog.items !== undefined;
  for (const recipe of recipeList) {
      if (itemIdsProvided && !resolvedItemIds.has(recipe.output.itemId))
      issues.push({ path: `recipes.${recipe.id}.output.itemId`, message: "ссылка на существующий предмет" });
  }
  for (const reward of catalog.rewards) {
    for (const item of reward.items) {
      if (itemIdsProvided && !resolvedItemIds.has(item.id))
        issues.push({ path: `rewards.${reward.id}.items.${item.id}`, message: "ссылка на существующий предмет" });
    }
  }
  for (const mission of catalog.missions) {
    if (!zoneIds.has(mission.zoneId))
      issues.push({
        path: `missions.${mission.id}.zoneId`,
        message: "ссылка на существующую зону",
      });
    if (!arenaIds.has(mission.arenaId))
      issues.push({
        path: `missions.${mission.id}.arenaId`,
        message: "ссылка на существующую карту",
      });
    if (!rewardIds.has(mission.rewardId))
      issues.push({
        path: `missions.${mission.id}.rewardId`,
        message: "ссылка на существующую награду",
      });
  }
  for (const zone of catalog.zones) {
    const ordered = catalog.missions
      .filter((mission) => mission.zoneId === zone.id)
      .sort((a, b) => a.order - b.order);
    if (!ordered.length)
      issues.push({
        path: `zones.${zone.id}`,
        message: "зона содержит encounter",
      });
    else
      ordered.forEach((mission, index) => {
        if (mission.order !== index + 1)
          issues.push({
            path: `missions.${mission.id}.order`,
            message: "последовательный порядок внутри зоны с 1",
          });
      });
  }
  return issues.length
    ? { ok: false, error: new ContentValidationError("shape", issues) }
    : { ok: true, value: catalog };
}
function throwing<T>(result: ContentResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
export const loadItems = async (url = "/config/items.json") =>
  throwing(validateItems(await fetchContent(url)));
export const loadRecipes = async (url = "/config/recipes.json") =>
  throwing(validateRecipes(await fetchContent(url)));
export const loadBaseUpgrades = async (url = "/config/base-upgrades.json") =>
  throwing(validateBaseUpgrades(await fetchContent(url)));
export const loadZones = async (url = "/config/zones.json") =>
  throwing(validateZones(await fetchContent(url)));
export const loadMissions = async (url = "/config/missions.json") =>
  throwing(validateMissions(await fetchContent(url)));
export const loadRewards = async (url = "/config/rewards.json") =>
  throwing(validateRewards(await fetchContent(url)));
export type { ResourceId };
export { ContentValidationError };
