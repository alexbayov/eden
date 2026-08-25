import {
  BASE_NODES,
  EFFECT_KIND_BY_NODE,
  MAX_NODE_LEVEL,
  MIN_NODE_LEVEL,
  type BaseNode,
  type BaseUpgradeDefinition,
  type BaseUpgradeEffect,
  type RecipeDefinition,
} from "./base";
import type { Reward } from "./rewards";
import type { ResourceCost, ResourceId } from "./inventory";
import { isResourceId } from "./inventory";
import { ITEM_EFFECT_KINDS, type ItemEffect, type ItemEffectDefinition } from "./consumables";
import { dismantleCeiling, noProfitViolations, type ReturnTableDefinition } from "./dismantle";
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
  /** Base upgrades, cross-checked against the node level sequence and the recipes gated by it. */
  upgrades?: BaseUpgradeDefinition[];
  /** W5-03 quick-slot effects, cross-checked against `items` (existence, `kind`, uniqueness). */
  itemEffects?: ItemEffectDefinition[];
  /** W5-04 dismantle returns, cross-checked against `items` and against the recipe that makes them. */
  returnTables?: ReturnTableDefinition[];
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
const isBaseNode = (value: unknown): value is BaseNode =>
  typeof value === "string" && (BASE_NODES as string[]).includes(value);

/**
 * Real-time gating is forbidden by W5-01/W5-02 scope and by doc 16, so it is rejected at the
 * *content* boundary rather than merely left unimplemented. A `durationMs`/`readyAt`-style field on
 * a recipe or upgrade is the cheapest way this ban gets broken: nothing in the domain would read it,
 * the entry would still apply instantly, and the catalog would quietly document a timer the game
 * does not honour. Naming the fields makes the refusal explicit and the error message actionable.
 */
const TIMER_FIELDS = [
  "durationMs",
  "durationSeconds",
  "durationMinutes",
  "durationHours",
  "buildTimeMs",
  "craftTimeMs",
  "readyAt",
  "startedAt",
  "completesAt",
  "timerId",
] as const;
function rejectTimers(
  value: Record<string, unknown>,
  path: string,
  issues: ContentIssue[],
) {
  for (const field of TIMER_FIELDS)
    if (value[field] !== undefined)
      issues.push({
        path: `${path}.${field}`,
        message: "real-time таймеры запрещены (W5-01/W5-02, doc 16)",
      });
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
  if (!isBaseNode(value.node))
    issues.push({ path: `${path}.node`, message: "узел базы" });
  if (
    !isInt(value.nodeLevel) ||
    value.nodeLevel < MIN_NODE_LEVEL ||
    value.nodeLevel > MAX_NODE_LEVEL
  )
    issues.push({
      path: `${path}.nodeLevel`,
      message: `${MIN_NODE_LEVEL}..${MAX_NODE_LEVEL}`,
    });
  if (
    !isRecord(value.output) ||
    !isNonEmptyString(value.output.itemId) ||
    !isInt(value.output.quantity) ||
    value.output.quantity < 1
  )
    issues.push({ path: `${path}.output`, message: "itemId + quantity" });
  /* A recipe with no cost is not a recipe: it would print items out of nothing. */
  if (cost && Object.values(cost).every((amount) => amount === 0))
    issues.push({ path: `${path}.cost`, message: "хотя бы один ресурс > 0" });
  rejectTimers(value, path, issues);
  return issues.length === before && cost
    ? ({ ...value, cost } as RecipeDefinition)
    : null;
}
/**
 * W5-01 — the effect of a level is validated as a *node-specific* object, not as a reused
 * `capacityBonus`. `EFFECT_KIND_BY_NODE` pins which kind each node may declare, so a medbay entry
 * that granted backpack capacity is a load-time error rather than a level whose stated effect the
 * game never applies.
 */
function checkUpgradeEffect(
  value: unknown,
  node: BaseNode | undefined,
  targetLevel: unknown,
  path: string,
  issues: ContentIssue[],
): BaseUpgradeEffect | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект эффекта уровня" });
    return null;
  }
  const expected = node ? EFFECT_KIND_BY_NODE[node] : undefined;
  if (expected && value.kind !== expected) {
    issues.push({ path: `${path}.kind`, message: `для узла ${node} ожидалось "${expected}"` });
    return null;
  }
  if (value.kind === "stash-capacity") {
    if (!isInt(value.capacityBonus) || value.capacityBonus < 1)
      issues.push({ path: `${path}.capacityBonus`, message: "целое >= 1" });
    else return { kind: "stash-capacity", capacityBonus: value.capacityBonus };
    return null;
  }
  if (value.kind === "medbay-heal") {
    if (!isInt(value.healBonus) || value.healBonus < 1)
      issues.push({ path: `${path}.healBonus`, message: "целое >= 1" });
    else return { kind: "medbay-heal", healBonus: value.healBonus };
    return null;
  }
  if (value.kind === "workbench-recipe-tier") {
    /* The tier a workbench level unlocks *is* that level: a recipe gated at `nodeLevel: 3` becomes
       craftable exactly when workbench 3 is bought, so a mismatch would show the player a level
       whose advertised unlock does not match what `craftBlocker` allows. */
    if (value.recipeLevel !== targetLevel)
      issues.push({ path: `${path}.recipeLevel`, message: "совпадает с targetLevel" });
    else return { kind: "workbench-recipe-tier", recipeLevel: value.recipeLevel as number };
    return null;
  }
  issues.push({ path: `${path}.kind`, message: "известный вид эффекта" });
  return null;
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
  if (!isBaseNode(value.node))
    issues.push({ path: `${path}.node`, message: "узел базы" });
  if (
    !isInt(value.targetLevel) ||
    value.targetLevel < MIN_NODE_LEVEL + 1 ||
    value.targetLevel > MAX_NODE_LEVEL
  )
    issues.push({
      path: `${path}.targetLevel`,
      message: `${MIN_NODE_LEVEL + 1}..${MAX_NODE_LEVEL}`,
    });
  /* Superseded by `effect`: a stray `capacityBonus` would look authoritative and be ignored. */
  if (value.capacityBonus !== undefined)
    issues.push({ path: `${path}.capacityBonus`, message: "заменено на effect" });
  const effect = checkUpgradeEffect(
    value.effect,
    isBaseNode(value.node) ? value.node : undefined,
    value.targetLevel,
    `${path}.effect`,
    issues,
  );
  /* Every level must cost something: a free upgrade is not a decision. */
  if (cost && Object.values(cost).every((amount) => amount === 0))
    issues.push({ path: `${path}.cost`, message: "хотя бы один ресурс > 0" });
  rejectTimers(value, path, issues);
  return issues.length === before && cost && effect
    ? ({ ...value, cost, effect } as BaseUpgradeDefinition)
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
/**
 * W5-03 — what a consumable does, as content.
 *
 * The AP price is validated here rather than left to the combat slice because an in-combat use has to
 * cost something comparable to an attack: a 0-AP heal is a free action and would make every other
 * turn decision irrelevant, and a cost above `AP_PER_TURN` would be an effect no turn can ever pay
 * for. Both are content mistakes with no runtime symptom other than a broken encounter, so they are
 * rejected at load. The bounds are stated as `MIN_EFFECT_AP_COST`/`MAX_EFFECT_AP_COST` in code
 * because the combat constants live in `combat.ts` and importing them here would pull the whole
 * combat module into the content boundary.
 */
export const MIN_EFFECT_AP_COST = 1;
export const MAX_EFFECT_AP_COST = 10;
function checkItemEffectPayload(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ItemEffect | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект эффекта" });
    return null;
  }
  const positiveAmount = (amount: unknown) => isInt(amount) && (amount as number) > 0;
  if (value.kind === "heal") {
    if (!positiveAmount(value.amount)) {
      issues.push({ path: `${path}.amount`, message: "целое >= 1" });
      return null;
    }
    return { kind: "heal", amount: value.amount as number };
  }
  if (value.kind === "restore-ammo") {
    if (!isNonEmptyString(value.ammoId)) issues.push({ path: `${path}.ammoId`, message: "непустая строка" });
    if (!positiveAmount(value.amount)) issues.push({ path: `${path}.amount`, message: "целое >= 1" });
    return isNonEmptyString(value.ammoId) && positiveAmount(value.amount)
      ? { kind: "restore-ammo", ammoId: value.ammoId, amount: value.amount as number }
      : null;
  }
  if (value.kind === "repair") {
    if (!positiveAmount(value.amount)) {
      issues.push({ path: `${path}.amount`, message: "целое >= 1" });
      return null;
    }
    return { kind: "repair", amount: value.amount as number };
  }
  issues.push({ path: `${path}.kind`, message: ITEM_EFFECT_KINDS.join(" | ") });
  return null;
}
function checkItemEffect(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ItemEffectDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект эффекта предмета" });
    return null;
  }
  const before = issues.length;
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description)
  )
    issues.push({ path, message: "id/name/description" });
  if (!isNonEmptyString(value.itemId))
    issues.push({ path: `${path}.itemId`, message: "непустая строка" });
  if (
    !isInt(value.apCost) ||
    value.apCost < MIN_EFFECT_AP_COST ||
    value.apCost > MAX_EFFECT_AP_COST
  )
    issues.push({ path: `${path}.apCost`, message: `${MIN_EFFECT_AP_COST}..${MAX_EFFECT_AP_COST}` });
  const effect = checkItemEffectPayload(value.effect, `${path}.effect`, issues);
  rejectTimers(value, path, issues);
  return issues.length === before && effect
    ? ({ ...value, effect } as unknown as ItemEffectDefinition)
    : null;
}
/**
 * W5-04 — the dismantle return table, as content.
 *
 * Only the *shape* is checked here (known resources, whole positive amounts, at least one of them).
 * The no-profit ceiling is a **cross-file** rule — it compares a table against the recipe that
 * produces the same item — so it lives in `validateCampaignCatalog`, where both files are in hand.
 */
function checkReturnTable(
  value: unknown,
  path: string,
  issues: ContentIssue[],
): ReturnTableDefinition | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "объект таблицы возврата" });
    return null;
  }
  const before = issues.length;
  const returns = checkCost(value.returns, `${path}.returns`, issues);
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.description)
  )
    issues.push({ path, message: "id/name/description" });
  if (!isNonEmptyString(value.itemId))
    issues.push({ path: `${path}.itemId`, message: "непустая строка" });
  /* A table returning nothing is not a table: the action would destroy the item for no reason, and
     `dismantleEquipment` would refuse it at runtime with `no-yield` anyway. */
  if (returns && Object.values(returns).every((amount) => amount === 0))
    issues.push({ path: `${path}.returns`, message: "хотя бы один ресурс > 0" });
  rejectTimers(value, path, issues);
  return issues.length === before && returns
    ? ({ ...value, returns } as unknown as ReturnTableDefinition)
    : null;
}
export const validateItems = (value: unknown) =>
  validateCollection(value, "items", checkItem);
export const validateItemEffects = (value: unknown) =>
  validateCollection(value, "item-effects", checkItemEffect);
export const validateReturnTables = (value: unknown) =>
  validateCollection(value, "return-tables", checkReturnTable);
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
  /**
   * Ids the W5-03/W5-04 files may point at *outside* `items.json`.
   *
   * A separate argument rather than more `Set`s in the positional list: gear ids live in
   * `equipment.json` (a return table may name `pm`, which is not an item) and so do ammo ids (a
   * `restore-ammo` effect names `9x18`). Both are omitted by callers with no equipment catalog in
   * hand, and an omitted set means "cannot verify" rather than "reject" — the same convention
   * `itemIds`/`catalog.items` already uses.
   */
  references: { equipmentIds?: ReadonlySet<string>; ammoIds?: ReadonlySet<string> } = {},
): ContentResult<CampaignCatalog> {
  const { equipmentIds, ammoIds } = references;
  const resolvedItemIds = itemIds ?? new Set(catalog.items?.map((item) => item.id) ?? []);
  const issues: ContentIssue[] = [];
  const zoneIds = new Set(catalog.zones.map((zone) => zone.id));
  const rewardIds = new Set(catalog.rewards.map((reward) => reward.id));
  const recipeList = catalog.recipes ?? [];
  const upgradeList = catalog.upgrades ?? [];
  const itemIdsProvided = catalog.items !== undefined;
  for (const recipe of recipeList) {
      if (itemIdsProvided && !resolvedItemIds.has(recipe.output.itemId))
      issues.push({ path: `recipes.${recipe.id}.output.itemId`, message: "ссылка на существующий предмет" });
  }
  /**
   * W5-03 — a quick-slot effect must name an item that exists, is a `consumable`, and has exactly one
   * effect.
   *
   * Each rule closes a failure with no runtime symptom. An effect on a missing item is a slot the
   * player can never fill. An effect on a `material` is a slot that spends a crafting input for a
   * heal, which contradicts the item catalog's own classification. Two effects for one item make the
   * *file order* decide what a bandage does, and `effectForItem` takes the first — an ambiguity that
   * would surface as a balance mystery rather than as an error.
   */
  const effectList = catalog.itemEffects ?? [];
  if (catalog.itemEffects !== undefined) {
    const seenItemIds = new Set<string>();
    for (const effect of effectList) {
      if (itemIdsProvided && !resolvedItemIds.has(effect.itemId))
        issues.push({ path: `item-effects.${effect.id}.itemId`, message: "ссылка на существующий предмет" });
      const definition = catalog.items?.find((item) => item.id === effect.itemId);
      if (definition && definition.kind !== "consumable")
        issues.push({ path: `item-effects.${effect.id}.itemId`, message: "предмет с kind consumable" });
      if (seenItemIds.has(effect.itemId))
        issues.push({ path: `item-effects.${effect.id}.itemId`, message: "не более одного эффекта на предмет" });
      seenItemIds.add(effect.itemId);
      /* A `restore-ammo` effect naming ammunition the equipment catalog does not know would refill a
         calibre no weapon can chamber: the slot would work, cost AP and change nothing. */
      if (effect.effect.kind === "restore-ammo" && ammoIds !== undefined && !ammoIds.has(effect.effect.ammoId))
        issues.push({ path: `item-effects.${effect.id}.effect.ammoId`, message: "известный ammo id каталога экипировки" });
    }
  }
  /**
   * W5-04 criterion 4 as a **load-time** rule: no craft → dismantle cycle may be profitable.
   *
   * The comparison is per unit of output, because a recipe may produce more than one, and per
   * resource, because a table returning a resource the recipe never charged would be a converter
   * rather than a loss. `dismantleCeiling`/`noProfitViolations` are the same functions
   * `dismantleEquipment`'s tests assert over, so the file and the runtime agree by construction
   * instead of by two similar-looking formulas.
   *
   * A table for an item **no recipe produces** (gear, found loot) is unconstrained by this rule: there
   * is no cycle to close, and the payout is then a pure balance decision.
   */
  const tableList = catalog.returnTables ?? [];
  if (catalog.returnTables !== undefined) {
    const seenItemIds = new Set<string>();
    for (const table of tableList) {
      /* Verifiable only when both id sources are in hand: an absent `equipmentIds` means gear ids
         cannot be checked, and rejecting `pm` in that case would fail a valid catalog. */
      const verifiable = itemIdsProvided && equipmentIds !== undefined;
      const known = resolvedItemIds.has(table.itemId) || (equipmentIds?.has(table.itemId) ?? false);
      if (verifiable && !known)
        issues.push({ path: `return-tables.${table.id}.itemId`, message: "ссылка на существующий предмет или экипировку" });
      if (seenItemIds.has(table.itemId))
        issues.push({ path: `return-tables.${table.id}.itemId`, message: "не более одной таблицы на предмет" });
      seenItemIds.add(table.itemId);
      const recipe = recipeList.find((entry) => entry.output.itemId === table.itemId);
      if (!recipe) continue;
      const perUnitCost: ResourceCost = Object.fromEntries(
        (Object.entries(recipe.cost) as [ResourceId, number][]).map(([id, amount]) => [
          id,
          amount / Math.max(1, recipe.output.quantity),
        ]),
      );
      for (const violation of noProfitViolations(perUnitCost, table.returns))
        issues.push({
          path: `return-tables.${table.id}.returns.${violation.resource}`,
          message: `возврат ${violation.returned} превышает потолок ${violation.ceiling} для рецепта ${recipe.id} (крафт→разборка не даёт прибыли)`,
        });
      /* Named separately from the per-resource rule so the message can state the whole cycle: a table
         that is within every per-resource ceiling but returns something for a recipe whose ceiling is
         empty (a 1-unit cost) still has to be rejected. */
      if (Object.keys(dismantleCeiling(perUnitCost)).length === 0 && Object.keys(table.returns).length > 0)
        issues.push({
          path: `return-tables.${table.id}.returns`,
          message: `рецепт ${recipe.id} слишком дешёв для возврата (потолок пуст)`,
        });
    }
  }
  /**
   * W5-01 criterion 1 as a load-time rule: each node reaches `MAX_NODE_LEVEL` through exactly one
   * catalog entry per transition. `upgradeBlocker` already refuses to apply a level out of turn, but
   * a *gap* in the catalog is not a refusal — it is a node that silently cannot be levelled, and
   * only the catalog can tell that apart from a deliberately shorter node.
   */
  if (catalog.upgrades !== undefined)
    for (const node of BASE_NODES) {
      const forNode = upgradeList.filter((entry) => entry.node === node);
      for (let level = MIN_NODE_LEVEL + 1; level <= MAX_NODE_LEVEL; level += 1) {
        const matching = forNode.filter((entry) => entry.targetLevel === level);
        if (matching.length === 0)
          issues.push({ path: `base-upgrades.${node}.${level}`, message: "нет записи для перехода на уровень" });
        if (matching.length > 1)
          issues.push({ path: `base-upgrades.${node}.${level}`, message: "ровно одна запись на переход уровня" });
      }
    }
  /**
   * A recipe gated above the highest reachable level of its node is unreachable content: the button
   * would exist and never unlock. Checked against the upgrade catalog, so the two files are only
   * valid together.
   */
  if (catalog.upgrades !== undefined)
    for (const recipe of recipeList) {
      const reachable = Math.max(
        MIN_NODE_LEVEL,
        ...upgradeList.filter((entry) => entry.node === recipe.node).map((entry) => entry.targetLevel),
      );
      if (recipe.nodeLevel > reachable)
        issues.push({ path: `recipes.${recipe.id}.nodeLevel`, message: `узел ${recipe.node} не достигает уровня ${recipe.nodeLevel}` });
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
export const loadItemEffects = async (url = "/config/item-effects.json") =>
  throwing(validateItemEffects(await fetchContent(url)));
export const loadReturnTables = async (url = "/config/return-tables.json") =>
  throwing(validateReturnTables(await fetchContent(url)));
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
export type { ItemEffect, ItemEffectDefinition, ReturnTableDefinition };
export { ContentValidationError };
