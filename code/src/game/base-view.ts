/**
 * Pure view models for the base screen (W5-01 / W5-02).
 *
 * The base panel used to render `catalog.recipes.map(...)` and `catalog.upgrades.map(...)` directly,
 * with the only affordability signal being `disabled={base[node] >= targetLevel}` on the upgrade
 * button. That was enough for a one-entry catalog and is not enough for six upgrades and seven
 * recipes: with a full catalog, "why can I not press this" has three different answers (wrong node
 * level, node already maxed, missing resources), and a player who cannot see which resource is
 * missing has no way to plan a run.
 *
 * So the *reason* and the *effect* are computed here, once, from the same domain predicates the
 * transitions use (`upgradeBlocker`, `craftBlocker`, `missingResources`, `healAmount`,
 * `storageCapacity`), and the DOM only renders strings. Two consequences on purpose:
 *
 *   - The shell cannot disagree with the domain about whether an action is available: it does not
 *     decide. A button rendered enabled here and refused by `applyUpgrade` would be a contradiction
 *     inside one module rather than between two.
 *   - Every effect a player is shown before paying (W5-01 criterion 4) comes from the catalog entry
 *     itself, so a level with no declared effect cannot be advertised as having one.
 *
 * No real-time state exists in these models: there is no pending, queued or "ready in" status,
 * because a node transition and a craft are both single synchronous transitions (W5-01 criterion 5).
 */
import {
  BASE_NODES,
  MAX_NODE_LEVEL,
  MIN_NODE_LEVEL,
  NODE_LABELS,
  craftBlocker,
  healAmount,
  missingResources,
  storageCapacity,
  upgradeBlocker,
  type BaseNode,
  type BaseState,
  type BaseUpgradeDefinition,
  type CraftFailure,
  type RecipeDefinition,
  type UpgradeFailure,
} from "./base";
import {
  RESOURCE_IDS,
  RESOURCE_LABELS,
  resourceQuantity,
  type Inventory,
  type ResourceCost,
  type ResourceId,
} from "./inventory";

/**
 * Canonical resource order for every list a player reads: the order `RESOURCE_IDS` declares, not
 * alphabetical by id and not by label. Sorting by id would print «Ткань, Металл» because the labels
 * are Russian and the ids are not, i.e. the visible order would look arbitrary; sorting by label
 * would reorder itself under localisation. One shared comparator keeps costs, missing lists and the
 * stash overview in the same sequence, so the same cost always reads the same way.
 */
const resourceOrder = (id: ResourceId) => RESOURCE_IDS.indexOf(id);
const byResourceOrder = (left: ResourceId, right: ResourceId) => resourceOrder(left) - resourceOrder(right);

const formatAmounts = (cost: ResourceCost): string =>
  (Object.entries(cost) as [ResourceId, number][])
    .filter(([, amount]) => amount > 0)
    .sort(([left], [right]) => byResourceOrder(left, right))
    .map(([id, amount]) => `${RESOURCE_LABELS[id]} ×${amount}`)
    .join(", ");

/** `Металл ×4` style listing of what an action costs. */
export const formatCost = (cost: ResourceCost): string => formatAmounts(cost) || "бесплатно";

/** What is still missing from the stash, named per resource rather than as one opaque refusal. */
export const formatMissing = (inventory: Inventory, cost: ResourceCost): string =>
  formatAmounts(missingResources(inventory, cost));

/** Stash coverage of a cost, so the UI can show "have 3 of 5" without a second lookup. */
export interface ResourceRequirement {
  id: ResourceId;
  label: string;
  required: number;
  available: number;
  missing: number;
}
export const requirementsFor = (inventory: Inventory, cost: ResourceCost): ResourceRequirement[] =>
  (Object.entries(cost) as [ResourceId, number][])
    .filter(([, required]) => required > 0)
    .sort(([left], [right]) => byResourceOrder(left, right))
    .map(([id, required]) => {
      const available = resourceQuantity(inventory, id, "stash");
      return { id, label: RESOURCE_LABELS[id], required, available, missing: Math.max(0, required - available) };
    });

/* ------------------------------------------------------------------ upgrades */

export interface BaseUpgradeOption {
  id: string;
  node: BaseNode;
  nodeLabel: string;
  name: string;
  targetLevel: number;
  /** Catalog copy: what the level does, shown before the purchase (W5-01 criterion 4). */
  description: string;
  /** Effect restated from the effect object, so it cannot drift from what is applied. */
  effectSummary: string;
  costLabel: string;
  requirements: ResourceRequirement[];
  /** Missing stash resources, empty when affordable. */
  missingLabel: string;
  /** Domain refusal, or null when the upgrade can be bought right now. */
  blocked: UpgradeFailure | null;
  available: boolean;
  disabled: boolean;
  label: string;
  ariaLabel: string;
  /** Explains the refusal in the player's terms; empty when the option is available. */
  reason: string;
}

/** The effect of one level, phrased from the effect object rather than from the description text. */
export function upgradeEffectSummary(upgrade: BaseUpgradeDefinition): string {
  switch (upgrade.effect.kind) {
    case "stash-capacity":
      return `вместимость рюкзака +${upgrade.effect.capacityBonus}`;
    case "medbay-heal":
      return `лечение бинтом +${upgrade.effect.healBonus} HP`;
    case "workbench-recipe-tier":
      return `рецепты верстака уровня ${upgrade.effect.recipeLevel}`;
  }
}

const upgradeReason = (blocked: UpgradeFailure | null, upgrade: BaseUpgradeDefinition, base: BaseState, missing: string) => {
  if (blocked === null) return "";
  if (blocked === "max-level") return `${NODE_LABELS[upgrade.node]} уже на максимальном уровне ${MAX_NODE_LEVEL}.`;
  if (blocked === "wrong-level")
    return `Сначала нужен уровень ${upgrade.targetLevel - 1}: ${NODE_LABELS[upgrade.node]} сейчас L${base[upgrade.node]}.`;
  return `Не хватает в stash: ${missing}.`;
};

export function buildUpgradeOptions(
  base: BaseState,
  inventory: Inventory,
  catalog: readonly BaseUpgradeDefinition[],
): BaseUpgradeOption[] {
  return [...catalog]
    /* Node order then level order: a player reads a node's ladder top to bottom, not catalog order. */
    .sort((left, right) =>
      BASE_NODES.indexOf(left.node) - BASE_NODES.indexOf(right.node) || left.targetLevel - right.targetLevel)
    .map((upgrade) => {
      const requirements = requirementsFor(inventory, upgrade.cost);
      const missingLabel = formatMissing(inventory, upgrade.cost);
      const blocked = upgradeBlocker(base, upgrade) ?? (missingLabel ? ("insufficient-resources" as const) : null);
      const effectSummary = upgradeEffectSummary(upgrade);
      const costLabel = formatCost(upgrade.cost);
      return {
        id: upgrade.id,
        node: upgrade.node,
        nodeLabel: NODE_LABELS[upgrade.node],
        name: upgrade.name,
        targetLevel: upgrade.targetLevel,
        description: upgrade.description,
        effectSummary,
        costLabel,
        requirements,
        missingLabel,
        blocked,
        available: blocked === null,
        disabled: blocked !== null,
        label: `${upgrade.name}: ${upgrade.description}`,
        ariaLabel: `${upgrade.name}. Эффект: ${effectSummary}. Цена: ${costLabel}.${
          blocked === null ? " Доступно." : ` Недоступно: ${upgradeReason(blocked, upgrade, base, missingLabel)}`
        }`,
        reason: upgradeReason(blocked, upgrade, base, missingLabel),
      };
    });
}

/* ------------------------------------------------------------------- recipes */

export interface RecipeOption {
  id: string;
  name: string;
  node: BaseNode;
  nodeLabel: string;
  nodeLevel: number;
  description: string;
  outputLabel: string;
  costLabel: string;
  requirements: ResourceRequirement[];
  missingLabel: string;
  blocked: CraftFailure | null;
  available: boolean;
  disabled: boolean;
  label: string;
  ariaLabel: string;
  reason: string;
}

const craftReason = (blocked: CraftFailure | null, recipe: RecipeDefinition, base: BaseState, missing: string) => {
  if (blocked === null) return "";
  if (blocked === "node-locked")
    return `Нужен ${NODE_LABELS[recipe.node]} L${recipe.nodeLevel}, сейчас L${base[recipe.node]}.`;
  if (blocked === "insufficient-resources") return `Не хватает в stash: ${missing}.`;
  return "Рецепт отсутствует в каталоге.";
};

export function buildRecipeOptions(
  base: BaseState,
  inventory: Inventory,
  catalog: readonly RecipeDefinition[],
  labelFor: (itemId: string) => string = (itemId) => itemId,
): RecipeOption[] {
  return [...catalog]
    .sort((left, right) =>
      BASE_NODES.indexOf(left.node) - BASE_NODES.indexOf(right.node) ||
      left.nodeLevel - right.nodeLevel ||
      left.id.localeCompare(right.id))
    .map((recipe) => {
      const blocked = craftBlocker(base, inventory, recipe);
      const missingLabel = formatMissing(inventory, recipe.cost);
      const costLabel = formatCost(recipe.cost);
      const outputLabel = `${labelFor(recipe.output.itemId)} ×${recipe.output.quantity}`;
      return {
        id: recipe.id,
        name: recipe.name,
        node: recipe.node,
        nodeLabel: NODE_LABELS[recipe.node],
        nodeLevel: recipe.nodeLevel,
        description: recipe.description,
        outputLabel,
        costLabel,
        requirements: requirementsFor(inventory, recipe.cost),
        missingLabel,
        blocked,
        available: blocked === null,
        disabled: blocked !== null,
        label: `${recipe.name} — ${recipe.description}`,
        ariaLabel: `${recipe.name}. Даёт ${outputLabel}. Цена: ${costLabel}.${
          blocked === null ? " Доступно." : ` Недоступно: ${craftReason(blocked, recipe, base, missingLabel)}`
        }`,
        reason: craftReason(blocked, recipe, base, missingLabel),
      };
    });
}

/* --------------------------------------------------------------- node summary */

export interface BaseNodeView {
  node: BaseNode;
  label: string;
  level: number;
  maxLevel: number;
  /** `L2 / L3` progress readout for the node header. */
  levelLabel: string;
  atMaxLevel: boolean;
  /** Current effect of the node at its present level, in the player's terms. */
  effectSummary: string;
  /** The single next transition, or null at max level. */
  next: BaseUpgradeOption | null;
}

const nodeEffectSummary = (
  node: BaseNode,
  base: BaseState,
  catalog: readonly BaseUpgradeDefinition[],
): string => {
  if (node === "stash") return `вместимость рюкзака ${storageCapacity(base, catalog)}`;
  if (node === "medbay") return `бинт лечит ${healAmount(base, catalog)} HP`;
  return `доступны рецепты уровня ${base.workbench}`;
};

export function buildBaseNodes(
  base: BaseState,
  inventory: Inventory,
  catalog: readonly BaseUpgradeDefinition[],
): BaseNodeView[] {
  const options = buildUpgradeOptions(base, inventory, catalog);
  return BASE_NODES.map((node) => ({
    node,
    label: NODE_LABELS[node],
    level: base[node],
    maxLevel: MAX_NODE_LEVEL,
    levelLabel: `L${base[node]} / L${MAX_NODE_LEVEL}`,
    atMaxLevel: base[node] >= MAX_NODE_LEVEL,
    effectSummary: nodeEffectSummary(node, base, catalog),
    next: options.find((option) => option.node === node && option.targetLevel === base[node] + 1) ?? null,
  }));
}

/* ------------------------------------------------------------ stash resources */

export interface StashResourceView {
  id: ResourceId;
  label: string;
  quantity: number;
}

/**
 * Every resource any catalog entry can ask for, with the stash amount — including the ones the
 * player has none of.
 *
 * Listing only present stacks (what the stash panel does) makes an unaffordable recipe unreadable:
 * a missing resource simply is not on screen, so "не хватает" names something the player cannot
 * find. Zero-quantity rows are the point, not noise.
 */
export function buildStashOverview(
  inventory: Inventory,
  recipes: readonly RecipeDefinition[],
  upgrades: readonly BaseUpgradeDefinition[],
): StashResourceView[] {
  const referenced = new Set<ResourceId>();
  for (const cost of [...recipes.map((entry) => entry.cost), ...upgrades.map((entry) => entry.cost)])
    for (const [id, amount] of Object.entries(cost) as [ResourceId, number][])
      if (amount > 0) referenced.add(id);
  for (const stack of inventory.stash.resources) referenced.add(stack.id);
  return [...referenced]
    .sort(byResourceOrder)
    .map((id) => ({ id, label: RESOURCE_LABELS[id], quantity: resourceQuantity(inventory, id, "stash") }));
}

/* ------------------------------------------------------------------ the panel */

export interface BasePanelView {
  nodes: BaseNodeView[];
  upgrades: BaseUpgradeOption[];
  recipes: RecipeOption[];
  stash: StashResourceView[];
  /** Backpack budget the current stash level grants, and the weight already carried. */
  capacity: { used: number; total: number };
  /** Bandage healing at the current medbay level, so the base and the medbay button agree. */
  healPerBandage: number;
}

export function buildBasePanel(input: {
  base: BaseState;
  inventory: Inventory;
  upgrades: readonly BaseUpgradeDefinition[];
  recipes: readonly RecipeDefinition[];
  labelFor?: (itemId: string) => string;
  carriedWeight: number;
}): BasePanelView {
  const { base, inventory, upgrades, recipes, carriedWeight } = input;
  return {
    nodes: buildBaseNodes(base, inventory, upgrades),
    upgrades: buildUpgradeOptions(base, inventory, upgrades),
    recipes: buildRecipeOptions(base, inventory, recipes, input.labelFor),
    stash: buildStashOverview(inventory, recipes, upgrades),
    capacity: { used: carriedWeight, total: inventory.backpackCapacity },
    healPerBandage: healAmount(base, upgrades),
  };
}

export { MAX_NODE_LEVEL, MIN_NODE_LEVEL };
