import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createCombatRuntime,
  type CombatRuntime,
  type SceneState,
} from "./game/combat-runtime";
import {
  loadArenaCatalog,
  loadArenaManifest,
  type ArenaCatalog,
  type ArenaConfig,
} from "./game/content";
import { ContentValidationError } from "./game/content-format";
import {
  applyUpgrade,
  craft,
  repairGear,
  treatHero,
  type BaseState,
  type BaseUpgradeDefinition,
  type RecipeDefinition,
} from "./game/base";
import { buildBasePanel } from "./game/base-view";
import {
  buildBreakdownView,
  buildCritView,
  postureOptions,
  statusViews,
} from "./game/combat-readout";
import { OVERWATCH_ACTIVATION_AP, buildOverwatchView } from "./game/combat-overwatch";
import { missionReadiness, restockAmmo } from "./game/combat-logistics";
import {
  TUTORIAL_STORAGE_KEY,
  advanceTutorial,
  buildTutorialView,
  dismissTutorial,
  initialTutorialState,
  isTutorialState,
  resumeTutorial,
  type TutorialState,
} from "./game/tutorial";
import {
  canRetreatFromMission,
  missionDefeat,
  missionVictory,
  retreatFromMission,
  returnFromMission,
  startMission,
  type CampaignState,
} from "./game/campaign";
import {
  deathPenalty,
  loadProgression,
  resolveDefeatRetry,
  resolveDefeatReturn,
  xpToNextLevel,
  type CharacterState,
  type ProgressionCatalog,
} from "./game/progression";
import {
  loadBaseUpgrades,
  loadItemEffects,
  loadItems,
  loadMissions,
  loadRecipes,
  loadReturnTables,
  loadRewards,
  loadZones,
  type ItemDefinition,
  type ItemEffectDefinition,
  type MissionDefinition,
  type RewardDefinition,
  type ReturnTableDefinition,
  validateCampaignCatalog,
} from "./game/campaign-content";
import { awardRewardTransition } from "./game/rewards";
import {
  assignQuickSlot,
  depositBackpack,
  equipmentDurabilityPercent,
  freeCapacity,
  RESOURCE_LABELS,
  totalWeight,
  transferItem,
  transferResource,
  type Inventory,
} from "./game/inventory";
import {
  createLocalStorageAdapter,
  defaultSave,
  SAVE_SCHEMA_VERSION,
  type SaveData,
  type BattlePhase,
  SaveValidationError,
} from "./game/save";
import {
  canPickUp,
  evaluateObjective,
  initialObjectiveState,
  objectiveProgress,
  pickUpObjective,
  type ObjectiveContext,
  type ObjectiveState,
} from "./game/objective";
import {
  canBeginTransition,
  persistEnemyPhase,
  resolveEnemyPhase,
  resumePersistedEnemyPhase,
} from "./game/session";
import { nextRandom } from "./game/rng";
import {
  AP_PER_TURN,
  ATTACKS,
  calculateHitBreakdown,
  canMove,
  cellKey,
  clearMalfunction,
  defensiveCover,
  findReachable,
  hasLineOfSight,
  isAlive,
  performCombatAttack,
  postureChangeCost,
  POSTURES,
  reloadWeapon,
  type BodyPart,
  type Point,
  type Posture,
  type Unit,
} from "./game/combat";
import {
  loadEquipmentCatalog,
  syncEquipmentInstances,
  unlinkDestroyedEquipment,
  type EquipmentCatalog,
} from "./game/equipment-content";
import { useQuickSlot } from "./game/quick-slot";
import { buildQuickSlotBar, quickSlotShortcutLabel } from "./game/quick-slot-view";
import { dismantleEquipment, dismantleItem, linkedEquipmentInstanceIds } from "./game/dismantle";
import { buildDismantlePanel } from "./game/dismantle-view";
import { PROPOSED_BACKPACK_LOSS_POLICY } from "./game/death-loss";
import { buildDeathLossView } from "./game/death-loss-view";
import { createEncounterUnits } from "./game/encounter";
import { campaignCatalogFor, campaignMissionsOf } from "./game/campaign-catalog";
import {
  buildCombatScreen,
  buildEquipmentState,
  type CombatControlId,
  type MoveOption,
} from "./game/combat-view";
import { selectBootView } from "./game/boot-view";
import { resolveCombatShortcut } from "./game/input-gating";
import "./app.css";

type Phase = "player" | "enemy" | "victory" | "defeat";
interface Catalog {
  missions: MissionDefinition[];
  rewards: RewardDefinition[];
  arenas: ArenaCatalog;
  recipes: RecipeDefinition[];
  upgrades: BaseUpgradeDefinition[];
  items: ItemDefinition[];
  /** W5-03 quick-slot effects, validated at boot against `items` and the equipment catalog. */
  itemEffects: ItemEffectDefinition[];
  /** W5-04 dismantle returns, validated at boot against `items`, `equipment` and `recipes`. */
  returnTables: ReturnTableDefinition[];
  equipment: EquipmentCatalog;
  progression: ProgressionCatalog;
}
/** Mission-start units. Shared with the balance simulator so both build identical state. */
const initialUnits = createEncounterUnits;
const LOADING_CAMPAIGN: CampaignState = {
  catalogId: "loading",
  screen: "home",
  activeMissionId: null,
  activeMapId: null,
  mission: {
    id: "loading",
    status: "locked",
    victories: 0,
    firstRewardClaimed: false,
    mapId: "loading",
    arenaId: "loading",
    rewardId: "loading",
  },
  encounters: [],
  zone: { id: "loading", status: "available" },
  firstDeathReturnUsed: false,
  returnReason: null,
  xp: 0,
  claimedRewards: [],
};
const LOADING_CHARACTER: CharacterState = { level: 1, xp: 0, unspentSkillPoints: 0 };

const saveCatalogFor = (catalog: Catalog) =>
  campaignCatalogFor({
    catalogId: catalog.arenas.catalogId,
    missions: catalog.missions,
    rewardIds: catalog.rewards.map((reward) => reward.id),
    arenaIds: catalog.arenas.all.map((arena) => arena.id),
    items: catalog.items,
    equipment: catalog.equipment,
    progression: catalog.progression.curve,
  });

/** Level + progress-to-next, rendered identically on the base and reward screens (W4-01 §4). */
const levelSummary = (character: CharacterState, catalog: Catalog | null) => {
  const curve = catalog?.progression.curve;
  const toNext = xpToNextLevel(character.xp, curve);
  return `Уровень ${character.level} · XP ${character.xp}${
    toNext === null ? " · максимальный уровень" : ` · до уровня ${character.level + 1}: ${toNext} XP`
  } · нераспределённых очков: ${character.unspentSkillPoints}`;
};
const itemLabel = (id: string, catalog: Catalog) =>
  catalog.items.find((item) => item.id === id)?.name ??
  catalog.equipment.weapons.find((item) => item.id === id)?.name ??
  catalog.equipment.armor.find((item) => item.id === id)?.name ??
  id;

const repairTarget = (
  inventory: NonNullable<SaveData["inventory"]>,
  hero: Unit | undefined,
) => {
  const ids = [
    hero?.weaponState?.weaponInstanceId,
    hero?.armor?.armorInstanceId,
  ].filter((id): id is string => Boolean(id));
  return inventory.equipment.filter((entry) => ids.includes(entry.instanceId));
};
const repairCostText = (
  target: ReturnType<typeof repairTarget>[number] | null,
) =>
  target
    ? `${Math.ceil(Math.max(0, target.maxDurability - target.durability) / 10) * 2} металл`
    : "нет цели";

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<CombatRuntime | null>(null);
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const latest = useRef<{
    move: (x: number, y: number) => void;
    select: (id: string) => void;
    hover: (x: number, y: number) => void;
  }>({ move: () => {}, select: () => {}, hover: () => {} });
  const saveAdapter = useMemo(() => createLocalStorageAdapter(), []);
  const [arena, setArena] = useState<ArenaConfig | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [save, setSave] = useState<SaveData | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [part, setPart] = useState<BodyPart>("torso");
  const [phase, setPhase] = useState<Phase>("player");
  const [log, setLog] = useState("Загрузка убежища…");
  const [hover, setHover] = useState<Point | null>(null);
  const [saveStatus, setSaveStatus] = useState("Сохранение не выполнено.");
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [rewardClaimLocked, setRewardClaimLocked] = useState(false);
  const rewardClaimInFlight = useRef(false);
  const [recovery, setRecovery] = useState<{
    error: SaveValidationError | ContentValidationError;
     backupSucceeded: boolean;
     content: boolean;
     allowReset?: boolean;
  } | null>(null);
  const [selectedBackpackItem, setSelectedBackpackItem] = useState<
    string | null
  >(null);
  /**
   * W5-04 — the entry the player has been asked to confirm before an irreversible dismantle.
   *
   * Shell state rather than `window.confirm`: a native dialog cannot be asserted by the DOM tests,
   * cannot be reached by a screen reader in the same flow as the button, and would block the render
   * thread. Holding the pending id here makes the two-press confirmation visible in the markup.
   */
  const [confirmingDismantle, setConfirmingDismantle] = useState<string | null>(null);
  const [movesExpanded, setMovesExpanded] = useState(false);
  /**
   * W7-05 — onboarding progress, kept **outside** the save.
   *
   * Criterion 5 asks that the tutorial not require a special save, and that is the right model: a tutorial flag is
   * a preference, not campaign state. It has no catalog references, no cross-field invariants, and it should
   * survive a save reset — wiping a campaign does not unlearn the controls. So it lives under its own key and
   * costs no schema migration.
   *
   * Read lazily and defensively: a malformed value falls back to "show the tutorial" rather than throwing, because
   * a broken preference must never stop the game from booting.
   */
  const [tutorial, setTutorial] = useState<TutorialState>(() => {
    try {
      const raw = window.localStorage.getItem(TUTORIAL_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return isTutorialState(parsed) ? parsed : initialTutorialState();
    } catch {
      return initialTutorialState();
    }
  });
  const persistTutorial = (next: TutorialState) => {
    setTutorial(next);
    /* A full localStorage must not break the game: the tutorial simply reappears next session. */
    try {
      window.localStorage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignored on purpose */
    }
  };
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window === "undefined" ? 0 : window.innerWidth),
  );
  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);
  const bootView = selectBootView({
    arena,
    catalog,
    save,
    recovery: recovery
      ? { message: recovery.error.message, content: recovery.content }
      : null,
    log,
  });
  const campaign = bootView.ready?.campaign ?? LOADING_CAMPAIGN;
  const character = save?.character ?? LOADING_CHARACTER;
  const campaignMissions = catalog ? campaignMissionsOf(catalog.missions) : undefined;
  /** W6-01 — the persisted half of objective progress; everything else is derived from the board. */
  const objectiveState = save?.objective ?? initialObjectiveState();
  const inventory = save?.inventory;
  const base = save?.base;
  const hero = units.find((unit) => unit.id === "hero");
  /**
   * W5-01/W5-02 — the whole base panel as data: node ladders, upgrade options, recipe options and
   * the stash overview, each carrying its own availability and refusal reason. Computed by
   * `buildBasePanel` from the same domain predicates the transitions use, so the shell renders
   * strings and never decides whether an action is legal.
   */
  const basePanel = useMemo(
    () =>
      catalog && inventory && base
        ? buildBasePanel({
            base,
            inventory,
            upgrades: catalog.upgrades,
            recipes: catalog.recipes,
            labelFor: (itemId) => itemLabel(itemId, catalog),
            carriedWeight: totalWeight(inventory),
          })
        : null,
    [base, catalog, inventory],
  );
  /**
   * W5-03 — the four quick slots as data, priced and gated by the same `quickSlotBlocker` the
   * transition checks. The bar renders on the combat screen; the model is built here so the keyboard
   * handler and the buttons read one source.
   */
  const quickSlotBar = useMemo(
    () =>
      catalog && inventory
        ? buildQuickSlotBar({ hero, inventory, effects: catalog.itemEffects, phase })
        : null,
    [catalog, hero, inventory, phase],
  );
  /**
   * W5-04 — every dismantle candidate with its exact return, computed from the shipped table.
   * `units` is passed so worn gear is marked rather than silently destroyed.
   */
  const dismantlePanel = useMemo(
    () =>
      catalog && inventory
        ? buildDismantlePanel({
            inventory,
            returnTable: catalog.returnTables,
            units,
            labelFor: (itemId) => itemLabel(itemId, catalog),
            confirmingId: confirmingDismantle,
          })
        : null,
    [catalog, confirmingDismantle, inventory, units],
  );
  const activeMission = catalog ? catalog.missions.find((entry) => entry.id === (campaign.activeMissionId ?? campaign.mission.id)) ?? catalog.missions[0] : null;
  /**
   * W6-01 — the inputs the objective evaluator and its progress readout both read.
   *
   * One builder rather than two call sites assembling the same context, because a progress bar computed
   * from different inputs than the completion rule is exactly how a UI starts lying about the mission.
   * `units`/`state`/`turn` are parameters instead of closure reads so a handler can evaluate the board
   * it is *about to* persist rather than the one already rendered.
   */
  const objectiveContextFor = (
    contextUnits: readonly Unit[],
    state: ObjectiveState,
    turn: number,
  ): ObjectiveContext => ({
    params: activeMission?.objectiveParams ?? { kind: "eliminate" },
    state,
    units: contextUnits,
    turn,
    turnLimit: activeMission?.turnLimit,
  });
  /** W6-01 — the per-turn readout (criterion 2), from the same inputs the completion rule reads. */
  const objectiveView =
    campaign.screen === "mission" && activeMission
      ? objectiveProgress(objectiveContextFor(units, objectiveState, save?.turn ?? 1))
      : null;
  /** The active objective as the enemy phase needs it, so `session.ts` stays free of catalog types. */
  const objectiveResolution = {
    params: activeMission?.objectiveParams ?? ({ kind: "eliminate" } as const),
    turnLimit: activeMission?.turnLimit,
  };
  /** Whether the pickup control would do anything, read by both its label and its handler. */
  const canTakeObjective =
    phase === "player" &&
    campaign.screen === "mission" &&
    canPickUp(objectiveContextFor(units, objectiveState, save?.turn ?? 1));
  const activeReward = catalog && activeMission ? catalog.rewards.find((entry) => entry.id === activeMission.rewardId) ?? null : null;
  /**
   * The penalty the player is shown *before* confirming the return, and the exact object that is
   * applied when they do. Computed by `deathPenalty` and never re-derived here (W4-02 criterion 4).
   */
  const pendingPenalty = campaign.screen === "return" ? deathPenalty(campaign, catalog?.progression.curve) : null;
  /**
   * W5-05 — the loot half of the same return, previewed with the *same call* that will be committed.
   *
   * `buildDeathLossView` runs the pure `applyBackpackDeathLoss` once and carries the resulting
   * inventory, so `returnHome` commits exactly the list this screen displayed instead of recomputing
   * it (criterion 4). The policy is `PROPOSED_BACKPACK_LOSS_POLICY` and is rendered as an explicit
   * proposal: decision D-01 is open, so the number is labelled rather than presented as balance.
   */
  const pendingLoss = useMemo(
    () =>
      campaign.screen === "return" && inventory && catalog
        ? buildDeathLossView({
            inventory,
            policy: PROPOSED_BACKPACK_LOSS_POLICY,
            reason: campaign.returnReason,
            firstDeathReturnUsed: campaign.firstDeathReturnUsed,
            labelFor: (itemId) => itemLabel(itemId, catalog),
          })
        : null,
    [campaign.firstDeathReturnUsed, campaign.returnReason, campaign.screen, catalog, inventory],
  );
  const persist = (
    nextUnits: Unit[],
    nextPhase: Phase = phase,
    nextCampaign = campaign,
    nextInventory = inventory,
    nextBase: BaseState | undefined = base,
    nextTurn = save?.turn ?? 1,
    nextRngState = save?.rngState ?? 0,
    nextArena: ArenaConfig | null = arena,
    /* Only the two XP-changing transitions pass this: a reward claim and a death penalty. */
    nextCharacter: CharacterState = character,
    /**
     * W6-01 — objective progress.
     *
     * Defaults to the current state rather than to a fresh one, so an ordinary persist (an attack, a
     * quick slot, a move) carries the objective forward instead of silently resetting a hold count.
     * `beginMission` and the terminal transitions pass a fresh state explicitly; the save validator
     * requires it to be inert outside a mission, so forgetting to reset is a caught error rather than
     * a state a later mission inherits.
     */
    nextObjective: ObjectiveState = objectiveState,
  ) => {
     if (!nextArena || !nextInventory || !nextBase || !save) return;
     const persistedInventory = syncEquipmentInstances(nextInventory, nextUnits);
     const next: SaveData = {
      schemaVersion: SAVE_SCHEMA_VERSION,
      arenaId: nextArena.id,
      activeEncounterId: nextCampaign.activeMissionId,
      units: nextUnits,
      phase: nextPhase as BattlePhase,
      campaign: nextCampaign,
      character: nextCharacter,
       inventory: persistedInventory,
      base: nextBase,
      turn: nextTurn,
      rngState: nextRngState,
      objective: nextCampaign.screen === "mission" ? nextObjective : initialObjectiveState(),
    };
    const result = saveAdapter.saveDetailed(next);
    setSaveStatus(
      result.ok
        ? "Сохранено локально."
        : `Ошибка сохранения: ${result.error ?? "неизвестная ошибка"}`,
    );
    setSaveFailure(result.ok ? null : (result.error ?? "неизвестная ошибка"));
    if (!result.ok) return false;
    setSave(next);
    setArena(nextArena);
    setUnits(nextUnits);
    setPhase(nextPhase);
    return true;
  };
  const retrySave = () => {
    if (!save) return;
    const candidate = save.phase === "enemy" && arena ? resolveEnemyPhase(save, arena) : save;
    const result = saveAdapter.saveDetailed(candidate);
    setSaveStatus(
      result.ok
        ? "Сохранение повторено успешно."
        : `Ошибка сохранения: ${result.error ?? "неизвестная ошибка"}`,
    );
    setSaveFailure(result.ok ? null : (result.error ?? "неизвестная ошибка"));
    if (!result.ok) return;
    if (save.phase === "enemy" && arena) {
      inFlight.current = false;
      timer.current = null;
      setSave(candidate);
      setUnits(candidate.units);
      setPhase(candidate.phase);
      setLog(candidate.phase === "defeat" ? "Оперативник выведен из строя. Возврат на базу." : "Ваш ход: ОЧ восстановлены.");
    }
  };
  const aliveEnemies = units.filter(
    (unit) => unit.team === "enemy" && isAlive(unit),
  );
  const target =
    units.find((unit) => unit.id === targetId && isAlive(unit)) ?? null;
  const fullCover = useMemo(
    () =>
      new Set(
        (arena?.cover ?? [])
          .filter((cover) => cover.type === "full")
          .map((cover) => cellKey(cover.x, cover.y)),
      ),
    [arena],
  );
  const occupied = useMemo(
    () =>
      new Set(
        units
          .filter((unit) => isAlive(unit) && unit.id !== hero?.id)
          .map((unit) => cellKey(unit.x, unit.y)),
      ),
    [hero?.id, units],
  );
  const reachability = useMemo(
    () =>
      hero &&
      arena &&
      campaign.screen === "mission" &&
      phase === "player" &&
      canMove(hero)
        ? findReachable(
            hero,
            hero.ap,
            arena.width,
            arena.height,
            new Set([...fullCover, ...occupied]),
          )
        : {
            paths: new Map<string, Point[]>(),
            costs: new Map<string, number>(),
          },
    [arena, campaign.screen, fullCover, hero, occupied, phase],
  );
  const reachable = useMemo(
    () =>
      new Set(
        [...reachability.costs.keys()].filter(
          (key) => key !== cellKey(hero?.x ?? -1, hero?.y ?? -1),
        ),
      ),
    [hero?.x, hero?.y, reachability],
  );
  const targetable = useMemo(
    () =>
      new Set(
        aliveEnemies
          .filter(
            (enemy) =>
              hero &&
              hasLineOfSight(
                hero,
                enemy,
                new Set([
                  ...fullCover,
                  ...units
                    .filter(
                      (unit) =>
                        isAlive(unit) &&
                        unit.id !== hero.id &&
                        unit.id !== enemy.id,
                    )
                    .map((unit) => cellKey(unit.x, unit.y)),
                ]),
              ),
          )
          .map((enemy) => cellKey(enemy.x, enemy.y)),
      ),
    [aliveEnemies, fullCover, hero, units],
  );
  const breakdown =
    hero && target && arena
      ? calculateHitBreakdown(
          hero,
          target,
          part,
          defensiveCover(
            hero,
            target,
            arena.cover.map((cover) => ({ ...cover, kind: cover.type })),
          ),
        )
      : null;
  /**
   * W6-03 — the three readouts the model already produced and the screen used to discard.
   *
   * `breakdown` above carries eleven fields and only `final`/`damage` were rendered; the crit chance had no
   * UI at all; statuses appeared solely on the Phaser canvas as raw English keys with their turn counters
   * dropped; posture prices were discoverable only by clicking. All three are view models rather than JSX so
   * the test can compare the displayed terms against the model's own total (criterion 2).
   */
  const breakdownView = breakdown ? buildBreakdownView(breakdown, part) : null;
  const critView = hero && target ? buildCritView(hero, part) : null;
  const heroStatuses = statusViews(hero?.statuses);
  const postures = postureOptions(hero, phase);
  /**
   * W6-05 — the pre-mission gear check (criteria 2 and 5).
   *
   * Reads the live weapon off the hero rather than the inventory instance, because that is what the mission
   * actually starts with: `hydrateArenaUnits` carries magazine, reserve and durability forward from the
   * persistent instance. Reports rather than blocks — leaving with a nearly-broken weapon is a legitimate
   * choice; leaving *without knowing* was the defect.
   */
  /**
   * W7-05 — the hint due right now, derived from the board rather than from a stored step counter.
   *
   * A stored position would be a second source of truth about the same situation and would desync the moment the
   * player did something out of order — which in a tactical game is most of the time. Deriving it means a hint can
   * never describe a state the player has already left.
   */
  const tutorialView = buildTutorialView({
    state: tutorial,
    screen: campaign.screen,
    phase,
    hero,
    enemiesAlive: units.filter((unit) => unit.team === "enemy" && isAlive(unit)).length,
    hasTarget: Boolean(target),
    /* "Has acted" is AP below a full turn: the hero has moved, shot or changed posture. */
    heroHasActed: (hero?.ap ?? AP_PER_TURN) < AP_PER_TURN,
    completedEncounters: campaign.encounters.filter((entry) => entry.status === "completed").length,
  });
  const readiness = missionReadiness(
    hero,
    save?.inventory.equipment.find((entry) => entry.instanceId === hero?.armor?.armorInstanceId),
  );

  /**
   * W6-04 — the Overwatch readout.
   *
   * `reservedAp` appeared exactly once in this file before now, on the write at activation; the −15 reaction
   * penalty appeared nowhere outside `combat.ts`. Overwatch is committed a whole enemy turn in advance, which
   * is precisely when the player needs both numbers rather than after the reaction has resolved.
   */
  const overwatchView = buildOverwatchView({
    hero,
    phase,
    target: target ?? undefined,
    targetCover:
      hero && target && arena
        ? defensiveCover(hero, target, arena.cover.map((cover) => ({ ...cover, kind: cover.type })))
        : "none",
  });
  const sceneState: SceneState = {
    units,
    selectedId: "hero",
    targetId,
    reachable,
    targetable,
    hover,
    path: hover
      ? (reachability.paths.get(cellKey(hover.x, hover.y)) ?? [])
      : [],
  };
  const updateScene = () => game.current?.updateState(sceneState);
  function select(id: string) {
    const unit = units.find((candidate) => candidate.id === id);
    if (!unit || !isAlive(unit) || phase !== "player") return;
    if (unit.team === "enemy") {
      const visible = targetable.has(cellKey(unit.x, unit.y));
      setTargetId(visible ? unit.id : null);
      setLog(
        visible
          ? `Цель: ${unit.name}. Выберите часть тела.`
          : `${unit.name}: нет прямой линии огня.`,
      );
    }
  }
  function move(x: number, y: number) {
    if (!hero || phase !== "player") return;
    const cost = reachability.costs.get(cellKey(x, y));
    if (!cost || !reachability.paths.get(cellKey(x, y)) || !canMove(hero))
      return setLog("Клетка недоступна.");
    const next = units.map((unit) =>
      unit.id === hero.id ? { ...unit, x, y, ap: unit.ap - cost } : unit,
    );
    /**
     * W6-01 — a move can now *finish* a mission, so it goes through the objective evaluator.
     *
     * `escape` completes by standing on the exit and `retrieve` by carrying the item there, which means
     * movement is a mission-ending action for two of the four objective types. Before this, only an
     * attack could end an encounter.
     */
    if (
      !settleObjective(next, inventory!, save?.turn ?? 1, save?.rngState ?? 0, {
        onActive: () => setLog(`Перемещение: −${cost} ОЧ.`),
      })
    )
      return;
    setTargetId(null);
    setHover(null);
    /* Collapse the full cell list after a move so the panel stays compact. */
    setMovesExpanded(false);
    requestAnimationFrame(() => disclosureRef.current?.focus());
  }
  /**
   * W6-01 — takes the objective item (`retrieve`).
   *
   * A distinct action rather than an automatic pickup on arrival: the objective item is not inventory
   * (it never enters the backpack and has no weight), so an implicit pickup would be an invisible state
   * change on a cell the player may have simply walked across. `pickUpObjective` refuses rather than
   * no-opping, so the button cannot report success for nothing.
   */
  function takeObjective() {
    if (!hero || phase !== "player" || !inventory || !save) return;
    const context = objectiveContextFor(units, objectiveState, save.turn);
    const picked = pickUpObjective(context);
    if (!picked) return setLog("Забрать груз можно только стоя на его клетке.");
    if (
      !settleObjective(units, inventory, save.turn, save.rngState, {
        nextObjective: picked,
        onActive: () => setLog("Груз забран. Доберитесь до точки выхода."),
      })
    )
      return;
  }
  /**
   * W6-03 — changes posture, and explains a refusal in the terms the button already showed.
   *
   * Previously both refusals produced «Смена позы сейчас недоступна.», so a player could not tell a
   * permanent rule (standing→prone is forbidden; crouch first) from a temporary shortage of two AP. The
   * message now comes from `postureOptions`, which is the same source the button's own label reads — so the
   * control and the handler cannot disagree about why.
   */
  function changePosture(next: Posture) {
    if (!hero || phase !== "player") return;
    const option = postures.find((entry) => entry.id === next);
    const cost = postureChangeCost(hero.posture, next);
    if (!option?.available || cost === null || hero.ap < cost)
      return setLog(option?.reason || "Смена позы сейчас недоступна.");
     if (!persist(
       units.map((unit) =>
         unit.id === hero.id
           ? { ...unit, posture: next, ap: unit.ap - cost }
           : unit,
       ),
     )) return;
     setLog(`Поза: ${POSTURES[next].label} (−${cost} ОЧ).`);
  }
  function attack() {
    if (
      !hero ||
      !target ||
      !breakdown ||
      !arena ||
      phase !== "player" ||
      !inventory ||
      !base ||
      !save
    )
      return;
    const blockers = new Set([
      ...fullCover,
      ...units
        .filter(
          (unit) =>
            isAlive(unit) && unit.id !== hero.id && unit.id !== target.id,
        )
        .map((unit) => cellKey(unit.x, unit.y)),
    ]);
    if (!hasLineOfSight(hero, target, blockers))
      return setLog("Линия огня перекрыта.");
    let rngState = save.rngState;
    const roll = () => {
      const next = nextRandom(rngState);
      rngState = next.state;
      return next.value;
    };
    const action = performCombatAttack(
      hero,
      target,
      part,
      defensiveCover(
        hero,
        target,
        arena.cover.map((cover) => ({ ...cover, kind: cover.type })),
      ),
      { malfunction: roll(), hit: roll(), crit: roll() },
    );
    if (!action.ok)
      return setLog(
        action.reason === "no-ammo"
          ? "Магазин пуст: перезарядите оружие."
          : action.reason === "malfunctioned"
            ? "Осечка: очистите оружие за 2 ОЧ."
            : "Недостаточно ОЧ.",
      );
    const next = units.map((unit) =>
      unit.id === hero.id
        ? action.attacker
        : unit.id === target.id
          ? action.target
          : unit,
    );
    const actionInventory = {
      ...inventory,
      equipment: inventory.equipment.map((entry) =>
        entry.instanceId === action.attacker.weaponState?.weaponInstanceId
          ? {
              ...entry,
              durability: action.attacker.weaponState.durability,
              maxDurability: action.attacker.weaponState.maxDurability,
            }
          : entry,
      ),
    };
    /**
     * W6-01 — the objective decides, not "every enemy is dead".
     *
     * This used to be an inlined `every((unit) => !isAlive(unit))` on the enemy team, which is why the
     * `secure` mission was a renamed cleanup. `settleObjective` runs the one evaluator and returns the
     * transition, so an attack that clears the last enemy of an `eliminate` mission and an attack that
     * merely wounds someone on an `escape` mission take the same code path.
     */
    if (
      !settleObjective(next, actionInventory, save.turn, rngState, {
        onActive: () =>
          setLog(
            action.malfunctioned
              ? "Осечка: ОЧ, патрон и durability израсходованы; очистите оружие за 2 ОЧ."
              : action.resolution?.hit
                ? `Попадание: ${action.resolution.damage} урона.`
                : "Промах.",
          ),
      })
    )
      return;
  }
  /**
   * W6-01 — evaluates the mission objective after a player action and persists whatever it decided.
   *
   * One place, because every action that can finish a mission has to reach the same verdict: an attack
   * that kills the last enemy, a move onto the exit cell, a pickup that completes a delivery. Before
   * this, only the attack handler could end a mission, and only by clearing the board.
   *
   * Returns `false` when the persist failed, so callers can bail exactly as they did with `persist`.
   * `onActive` is the caller's own message for "the mission continues", which is the only part of the
   * outcome this function has no opinion about.
   */
  function settleObjective(
    nextUnits: Unit[],
    nextInventory: Inventory,
    nextTurn: number,
    nextRngState: number,
    handlers: { onActive?: () => void; nextObjective?: ObjectiveState } = {},
  ): boolean {
    if (!catalog || !base || !save) return false;
    const state = handlers.nextObjective ?? objectiveState;
    const evaluation = evaluateObjective(objectiveContextFor(nextUnits, state, nextTurn));
    if (evaluation.outcome === "complete") {
      const nextCampaign = missionVictory(campaign, catalog.missions);
      if (!persist(nextUnits, "victory", nextCampaign, nextInventory, base, nextTurn, nextRngState, arena, character, evaluation.state))
        return false;
      setTargetId(null);
      setLog(`${evaluation.reason} Награда готова на базе.`);
      return true;
    }
    if (evaluation.outcome === "failed") {
      /**
       * The third way a mission can end (W6-01 criterion 4). Routed through `missionDefeat` because the
       * encounter bookkeeping is identical — `failed`, retryable, no reward — but the *reason* shown to
       * the player is the objective's, not "you were knocked out". The hero is still alive here.
       */
      const nextCampaign = missionDefeat(campaign);
      if (!persist(nextUnits, "defeat", nextCampaign, nextInventory, base, nextTurn, nextRngState, arena, character, initialObjectiveState()))
        return false;
      setTargetId(null);
      setLog(`Цель провалена. ${evaluation.reason}`);
      return true;
    }
    if (!persist(nextUnits, "player", campaign, nextInventory, base, nextTurn, nextRngState, arena, character, evaluation.state))
      return false;
    handlers.onActive?.();
    return true;
  }
  /**
   * W5-03 — applies the consumable in `index` during combat.
   *
   * One `persist` for the whole transition: the hero's HP/AP/weapon state and the inventory come out
   * of a single `useQuickSlot` result, so the save can never hold a healed hero who still carries the
   * bandage, or a spent bandage with no healing. Every refusal happens before anything is consumed,
   * and the message is the same sentence the slot's own label states.
   */
  function useSlot(index: number) {
    if (!catalog || !inventory || !base || !save || campaign.screen !== "mission") return;
    const used = useQuickSlot({ hero, inventory, effects: catalog.itemEffects, phase }, units, index);
    if (!used.ok) {
      const option = quickSlotBar?.options[index];
      return setLog(option?.reason ?? "Быстрый слот сейчас недоступен.");
    }
    const { value } = used;
    if (!persist(value.units, phase, campaign, value.inventory, base, save.turn, save.rngState)) return;
    setLog(
      `${itemLabel(value.itemId, catalog)}: ${value.applied}, −${value.apCost} ОЧ.${
        value.slotCleared ? ` Слот ${index + 1} освободился.` : ` Осталось: ${value.remaining}.`
      }`,
    );
  }
  /**
   * W5-04 — destroys one dismantle candidate and pays its table into the stash.
   *
   * Every destruction takes two presses: the first arms `confirmingDismantle` and changes nothing,
   * the second passes `confirmed` to the domain. The confirmation is an argument to the domain
   * function, not an assumption, so a code path that forgot to ask is refused rather than silently
   * destroying something.
   *
   * Gear the hero is actually using is refused outright — the domain decides this, and the panel
   * renders it as unavailable. Dismantling it would be unrecoverable: the arena templates hardcode
   * the loadout, so mission start would rebuild a reference to an instance that no longer exists and
   * `validateSave` would reject every subsequent save. See the note in `dismantle.ts`.
   *
   * `unlinkDestroyedEquipment` still runs on the spare-gear path. `syncEquipmentInstances` only
   * copies unit state *onto* a matching instance and has no opinion about a unit pointing at an
   * instance that no longer exists, which the save validator rejects; dropping the reference here
   * keeps the dismantle persistable.
   */
  function dismantle(id: string) {
    if (!catalog || !inventory || !base || !dismantlePanel) return;
    const option = dismantlePanel.options.find((entry) => entry.id === id);
    if (!option || option.disabled)
      return setLog(option?.reason ?? "Этот предмет нельзя разобрать.");
    if (option.requiresConfirmation) {
      setConfirmingDismantle(id);
      return setLog(
        `${option.label}: разборка необратима и вернёт ${option.returnsLabel}. Нажмите ещё раз для подтверждения.`,
      );
    }
    if (option.kind === "item") {
      const result = dismantleItem(inventory, option.itemId, catalog.returnTables);
      if (!result.ok) return setLog(option.reason || "Разборка недоступна.");
      setConfirmingDismantle(null);
      if (!persist(units, "player", campaign, result.value.inventory, base)) return;
      return setLog(`${option.label} разобран: в stash ${option.returnsLabel}.`);
    }
    const result = dismantleEquipment(inventory, id, catalog.returnTables, {
      linkedInstanceIds: linkedEquipmentInstanceIds(units),
      confirmed: option.confirming,
    });
    if (!result.ok) return setLog(option.reason || "Разборка недоступна.");
    setConfirmingDismantle(null);
    const nextUnits = unlinkDestroyedEquipment(result.value.inventory, units);
    if (!persist(nextUnits, "player", campaign, result.value.inventory, base)) return;
    setLog(`${option.label} разобран безвозвратно: в stash ${option.returnsLabel}.`);
  }
  function reload() {
    if (!hero || !hero.weaponState || phase !== "player") return;
    const next = reloadWeapon(hero);
    if (!next)
      return setLog("Перезарядка недоступна: проверьте ОЧ, магазин и резерв.");
     if (!persist(units.map((unit) => (unit.id === hero.id ? next : unit)))) return;
     setLog("Оружие перезаряжено.");
  }
  function clearJam() {
    if (!hero || phase !== "player") return;
    const next = clearMalfunction(hero);
    if (!next) return setLog("Очистка осечки недоступна.");
     if (!persist(units.map((unit) => (unit.id === hero.id ? next : unit)))) return;
     setLog("Осечка устранена.");
  }
  function resolveEnemy(snapshot: SaveData, overwatch = false) {
    if (!arena || !inventory || !base) return;
     /* W6-01: the enemy phase now also advances the objective clock — a `secure` hold is counted per
        resolved turn, and a `retrieve`/`escape` deadline expires on one. */
     const resolved = resolveEnemyPhase(snapshot, arena, objectiveResolution);
     if (!persist(
       resolved.units,
       resolved.phase,
       resolved.campaign,
       resolved.inventory,
       resolved.base,
       resolved.turn,
       resolved.rngState,
       arena,
       character,
       resolved.objective,
     )) return;
     inFlight.current = false;
     timer.current = null;
     /* A mission can now end on the enemy's turn for a reason that is not a defeat: the hold completed,
        or the deadline passed while the hero is perfectly healthy. */
     const objectiveEnded = resolved.campaign.screen !== "mission";
     setLog(
      resolved.phase === "victory"
        ? "Цель выполнена. Награда готова на базе."
        : resolved.phase === "defeat"
          ? objectiveEnded && isAlive(resolved.units.find((unit) => unit.id === "hero")!)
            ? "Цель провалена: время вышло. Возврат на базу."
            : "Оперативник выведен из строя. Возврат на базу."
          : overwatch
            ? "Overwatch завершён. Ваш ход."
            : "Ваш ход: ОЧ восстановлены.",
    );
  }
   function endTurn(overwatch = false) {
     if (!save || campaign.screen !== "mission" || !canBeginTransition(inFlight.current, phase)) return;
    const snapshot = overwatch
      ? units.map((unit) =>
          unit.id === "hero"
            ? {
                ...unit,
                ap: 0,
                overwatch: { reservedAp: Math.max(0, unit.ap - OVERWATCH_ACTIVATION_AP) },
              }
            : unit,
        )
      : units.map((unit) => ({ ...unit }));
    const enemy = persistEnemyPhase(saveAdapter, { ...save, units: snapshot });
    if (!enemy)
      return setSaveFailure(
        "Не удалось синхронно записать enemy-фазу. Повторите действие.",
      );
    inFlight.current = true;
    setSave(enemy);
    setUnits(snapshot);
    setPhase("enemy");
    setSaveStatus("Enemy-фаза сохранена; ход противника…");
    setLog("Ход противника…");
    timer.current = window.setTimeout(
      () => resolveEnemy(enemy, overwatch),
      300,
    );
  }
  /**
   * W6-04 — activates Overwatch, refusing with the reason the control already showed.
   *
   * The gate was the literal `6`, which is really `OVERWATCH_ACTIVATION_AP + torso.apCost` — the same rule
   * written three times in this file and a fourth time as an unused constant in `combat.ts`. Derived now, so
   * repricing a torso shot cannot leave a reserve too small to ever fire.
   */
   function activateOverwatch() {
     if (campaign.screen !== "mission" || !overwatchView.available)
       return setLog(overwatchView.reason || "Overwatch сейчас недоступен.");
     endTurn(true);
   }
   function retreat() {
     if (!inventory || !base || !save || !canRetreatFromMission(campaign) || inFlight.current || phase === "enemy") return;
     const nextCampaign = retreatFromMission(campaign);
     if (!persist(units, "defeat", nextCampaign, inventory, base, save.turn, save.rngState)) return;
     setTargetId(null);
     setHover(null);
     setMovesExpanded(false);
     setLog("Отступление: миссия провалена, награда не получена. Оперативник эвакуирован.");
   }
   function beginMission(missionId = campaign.mission.id) {
    if (!catalog || !inventory || !base) return;
    const selected = catalog.missions.find((entry) => entry.id === missionId);
    const selectedArena = selected && catalog.arenas.byId.get(selected.arenaId);
    if (!selected || !selectedArena) return setLog("Карта encounter не найдена в каталоге.");
    const nextCampaign = startMission(campaign, selected.id, catalog.missions);
    if (nextCampaign === campaign) return;
     if (!persist(initialUnits(selectedArena, catalog.equipment, inventory, units), "player", nextCampaign, inventory, base, 1, save?.rngState ?? 0, selectedArena)) return;
     setTargetId(null);
    setHover(null);
    setMovesExpanded(false);
    setLog(`Миссия началась: ${selected.name}.`);
  }
  function openMissionSelect() {
    if (inventory && base)
      persist(
        units,
        "player",
        { ...campaign, screen: "mission-select" },
        inventory,
        base,
      );
  }
  /** Message for a resolved defeat/retreat return. Reads the penalty object; computes nothing. */
  const penaltyLog = (penalty: ReturnType<typeof deathPenalty>) =>
    penalty.reason === "retreat"
      ? "Отступление завершено: награда не получена, XP сохранён. Рюкзак разгружен в stash."
      : penalty.firstDeathFree
        ? "Первое поражение без штрафа XP. Повторное поражение будет стоить XP. Рюкзак разгружен в stash."
        : `Поражение: −${penalty.xpLost} XP (уровень ${penalty.level} сохранён). Рюкзак разгружен в stash.`;
  function returnHome() {
    if (!inventory || !base) return;
    if (campaign.screen !== "return") {
      if (!persist(units, "player", returnFromMission(campaign), depositBackpack(inventory), base)) return;
      return setLog("Возврат на базу завершён. Рюкзак разгружен в stash.");
    }
    const resolved = resolveDefeatReturn(campaign, character, catalog?.progression.curve);
    /**
     * W5-05 — the loot penalty is applied from `pendingLoss.inventory`, i.e. the *same* object the
     * screen previewed, and only then deposited. Order matters: charging the penalty after the
     * deposit would take from the stash, which is precisely what the ticket forbids.
     */
    const afterLoss = pendingLoss?.applies && pendingLoss.inventory ? pendingLoss.inventory : inventory;
    if (!persist(units, "player", resolved.campaign, depositBackpack(afterLoss), base, save?.turn ?? 1, pendingLoss?.rngState ?? save?.rngState ?? 0, arena, resolved.character)) return;
    const lossLog = pendingLoss?.applies && pendingLoss.lostUnits > 0
      ? ` Потеряно из рюкзака: ${pendingLoss.lines.map((line) => `${line.label} ×${line.lost}`).join(", ")}.`
      : "";
    setLog(`${penaltyLog(resolved.penalty)}${lossLog}`);
  }
  function retryMission() {
    if (!catalog || !inventory || !base) return;
    const selected = catalog.missions.find((entry) => entry.id === campaign.mission.id);
    const selectedArena = selected && catalog.arenas.byId.get(selected.arenaId);
    if (!selected || !selectedArena) return;
    /* Re-entering immediately costs the same as walking home: retry is not a free undo. */
    const resolved = resolveDefeatRetry(campaign, character, catalog.missions, catalog.progression.curve);
    if (resolved.campaign === campaign) return;
    /* W5-05: the loot penalty is charged on this exit too, for the same reason the XP one is — a
       retry that skipped it would be the cheapest way out of a defeat, and the preview the player
       just read would have been wrong about what leaving costs. */
    const afterLoss = pendingLoss?.applies && pendingLoss.inventory ? pendingLoss.inventory : inventory;
     if (!persist(initialUnits(selectedArena, catalog.equipment, afterLoss, units), "player", resolved.campaign, afterLoss, base, 1, pendingLoss?.rngState ?? save?.rngState ?? 0, selectedArena, resolved.character)) return;
     setTargetId(null);
     const lossLog = pendingLoss?.applies && pendingLoss.lostUnits > 0
       ? ` Потеряно из рюкзака: ${pendingLoss.lostUnits} ед.`
       : "";
     setLog(`${resolved.penalty.xpLost > 0 ? `Повторная попытка: −${resolved.penalty.xpLost} XP за поражение.` : "Повторная попытка без штрафа XP."}${lossLog}`);
  }
  function collectReward() {
     if (rewardClaimInFlight.current || !activeReward || !inventory || !base || !campaignMissions) return;
     rewardClaimInFlight.current = true;
    setRewardClaimLocked(true);
    const result = awardRewardTransition(campaign, inventory, activeReward, campaignMissions, character, catalog?.progression.curve);
    if (!result.alreadyClaimed) {
      const saved = persist(units, "player", result.campaign, result.inventory, base, save?.turn ?? 1, save?.rngState ?? 0, arena, result.character);
      if (!saved) {
        rewardClaimInFlight.current = false;
        setRewardClaimLocked(false);
        return;
      }
    }
    setLog(
      result.alreadyClaimed
        ? "Награда уже получена."
        : `Награда добавлена в stash: ${result.awarded.join(", ")}.${result.levelsGained > 0 ? ` Новый уровень: ${result.character.level}.` : ""}`,
    );
    rewardClaimInFlight.current = false;
    setRewardClaimLocked(false);
   }
  /**
   * W6-05 — moves one stashed ammunition bundle into a weapon's reserve (criterion 1).
   *
   * The transaction that did not exist: ammunition was craftable but usable only mid-mission through a quick
   * slot, so mission-start ammo was whatever survived the last fight and an empty reserve was a soft lock whose
   * only exit was a rewardless retreat.
   *
   * Bundles rather than raw resources on purpose — metal already buys bundles through `recipes.json`, and a
   * second price for the same goods would make the recipes pointless. One bundle per press because the reserve
   * has no cap in the data model, so "fill it up" would silently decide how much ammunition a player should
   * carry.
   */
  function restock(instanceId: string) {
    if (!catalog || !inventory || !base || !hero) return;
    const result = restockAmmo(inventory, instanceId, catalog.itemEffects);
    if (!result.ok)
      return setLog(
        result.reason === "no-bundles"
          ? "В stash нет подходящих боеприпасов: скрафтите связку на верстаке."
          : result.reason === "no-matching-ammo"
            ? "Для этого калибра в каталоге нет связки."
            : result.reason === "not-a-weapon"
              ? "Пополнять боеприпасы можно только для оружия."
              : "Экземпляр экипировки не найден.",
      );
    /* The unit is the authoritative side for anything a live encounter holds, so the hero's reserve moves with
       the instance — otherwise `syncEquipmentInstances` would copy the old value straight back over it. */
    const nextUnits = units.map((unit) =>
      unit.id === hero.id && unit.weaponState?.weaponInstanceId === instanceId
        ? { ...unit, weaponState: { ...unit.weaponState, reserveAmmo: result.value.equipment.reserveAmmo ?? 0 } }
        : unit,
    );
    if (!persist(nextUnits, phase, campaign, result.value.inventory, base)) return;
    setLog(
      `Боеприпасы пополнены: ${itemLabel(result.value.itemId, catalog)} → +${result.value.roundsAdded} в резерв.`,
    );
  }
  function repair(targetId: string) {
    if (!inventory || !base || !hero) return;
    const result = repairGear(inventory, targetId);
    if (!result.ok)
      return setLog(
        result.reason === "not-damaged"
          ? "Выбранная боевая экипировка не повреждена."
          : result.reason === "insufficient-resources"
            ? "Не хватает металла в stash."
            : "Связанная боевая экипировка не найдена.",
      );
    const repairedUnits = units.map((unit) =>
      unit.id !== hero.id
        ? unit
        : result.equipment.instanceId === unit.weaponState?.weaponInstanceId
          ? {
              ...unit,
              weaponState: {
                ...unit.weaponState,
                durability: result.equipment.durability,
                maxDurability: result.equipment.maxDurability,
              },
            }
          : result.equipment.instanceId === unit.armor?.armorInstanceId
            ? {
                ...unit,
                armor: {
                  ...unit.armor,
                  durability: result.equipment.durability,
                  maxDurability: result.equipment.maxDurability,
                },
              }
            : unit,
    );
     if (!persist(repairedUnits, "player", campaign, result.inventory, base)) return;
     setLog(`${result.equipment.itemId}: durability восстановлена.`);
  }
  function medbay() {
    if (!hero || !inventory || !base || !catalog) return;
    /* Heal amount comes from the catalog, so a bought medbay level applies without a code change. */
    const result = treatHero(base, inventory, hero.hp, hero.maxHp, catalog.upgrades);
    if (!result.ok)
      return setLog(
        result.reason === "no-bandage"
          ? "Нужен бинт в stash."
          : "Лечение не требуется.",
      );
     if (!persist(
       units.map((unit) =>
         unit.id === hero.id ? { ...unit, hp: result.health } : unit,
       ),
       "player",
       campaign,
       result.inventory,
       base,
     )) return;
     setLog(`Медотсек восстановил ${result.healed} HP.`);
  }
  function upgrade(id: string) {
    if (!catalog || !inventory || !base) return;
    const result = applyUpgrade(base, inventory, id, catalog.upgrades);
    /* The refusal is read off the same option model the button rendered, so the message names the
       actual blocker (wrong level / maxed node / which resource) instead of listing all three. */
    if (!result.ok) {
      const option = basePanel?.upgrades.find((entry) => entry.id === id);
      return setLog(
        option?.reason ?? "Улучшение сейчас недоступно: проверьте уровень и stash-ресурсы.",
      );
    }
     if (!persist(units, "player", campaign, result.inventory, result.base)) return;
     setLog(`${result.upgrade.name}: готово. ${result.upgrade.description}`);
  }
  function craftRecipe(id: string) {
    if (!catalog || !inventory || !base) return;
    const result = craft(
      base,
      inventory,
      id,
      catalog.recipes,
      (itemId) => catalog.items.find((item) => item.id === itemId)?.weight ?? 1,
    );
    if (!result.ok) {
      const option = basePanel?.recipes.find((entry) => entry.id === id);
      return setLog(option?.reason ?? "Рецепт сейчас недоступен.");
    }
     if (!persist(units, "player", campaign, result.inventory, base)) return;
     setLog(
       `${result.recipe.name}: создано в stash — ${itemLabel(result.recipe.output.itemId, catalog)} ×${result.recipe.output.quantity}.`,
     );
  }
  function moveItem(id: string, from: "stash" | "backpack") {
    if (!inventory || !base) return;
    const result = transferItem(inventory, id, 1, from);
    if (!result.ok)
      return setLog(
        result.reason === "no-capacity"
          ? "Рюкзак переполнен."
          : "Предмет недоступен.",
      );
     if (!persist(units, "player", campaign, result.inventory, base)) return;
     setLog(`${itemLabel(id, catalog!)} перемещён.`);
  }
  function moveResource(
    id: Parameters<typeof transferResource>[1],
    from: "stash" | "backpack",
  ) {
    if (!inventory || !base) return;
    const result = transferResource(inventory, id, 1, from);
    if (!result.ok)
      return setLog(
        result.reason === "no-capacity"
          ? "Рюкзак переполнен."
          : "Ресурс недоступен.",
      );
     if (!persist(units, "player", campaign, result.inventory, base)) return;
     setLog(`${RESOURCE_LABELS[id]} перемещён.`);
  }
  function assignSlot(index: number) {
    if (!inventory || !base || !selectedBackpackItem)
      return setLog("Сначала выберите предмет в рюкзаке.");
    const result = assignQuickSlot(inventory, index, selectedBackpackItem);
    if (!result.ok)
      return setLog("Этот предмет нельзя назначить в quick slot.");
     if (!persist(units, "player", campaign, result.inventory, base)) return;
     setLog(`Quick slot ${index + 1} назначен.`);
  }
  latest.current = {
    move,
    select,
    hover: (x, y) => setHover(x < 0 ? null : { x, y }),
  };
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadArenaManifest(),
      loadMissions(),
      loadRewards(),
      loadBaseUpgrades(),
      loadRecipes(),
      loadItems(),
      loadZones(),
      loadEquipmentCatalog(),
      loadProgression(),
      loadItemEffects(),
      loadReturnTables(),
    ])
      .then(async ([manifest, missions, rewards, upgrades, recipes, items, zones, equipment, progression, itemEffects, returnTables]) => {
const arenas = await loadArenaCatalog(
           manifest,
           new Set(missions.map((mission) => mission.arenaId)),
           equipment,
         );
        /**
         * W5-03/W5-04 — the two new catalogs are cross-checked here, at boot, with the equipment and
         * ammo id sets in hand. That is the only place they can be: an effect naming a calibre no
         * weapon chambers, or a return table that would make a craft → dismantle cycle profitable,
         * is a *cross-file* error invisible to either file's own validator. Failing the boot is the
         * point — a quick slot that costs AP and does nothing, or an exploit that prints resources,
         * would otherwise be discovered by a player rather than by the loader.
         */
        const validatedCampaign = validateCampaignCatalog(
          {
            zones,
            missions,
            rewards,
            items,
            recipes,
            upgrades,
            itemEffects,
            returnTables,
          },
          new Set(arenas.all.map((arena) => arena.id)),
          new Set(items.map((item) => item.id)),
          {
            equipmentIds: new Set([
              ...equipment.weapons.map((entry) => entry.id),
              ...equipment.armor.map((entry) => entry.id),
            ]),
            ammoIds: new Set(equipment.ammo.map((entry) => entry.id)),
            /**
             * W6-01 — objective geometry, checked against the arena it will actually run on.
             *
             * The other half of objective validation lives in `checkMission`, which sees `missions.json`
             * before any arena has been fetched and therefore cannot know the map size. An exit or pickup
             * cell outside its arena is an unwinnable mission that looks perfectly valid in the mission
             * file; failing the boot is the point.
             */
            arenaBounds: new Map(
              arenas.all.map((entry) => [entry.id, { width: entry.width, height: entry.height }]),
            ),
          },
        );
        if (!validatedCampaign.ok) throw validatedCampaign.error;
        const validatedCatalog = validatedCampaign.value;
        const unlockedZones = new Set(validatedCatalog.zones.filter((zone) => zone.unlocked).map((zone) => zone.id));
        const playableMissions = validatedCatalog.missions.filter((mission) => unlockedZones.has(mission.zoneId));
        if (!playableMissions.length) throw new ContentValidationError("shape", [{ path: "missions", message: "должна быть доступная encounter" }]);
        if (cancelled) return;
        const campaignMissions = campaignMissionsOf(playableMissions);
        const catalogOptions = {
          campaignCatalog: campaignCatalogFor({
            catalogId: arenas.catalogId,
            missions: playableMissions,
            rewardIds: validatedCatalog.rewards.map((entry) => entry.id),
            arenaIds: arenas.all.map((entry) => entry.id),
            items,
            equipment,
            progression: progression.curve,
          }),
        };
        saveAdapter.setValidationOptions(catalogOptions);
        const fallback = playableMissions[0];
        /* Checked before `load`, which does not move the payload: the answer must describe storage
           as it was found, not as it will be after the upgrade write below. */
        const upgradeFromLegacyKey = saveAdapter.hasPendingUpgrade();
        const loaded = saveAdapter.load(fallback.arenaId, catalogOptions);
        const appCatalog: Catalog = { missions: playableMissions, rewards: validatedCatalog.rewards, arenas, upgrades, recipes, items, itemEffects, returnTables, equipment, progression };
        if (loaded && !loaded.ok) {
          const backupSucceeded = saveAdapter.backupCorrupt();
          setRecovery({ error: loaded.error, backupSucceeded, content: false });
          setArena(arenas.byId.get(fallback.arenaId) ?? null);
          setCatalog(appCatalog);
          setLog(backupSucceeded ? "Сохранение повреждено; исходный payload скопирован в backup." : "Сохранение повреждено; backup не удалось создать. Сброс заблокирован.");
          return;
        }
        const original = loaded?.value;
        const persistedArena = original && arenas.byId.get(original.arenaId);
        const resumeArena = original?.activeEncounterId ? arenas.byId.get(original.arenaId) : undefined;
        const resumed = original?.phase === "enemy" && resumeArena ? resumePersistedEnemyPhase(saveAdapter, original, resumeArena) : original;
        if (original?.phase === "enemy" && !resumed) {
          setArena(persistedArena ?? arenas.byId.get(fallback.arenaId) ?? null);
          setCatalog(appCatalog);
          setSaveFailure("Не удалось записать результат восстановления enemy-фазы. Повторите сохранение после загрузки.");
          setLog("Восстановление enemy-фазы не было подтверждено записью.");
          return;
        }
         const next = resumed ?? defaultSave(fallback.arenaId, initialUnits(arenas.byId.get(fallback.arenaId)!, equipment), catalogOptions.campaignCatalog, undefined, equipment);
         const selectedArena = arenas.byId.get(next.arenaId) ?? arenas.byId.get(fallback.arenaId)!;
         setArena(selectedArena);
         setCatalog(appCatalog);
         /**
          * A save read from a legacy key was migrated in memory only. Writing it now moves the live
          * copy to the current key at boot, so the very next reload no longer runs the migration —
          * otherwise the old payload would stay authoritative until the player happened to trigger
          * a transition, and an interrupted session would silently re-migrate every time (W4-05).
          */
         const pendingUpgrade = Boolean(original) && upgradeFromLegacyKey;
         const result = original?.phase === "enemy" || (original && !pendingUpgrade)
           ? { ok: true as const, error: undefined }
           : saveAdapter.saveDetailed(next);
        if (!result.ok) {
          const error = new SaveValidationError("shape", [{ path: "$", message: result.error ?? "неизвестная ошибка сохранения" }]);
          setRecovery({ error, backupSucceeded: false, content: false, allowReset: true });
          setSaveFailure(error.message);
          setLog("Начальное сохранение не записано; состояние приложения не запущено. Повторите попытку.");
          return;
        }
        setArena(selectedArena);
        setCatalog(appCatalog);
        setSave(next);
        setUnits(next.units);
        setPhase(next.phase);
        setSaveStatus(
          original?.phase === "enemy"
            ? "Сохранённый ход противника разрешён и записан."
            : pendingUpgrade
              ? "Сохранение обновлено до новой версии схемы и записано."
              : original
                ? "Сохранение загружено."
                : "Сохранено локально.",
        );
        setSaveFailure(null);
        void campaignMissions;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const typedError = error instanceof ContentValidationError || error instanceof SaveValidationError
          ? error
          : new ContentValidationError("parse", [{ path: "$", message: error instanceof Error ? error.message : "неизвестная ошибка загрузки контента." }]);
        const backupSucceeded = saveAdapter.backupCorrupt();
        setRecovery({ error: typedError, backupSucceeded, content: typedError.name === "ContentValidationError" });
        setLog(typedError.message);
      });
    return () => { cancelled = true; if (timer.current) window.clearTimeout(timer.current); };
  }, [saveAdapter]);
  useEffect(() => {
    if (!arena || !host.current || game.current || campaign.screen !== "mission")
      return;
    let cancelled = false;
    void createCombatRuntime({
      host: host.current,
      arena,
      state: sceneState,
      events: {
        onCellClick: (x: number, y: number) => latest.current.move(x, y),
        onUnitClick: (id: string) => latest.current.select(id),
        onCellHover: (x: number, y: number) => latest.current.hover(x, y),
      },
    })
      .then((runtime) => {
        if (cancelled) {
          runtime.destroy();
          return;
        }
        game.current = runtime;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "неизвестная ошибка загрузки боя";
        setSaveFailure(`Боевая сцена не загрузилась: ${message}`);
        setLog("Боевая сцена не загрузилась. Вернитесь на базу и повторите попытку.");
      });
    return () => {
      cancelled = true;
      game.current?.destroy();
      game.current = null;
    };
  }, [arena, campaign.screen]);
  useEffect(() => {
    updateScene();
  }, [sceneState]);
   useEffect(() => {
     const keydown = (event: KeyboardEvent) => {
       const shortcut = resolveCombatShortcut(event, campaign.screen, phase);
       if (!shortcut) return;
       if (shortcut.action === "end-turn") endTurn();
       if (shortcut.action === "overwatch") activateOverwatch();
       if (shortcut.action === "select-body-part") setPart(shortcut.part);
       /* W5-03: Shift+1…4. `preventDefault` because Shift+digit is a browser-level character
          input, and leaving it unhandled would type into whatever has focus. */
       if (shortcut.action === "use-quick-slot") {
         event.preventDefault();
         useSlot(shortcut.index);
       }
     };
     window.addEventListener("keydown", keydown);
     return () => window.removeEventListener("keydown", keydown);
   });
  if (bootView.phase === "recovery" && recovery)
    return (
      <main class="game-shell recovery" aria-labelledby="recovery-title">
        <section class="card">
          <span class="label">{recovery.content ? "CONTENT RECOVERY" : "SAVE RECOVERY"}</span>
          <h1 id="recovery-title">{bootView.heading}</h1>
          <p>
            {recovery.content
              ? "Загрузка остановлена: каталог кампании содержит недопустимые cross-reference. Прогрессия не запускалась."
              : recovery.backupSucceeded
                ? "Исходный payload подтверждённо скопирован в отдельный localStorage backup; активный save не удалён автоматически."
                : "Backup исходного payload создать не удалось. Активный save не будет удалён, чтобы не потерять единственную копию."}
          </p>
          <p class="log">Причина: {recovery.error.message}</p>
           {!recovery.content && (recovery.backupSucceeded || recovery.allowReset) ? (
            <div class="actions">
              <button
                onClick={() => {
                   if (!arena) return;
                   const firstMission = catalog?.missions[0];
                   if (!catalog || !firstMission) return;
                   const next = defaultSave(arena.id, initialUnits(arena, catalog.equipment), saveCatalogFor(catalog), undefined, catalog.equipment);
                   const result = saveAdapter.saveDetailed(next);
                  if (!result.ok) {
                    setSaveFailure(
                      `Новое сохранение не записано: ${result.error ?? "неизвестная ошибка"}. Повторите попытку.`,
                    );
                    return;
                  }
                  setRecovery(null);
                  setSave(next);
                  setUnits(next.units);
                  setPhase("player");
                  setSaveStatus("Создано новое сохранение.");
                }}
              >
                ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО
              </button>
            </div>
          ) : !recovery.content ? (
            <p class="save-status" role="alert">
              Сброс заблокирован до успешного backup. Освободите localStorage
              или экспортируйте данные через DevTools и перезагрузите страницу.
            </p>
          ) : null}
          {saveFailure && (
            <p class="save-status" role="alert">
              {saveFailure}
            </p>
          )}
        </section>
      </main>
    );
  if (bootView.loading || !arena || !catalog || !save || !inventory || !base || !basePanel || !quickSlotBar || !dismantlePanel)
    return (
      <main class="game-shell loading" data-boot-phase={bootView.phase}>
        <h1>{bootView.heading}</h1>
        <p role="status" aria-live={bootView.live}>
          {bootView.message}
        </p>
      </main>
    );
  const home = campaign.screen !== "mission";
  /**
   * W4-02 — the base is only *actionable* on the two base screens.
   *
   * `reward` and `return` reuse this same campaign layout, but both hold an unresolved transition:
   * a reward that has not been claimed, or an XP penalty that is only charged when the player
   * confirms the return. Every base affordance writes a save through `persist`, so leaving them
   * mounted lets a player repair, heal, craft, upgrade or reshuffle the pack *while* that
   * transition is still pending — and, in the mission-select case, attempt to walk away from it.
   * Scoping them to `home`/`mission-select` keeps the terminal screens to their own CTA.
   */
  const baseActionsAvailable = campaign.screen === "home" || campaign.screen === "mission-select";
  const mission = activeMission ?? catalog.missions[0];
  const equipment = inventory.equipment;
  const equipmentView = buildEquipmentState(hero, (itemId) => itemLabel(itemId, catalog));
  const repairTargets = repairTarget(inventory, hero);
  const combatScreen = buildCombatScreen({
    hero,
    units,
    cover: arena.cover.map((entry) => ({ ...entry, kind: entry.type })),
    reachability,
    phase,
    targetable,
    targetId,
    expanded: movesExpanded,
    viewportWidth,
    labelFor: (itemId) => itemLabel(itemId, catalog),
  });
  const moveButtons: MoveOption[] = movesExpanded
    ? [...combatScreen.moves.recommended, ...combatScreen.moves.remaining]
    : combatScreen.moves.recommended;
  const runCombatControl = (id: CombatControlId) =>
    id === "reload" ? reload() : clearJam();
  const noAmmo = Boolean(hero?.weaponState && hero.weaponState.magazine === 0 && hero.weaponState.reserveAmmo === 0);
  const noRangedAttack = noAmmo || !hero?.weaponState || Boolean(hero?.weaponState.malfunctioned && hero.ap < 2);
  const retreatAvailable = canRetreatFromMission(campaign) && !inFlight.current && phase !== "enemy";
  if (home)
    return (
      <main class={`game-shell campaign ${campaign.screen}`}>
        <p class="sr-only" aria-live="polite">
          {log}. {saveStatus}
        </p>
        <header>
          <div>
            <span class="eyebrow">EDEN // M2 VERTICAL SLICE</span>
            <h1>{mission.name}</h1>
          </div>
          <div class="turn">
            <span>КАМПАНИЯ</span>
            <strong>
              {campaign.screen === "home"
                ? "БАЗА"
                : campaign.screen === "reward"
                  ? "НАГРАДА"
                  : campaign.screen === "return"
                    ? "ВОЗВРАТ"
                    : "МИССИЯ"}
            </strong>
          </div>
        </header>
        <p class="save-status" role="status">
          {saveStatus}{" "}
          {saveFailure && <button onClick={retrySave}>ПОВТОРИТЬ</button>}
        </p>
          {/*
            W7-05 — the onboarding hint.

            Advisory, never a gate (criterion 2): `role="status"` rather than `alert`, no focus trap, no disabled
            controls behind it. A tutorial that must be obeyed is worse than none in a genre whose players expect to
            poke at things. Both controls are always present — «ПОНЯТНО» advances, «ОТКЛЮЧИТЬ ПОДСКАЗКИ» stops them
            for good — and each is a real button, so keyboard and screen-reader users reach them like any other.
          */}
          {tutorialView && (
            <section
              class="tutorial"
              role="status"
              data-tutorial-step={tutorialView.step.id}
              data-tutorial-position={tutorialView.position}
              data-tutorial-total={tutorialView.total}
              aria-label={tutorialView.ariaLabel}
            >
              <span class="label">
                ОБУЧЕНИЕ {tutorialView.position}/{tutorialView.total}
              </span>
              <b>{tutorialView.step.title}</b>
              <p>{tutorialView.step.body}</p>
              {tutorialView.step.target && <p class="tutorial-target">Смотрите: {tutorialView.step.target}</p>}
              <div class="actions">
                <button
                  type="button"
                  class="tutorial-advance"
                  onClick={() => persistTutorial(advanceTutorial(tutorial, tutorialView.step.id))}
                >
                  {tutorialView.advanceLabel}
                </button>
                <button
                  type="button"
                  class="tutorial-dismiss"
                  onClick={() => persistTutorial(dismissTutorial(tutorial))}
                >
                  ОТКЛЮЧИТЬ ПОДСКАЗКИ
                </button>
              </div>
            </section>
          )}
        <section class="campaign-grid">
          <div class="card home-panel">
            <span class="label">БАЗА / ДОМАШНИЙ ЭКРАН</span>
            <h2>Бункер у периметра</h2>
            <p class="progression" data-level={character.level}>
              {levelSummary(character, catalog)}
            </p>
            <p>
              Здоровье:{" "}
              <b>
                {hero?.hp ?? 0}/{hero?.maxHp ?? 0}
              </b>
            </p>
            <p>
              Рюкзак:{" "}
              <b>
                {basePanel.capacity.used.toFixed(0)}/{basePanel.capacity.total}
              </b>{" "}
              · stash без лимита
            </p>
            {/* Every resource the catalog can ask for, including the ones at zero: a missing
                resource that is simply absent from the list makes an unaffordable recipe
                unreadable (W5-02 «список отсутствующих ресурсов в UI»). */}
            <p class="stash-overview">
              Stash:{" "}
              {basePanel.stash.map((entry, index) => (
                <span
                  key={entry.id}
                  class={entry.quantity === 0 ? "resource empty" : "resource"}
                  data-resource={entry.id}
                  data-quantity={entry.quantity}
                >
                  {index > 0 ? ", " : ""}
                  {entry.label} {entry.quantity}
                </span>
              ))}
            </p>
            {/* Node ladder: current level, what it does now, and the single next transition. */}
            <ul class="base-nodes">
              {basePanel.nodes.map((node) => (
                <li key={node.node} data-node={node.node} data-level={node.level}>
                  <b>
                    {node.label} {node.levelLabel}
                  </b>{" "}
                  · {node.effectSummary} ·{" "}
                  {node.atMaxLevel
                    ? "максимальный уровень"
                    : `далее L${node.next?.targetLevel}: ${node.next?.effectSummary} за ${node.next?.costLabel}`}
                </li>
              ))}
            </ul>
            {baseActionsAvailable && (
              <>
                {/* `primary-actions` marks the card's own call-to-action group, so the phone
                    stylesheet can promote «ВЫБРАТЬ МИССИЮ» to the same fixed bottom bar the other
                    four screens get. Addressed by class rather than by position: the W5 readouts
                    above it (stash overview, node ladder) already moved this block once. */}
                <div class="actions primary-actions">
                  {repairTargets.map((target) => (
                    <button
                      key={target.instanceId}
                      onClick={() => repair(target.instanceId)}
                      disabled={target.durability >= target.maxDurability}
                    >
                      РЕМОНТ: {itemLabel(target.itemId, catalog)} — {target.durability}/{target.maxDurability},{" "}
                      {repairCostText(target)}
                    </button>
                  ))}
                  <button onClick={medbay}>МЕДОТСЕК — БИНТ ИЗ STASH</button>
                  <button onClick={openMissionSelect}>ВЫБРАТЬ МИССИЮ</button>
                  {/* W7-05 — switching hints off has to be reversible, or the control is a trap rather than a
                      preference. Offered on the base screen only: it is settings-shaped, not a combat action. */}
                  {(tutorial.dismissed || tutorial.completed) && (
                    <button
                      type="button"
                      class="tutorial-resume"
                      onClick={() => persistTutorial(resumeTutorial())}
                    >
                      ВКЛЮЧИТЬ ПОДСКАЗКИ СНОВА
                    </button>
                  )}
                </div>
                <h3>{equipmentView.title}</h3>
                <section class="equipment-state" data-view-id={equipmentView.id}>
                  <p>
                    Оружие: <b>{equipmentView.weapon.name}</b> · боеприпас {equipmentView.weapon.ammoId} · магазин {equipmentView.weapon.magazine}/{equipmentView.weapon.magazineSize} · резерв {equipmentView.weapon.reserveAmmo} · durability {equipmentView.weapon.durability}/{equipmentView.weapon.maxDurability} · {equipmentView.weapon.status}
                  </p>
                  <p>
                    Броня: <b>{equipmentView.armor.name}</b> · durability {equipmentView.armor.durability}/{equipmentView.armor.maxDurability} · защита: {equipmentView.armor.protection}
                  </p>
                </section>

                <h3>Все экземпляры</h3>
                {equipment.map((entry) => (
                  <p key={entry.instanceId}>
                    {itemLabel(entry.itemId, catalog)}: <b>{equipmentDurabilityPercent(entry)}% durability</b>
                    {entry.magazineSize !== undefined && (
                      <>
                        {" · резерв "}
                        <b>{entry.reserveAmmo ?? 0}</b>
                        {" · "}
                        {/*
                          W6-05 — the restock transaction (criterion 1).

                          Ammunition was craftable but usable only mid-mission through a quick slot, so an empty
                          reserve was a soft lock whose only exit was a rewardless retreat. One bundle per press:
                          the reserve has no cap in the data model, and "fill it up" would silently decide how
                          much a player should carry.
                        */}
                        <button
                          type="button"
                          class="restock"
                          data-restock={entry.instanceId}
                          onClick={() => restock(entry.instanceId)}
                        >
                          ПОПОЛНИТЬ БОЕПРИПАСЫ
                        </button>
                      </>
                    )}
                  </p>
                ))}
                {/*
                  Craft and upgrade entries are rendered `aria-disabled`, not `disabled`.

                  A `disabled` button is removed from the tab order and stops reporting anything, so
                  the two questions a full catalog raises — «почему нельзя» and «чего не хватает» —
                  would be answerable only by sighted mouse users reading the label. `aria-disabled`
                  announces unavailability while keeping the control reachable, and the refusal is
                  safe by construction: `craft`/`applyUpgrade` preflight and refuse atomically, and
                  the click logs the same reason the label states (W5-01 §3, W5-02 §1–2).
                */}
                <h3>Крафт</h3>
                <div class="actions craft-actions">
                  {basePanel.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      data-recipe={recipe.id}
                      data-blocked={recipe.blocked ?? ""}
                      aria-disabled={recipe.disabled}
                      aria-label={recipe.ariaLabel}
                      class={recipe.available ? "" : "unavailable"}
                      onClick={() => craftRecipe(recipe.id)}
                    >
                      {recipe.label}
                      <small>
                        {recipe.nodeLabel} L{recipe.nodeLevel} · даёт {recipe.outputLabel} · цена: {recipe.costLabel}
                        {recipe.available ? "" : ` · ${recipe.reason}`}
                      </small>
                    </button>
                  ))}
                </div>
                <h3>Улучшения</h3>
                <div class="actions upgrade-actions">
                  {basePanel.upgrades.map((entry) => (
                    <button
                      key={entry.id}
                      data-upgrade={entry.id}
                      data-blocked={entry.blocked ?? ""}
                      aria-disabled={entry.disabled}
                      aria-label={entry.ariaLabel}
                      class={entry.available ? "" : "unavailable"}
                      onClick={() => upgrade(entry.id)}
                    >
                      {entry.label}
                      <small>
                        {entry.nodeLabel} L{entry.targetLevel} · {entry.effectSummary} · цена: {entry.costLabel}
                        {entry.available ? "" : ` · ${entry.reason}`}
                      </small>
                    </button>
                  ))}
                </div>
                {/*
                  W5-04 — dismantle.

                  Every row states its return *before* anything is destroyed, from the same table the
                  transaction reads, so the preview cannot disagree with the payout. Every destruction
                  takes two presses, because one misclick would otherwise be irreversible (criterion
                  3). Gear the hero is using is listed but permanently unavailable rather than hidden:
                  hiding it would make «почему нельзя разобрать жилет» unanswerable, and allowing it
                  would soft-lock the run. The repair price sits next to the return so the two options
                  are comparable, without this screen recommending one.
                */}
                <h3 id="dismantle-title">Разборка</h3>
                <p class="dismantle-summary">{dismantlePanel.summary}</p>
                <p class="sr-only" aria-live="polite">
                  {dismantlePanel.pendingConfirmation
                    ? dismantlePanel.pendingConfirmation.reason
                    : dismantlePanel.summary}
                </p>
                {dismantlePanel.pendingConfirmation && (
                  <p class="dismantle-confirm" role="alert" data-confirming={dismantlePanel.pendingConfirmation.id}>
                    Подтвердите разборку: {dismantlePanel.pendingConfirmation.label} будет уничтожен
                    безвозвратно. Возврат: {dismantlePanel.pendingConfirmation.returnsLabel}.
                    <button type="button" class="dismantle-cancel" onClick={() => { setConfirmingDismantle(null); setLog("Разборка отменена."); }}>
                      ОТМЕНИТЬ
                    </button>
                  </p>
                )}
                <div class="actions dismantle-actions" role="group" aria-labelledby="dismantle-title">
                  {dismantlePanel.options.map((option) => (
                    <button
                      key={`${option.kind}-${option.id}`}
                      data-dismantle={option.id}
                      data-dismantle-kind={option.kind}
                      data-blocked={option.blocked ?? ""}
                      data-equipped={option.equipped}
                      aria-disabled={option.disabled}
                      aria-label={option.ariaLabel}
                      class={option.confirming ? "confirming" : option.available ? "" : "unavailable"}
                      onClick={() => dismantle(option.id)}
                    >
                      {option.confirming ? "ПОДТВЕРДИТЬ РАЗБОРКУ: " : "РАЗОБРАТЬ: "}
                      {option.label}
                      {option.quantityLabel ? ` ${option.quantityLabel}` : ""}
                      <small>
                        возврат: {option.returnsLabel}
                        {option.conditionLabel ? ` · ${option.conditionLabel}` : ""}
                        {option.repairCostLabel ? ` · ${option.repairCostLabel}` : ""}
                        {option.available ? "" : ` · ${option.reason}`}
                      </small>
                    </button>
                  ))}
                  {dismantlePanel.options.length === 0 && <p>Нет предметов для разборки.</p>}
                </div>
              </>
            )}
          </div>
          {/* Gated with the base actions: every control in this card persists a save, and on the
              reward/return screens that save would still carry the unresolved transition. */}
          {baseActionsAvailable && (
            <div class="card inventory-panel">
              <span class="label">STASH ↔ РЮКЗАК</span>
              <h2>Снаряжение вылазки</h2>
              <p>
                Нажмите строку, чтобы перенести одну единицу. Рюкзак имеет весовой
                лимит; stash — нет.
              </p>
              <p class="capacity-readout">
                Занято <b>{basePanel.capacity.used.toFixed(0)}</b> из{" "}
                <b>{basePanel.capacity.total}</b> · свободно{" "}
                <b>{freeCapacity(inventory).toFixed(0)}</b>
              </p>
              <h3>Stash</h3>
              <ul>
                {inventory.stash.resources.map((entry) => (
                  <li key={`sr-${entry.id}`}>
                    <button onClick={() => moveResource(entry.id, "stash")}>
                      {RESOURCE_LABELS[entry.id]} ×{entry.quantity} → рюкзак
                    </button>
                  </li>
                ))}
                {inventory.stash.items.map((entry) => (
                  <li key={`si-${entry.id}`}>
                    <button onClick={() => moveItem(entry.id, "stash")}>
                      {itemLabel(entry.id, catalog)} ×{entry.quantity} → рюкзак
                    </button>
                  </li>
                ))}
                {/* An empty stash must say so rather than rendering an empty list, otherwise
                    "нет ресурсов" is indistinguishable from "панель не отрисовалась". */}
                {!inventory.stash.resources.length && !inventory.stash.items.length && (
                  <li class="empty-pool">Stash пуст.</li>
                )}
              </ul>
              <h3>Рюкзак</h3>
              <ul>
                {inventory.backpack.resources.map((entry) => (
                  <li key={`br-${entry.id}`}>
                    <button onClick={() => moveResource(entry.id, "backpack")}>
                      {RESOURCE_LABELS[entry.id]} ×{entry.quantity} → stash
                    </button>
                  </li>
                ))}
                {inventory.backpack.items.map((entry) => (
                  <li key={`bi-${entry.id}`}>
                    <button
                      class={selectedBackpackItem === entry.id ? "active" : ""}
                      onClick={() => {
                        setSelectedBackpackItem(entry.id);
                        moveItem(entry.id, "backpack");
                      }}
                    >
                      {itemLabel(entry.id, catalog)} ×{entry.quantity} → stash
                    </button>
                    <button onClick={() => setSelectedBackpackItem(entry.id)}>
                      выбрать для quick slot
                    </button>
                  </li>
                ))}
                {!inventory.backpack.resources.length && !inventory.backpack.items.length && (
                  <li class="empty-pool">Рюкзак пуст.</li>
                )}
              </ul>
              <h3>Quick slots</h3>
              <div class="quick-slots">
                {inventory.quickSlots.map((slot, index) => (
                  <button key={index} onClick={() => assignSlot(index)}>
                    {index + 1}: {slot ? itemLabel(slot, catalog) : "пусто"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div class="card">
            <span class="label">MISSION SELECT</span>
            {/*
              W6-05 — the pre-mission gear check (criteria 2 and 5).

              Before this a player could start an encounter with an empty magazine and empty reserve with no
              warning at all, and the only escape was a rewardless retreat. Durability was shown as a percentage
              but nothing marked the 30% line where `malfunctionEligible` starts jamming — and the shipped starter
              weapon is `makeshift`, so it jams at 15% per shot even at full durability.

              It reports and does not block: leaving with worn gear is a legitimate choice, leaving without knowing
              was the defect. `role="status"` rather than an alert — it is a standing readout, not an interruption.
            */}
            <div
              class="readiness"
              data-readiness={readiness.level}
              data-readiness-issues={readiness.issues.length}
              role="status"
            >
              <b>{readiness.summary}</b>
              {readiness.issues.length > 0 && (
                <ul>
                  {readiness.issues.map((issue) => (
                    <li key={issue.id} data-issue={issue.id} data-issue-level={issue.level}>
                      <b>{issue.text}</b> <span>{issue.advice}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <h2>Ближняя окраина</h2>
            <p>Все encounter этой зоны и их текущая доступность сохраняются локально.</p>
            <div class="mission-list">
              {catalog.missions.map((entry) => {
                const progress = campaign.encounters.find((candidate) => candidate.id === entry.id) ?? campaign.mission;
                const map = catalog.arenas.byId.get(entry.arenaId);
                const reward = catalog.rewards.find((candidate) => candidate.id === entry.rewardId);
                const canStart = progress.status === "available" || progress.status === "failed";
                return <article class="mission-card" key={entry.id}>
                  <h3>{entry.name}</h3>
                  <p>{entry.description}</p>
                  <p>Карта: {map?.name ?? entry.arenaId} · Сложность: {entry.difficulty} · Статус: <b>{progress.status}</b></p>
                  <p>Награда: {reward?.name ?? entry.rewardId} · побед: {progress.victories} · {progress.firstRewardClaimed ? "получена" : "не получена"}</p>
                  {campaign.screen === "mission-select" && <button disabled={!canStart} onClick={() => beginMission(entry.id)}>{progress.status === "failed" ? "ПОВТОРИТЬ" : progress.status === "available" ? "НАЧАТЬ" : progress.status === "completed" ? "ЗАВЕРШЕНО" : "ЗАБЛОКИРОВАНО"}</button>}
                </article>;
              })}
            </div>
            <p class="log">{log}</p>
             {campaign.screen === "mission-select" && <div class="actions"><button onClick={() => { if (!persist(units, "player", { ...campaign, screen: "home", activeMissionId: null }, inventory, base)) return; setLog("Возврат на базу."); }}>НАЗАД НА БАЗУ</button></div>}
            {campaign.screen === "reward" && (
              <>
                <p class="progression" data-level={character.level}>
                  {levelSummary(character, catalog)}
                  {activeReward ? ` · награда: +${activeReward.xp} XP` : ""}
                </p>
                <div class="actions"><button disabled={rewardClaimLocked} onClick={collectReward}>ЗАБРАТЬ НАГРАДУ</button></div>
              </>
            )}
            {campaign.screen === "return" && pendingPenalty && (
              <>
                {/* W4-02: the cost is stated before the player confirms, and retreat is visibly
                    different from a defeat rather than sharing one generic message. */}
                <p class="death-penalty" role="status" data-penalty={pendingPenalty.xpLost} data-reason={pendingPenalty.reason}>
                  {pendingPenalty.reason === "retreat"
                    ? `Отступление: награда не получена, XP не теряется. ${levelSummary(character, catalog)}.`
                    : pendingPenalty.firstDeathFree
                      ? `Первое поражение: штрафа XP нет. Следующее поражение будет стоить XP. ${levelSummary(character, catalog)}.`
                      : `Поражение: штраф −${pendingPenalty.xpLost} XP (${Math.round(pendingPenalty.xpLossRate * 100)}% от XP до следующего уровня). Уровень ${pendingPenalty.level} не понизится, XP не станет отрицательным. Stash и экипировка не затронуты.`}
                </p>
                {/*
                  W5-05 — the loot half of the penalty, listed item by item *before* the player
                  confirms. This is a preview only in the UI sense: `pendingLoss.inventory` is the
                  exact object `returnHome` commits, so the list and the outcome are one computation.

                  The rule is marked as a proposal in the DOM (`data-proposed`) and in the visible
                  text, because decision D-01 is open. What is *not* taken is stated as well: a
                  penalty screen that only names losses invites the assumption that the base was
                  raided too.
                */}
                {pendingLoss && (
                  <p
                    class="backpack-loss"
                    role="status"
                    data-loss-applies={pendingLoss.applies}
                    data-loss-units={pendingLoss.lostUnits}
                    data-carried-units={pendingLoss.carriedUnits}
                    data-loss-rate={pendingLoss.ratePercent}
                    data-proposed={pendingLoss.proposed}
                  >
                    {pendingLoss.applies ? (
                      <>
                        <b>{pendingLoss.summary}</b>{" "}
                        {pendingLoss.lines.length > 0 && (
                          <span class="loss-lines">
                            Будет потеряно:{" "}
                            {pendingLoss.lines.map((line, index) => (
                              <span key={`${line.kind}-${line.id}`} class="loss-line" data-loss-id={line.id} data-loss-lost={line.lost}>
                                {index > 0 ? ", " : ""}
                                {line.text}
                              </span>
                            ))}
                            .{" "}
                          </span>
                        )}
                        {pendingLoss.policyLabel} {pendingLoss.safetyNote}
                      </>
                    ) : (
                      <>
                        {pendingLoss.skippedReason} {pendingLoss.safetyNote}
                      </>
                    )}
                  </p>
                )}
                <div class="actions"><button onClick={returnHome}>ВЕРНУТЬСЯ НА БАЗУ</button><button onClick={retryMission}>ПОВТОРИТЬ МИССИЮ</button></div>
              </>
            )}
            {campaign.screen === "home" && <p>XP: {campaign.xp} · зона: {campaign.zone.status}</p>}
          </div>
        </section>
      </main>
    );
  /* region: combat-dom — asserted by ui-duplication.test.ts */
  return (
    <main class="game-shell combat">
      <p class="sr-only" aria-live="polite">
        {log}. {saveStatus}
      </p>
      <header>
        <div>
          <span class="eyebrow">EDEN // COMBAT</span>
          <h1>{mission.name}</h1>
        </div>
        <div class="turn">
          <span>ФАЗА / ХОД {save.turn}</span>
          <strong>
            {phase === "player"
              ? "ВАШ ХОД"
              : phase === "enemy"
                ? "ПРОТИВНИК"
                : phase === "victory"
                  ? "ПОБЕДА"
                  : "ПОРАЖЕНИЕ"}
          </strong>
        </div>
      </header>
      <p class="save-status" role="status">
        {saveStatus}{" "}
        {saveFailure && <button onClick={retrySave}>ПОВТОРИТЬ</button>}
      </p>
        {/*
          W7-05 — the onboarding hint.

          Advisory, never a gate (criterion 2): `role="status"` rather than `alert`, no focus trap, no disabled
          controls behind it. A tutorial that must be obeyed is worse than none in a genre whose players expect to
          poke at things. Both controls are always present — «ПОНЯТНО» advances, «ОТКЛЮЧИТЬ ПОДСКАЗКИ» stops them
          for good — and each is a real button, so keyboard and screen-reader users reach them like any other.
        */}
        {tutorialView && (
          <section
            class="tutorial"
            role="status"
            data-tutorial-step={tutorialView.step.id}
            data-tutorial-position={tutorialView.position}
            data-tutorial-total={tutorialView.total}
            aria-label={tutorialView.ariaLabel}
          >
            <span class="label">
              ОБУЧЕНИЕ {tutorialView.position}/{tutorialView.total}
            </span>
            <b>{tutorialView.step.title}</b>
            <p>{tutorialView.step.body}</p>
            {tutorialView.step.target && <p class="tutorial-target">Смотрите: {tutorialView.step.target}</p>}
            <div class="actions">
              <button
                type="button"
                class="tutorial-advance"
                onClick={() => persistTutorial(advanceTutorial(tutorial, tutorialView.step.id))}
              >
                {tutorialView.advanceLabel}
              </button>
              <button
                type="button"
                class="tutorial-dismiss"
                onClick={() => persistTutorial(dismissTutorial(tutorial))}
              >
                ОТКЛЮЧИТЬ ПОДСКАЗКИ
              </button>
            </div>
          </section>
        )}
      <section class="battlefield">
        <div
          class="canvas-wrap"
          ref={host}
          aria-label="Тактическая карта. Нажмите доступную клетку для перемещения."
        />
        <section
          class="tactical-command-panel"
          aria-labelledby="tactical-controls-title"
        >
          <h2 id="tactical-controls-title">Тактическое управление</h2>
          <p>
            Дублирует карту для клавиатуры и касания. Все подписи видны без
            наведения курсора.
          </p>
          {/*
            W6-01 — the objective, every turn (criterion 2).

            First in the panel because it is the answer to "what am I doing here", and a mission whose
            goal is not "kill everything" is unplayable without it. The numbers come from
            `objectiveProgress`, which reads the same state `evaluateObjective` reads, so the readout
            cannot disagree with what actually ends the mission. `role="status"` rather than an alert:
            it updates every turn and should not interrupt.
          */}
          {objectiveView && (
            <section
              class="objective-panel"
              data-objective={objectiveView.kind}
              data-objective-done={objectiveView.done}
              data-objective-total={objectiveView.total}
              aria-labelledby="objective-title"
            >
              <h3 id="objective-title">Цель</h3>
              <p class="objective-label" role="status">
                <b>{objectiveView.label}</b>
                {objectiveView.detail ? ` · ${objectiveView.detail}` : ""}
                {objectiveView.turnsLeft === null
                  ? ""
                  : ` · ходов осталось: ${objectiveView.turnsLeft}`}
              </p>
              <progress
                class="objective-progress"
                max={objectiveView.total}
                value={objectiveView.done}
                aria-label={`Прогресс цели: ${objectiveView.done} из ${objectiveView.total}`}
              />
              {/* Only rendered for `retrieve`, and only as an explicit action: the objective item is not
                  inventory, so picking it up implicitly would be an invisible state change on a cell the
                  player may have merely walked across. */}
              {objectiveView.kind === "retrieve" && (
                <button
                  type="button"
                  class="objective-take"
                  data-objective-take="true"
                  aria-disabled={!canTakeObjective}
                  onClick={takeObjective}
                >
                  ЗАБРАТЬ ГРУЗ
                  <small>
                    {objectiveState.carrying
                      ? "груз уже забран"
                      : canTakeObjective
                        ? "вы стоите на клетке груза"
                        : "подойдите к клетке груза"}
                  </small>
                </button>
              )}
            </section>
          )}
          <h3 id="tactical-targets-title">Видимые цели</h3>
          <div class="tactical-options" role="group" aria-labelledby="tactical-targets-title">
            {combatScreen.targets.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={option.disabled}
                aria-pressed={option.selected}
                aria-label={option.ariaLabel}
                class={option.selected ? "active" : ""}
                onClick={() => select(option.id)}
              >
                <b>{option.label}</b>
                <span>{option.description}</span>
              </button>
            ))}
            {combatScreen.targets.length === 0 && <p>Живых противников нет.</p>}
          </div>
          <h3 id="tactical-moves-title">Перемещение</h3>
          <p class="tactical-summary">{combatScreen.moves.summary}</p>
          <p class="sr-only" aria-live="polite">
            {combatScreen.moves.liveMessage}
          </p>
          <div
            class="tactical-options"
            id="tactical-moves-list"
            role="group"
            aria-labelledby="tactical-moves-title"
          >
            {moveButtons.map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={option.disabled}
                aria-label={option.ariaLabel}
                class={option.recommended ? "recommended" : ""}
                onClick={() => move(option.x, option.y)}
              >
                <b>{option.label}</b>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
          {combatScreen.moves.hasMore && (
            <button
               ref={disclosureRef}
               class="disclosure"
               disabled={phase !== "player"}
              type="button"
              aria-expanded={movesExpanded}
              aria-controls="tactical-moves-list"
              onClick={() => setMovesExpanded(!movesExpanded)}
            >
              {movesExpanded
                ? combatScreen.moves.collapseLabel
                : combatScreen.moves.expandLabel}
            </button>
          )}
          <p class="tactical-help">{combatScreen.shortcutsHint}</p>
          {/*
            W5-03 — the quick-slot bar.

            All four slots render, including empty ones: the bar doubles as the readout of what the
            operative is carrying, and a list that shrank as items ran out would make "nothing left"
            indistinguishable from "did not render".

            Unavailable slots are `aria-disabled`, not `disabled`, so a keyboard or screen-reader
            user can still reach the control and hear *why* it cannot be used mid-turn — the one
            thing they need. Safe by construction: `useQuickSlot` re-checks `quickSlotBlocker` and
            consumes nothing on refusal. Each button is also a touch target at the 44px floor via
            `.tactical-options button`.
          */}
          <h3 id="tactical-quick-slots-title">Быстрые слоты</h3>
          <p class="tactical-summary">{quickSlotBar.summary}</p>
          <p class="sr-only" aria-live="polite">
            {quickSlotBar.liveMessage}
          </p>
          <div
            class="tactical-options quick-slot-bar"
            role="group"
            aria-labelledby="tactical-quick-slots-title"
          >
            {quickSlotBar.options.map((option) => (
              <button
                key={option.index}
                type="button"
                data-quick-slot={option.slotNumber}
                data-blocked={option.blocked ?? ""}
                aria-disabled={option.disabled}
                aria-label={option.ariaLabel}
                class={option.available ? "" : "unavailable"}
                onClick={() => useSlot(option.index)}
              >
                <b>
                  {option.slotNumber}. {option.label}
                  {option.itemId ? ` ×${option.quantity}` : ""}
                </b>
                <span>
                  {option.itemId
                    ? `${option.effectSummary} · ${option.apCost} ОЧ · ${quickSlotShortcutLabel(option.index)}`
                    : "назначьте расходник на базе"}
                  {option.available ? "" : ` · ${option.reason}`}
                </span>
              </button>
            ))}
          </div>
          <p class="tactical-help">{quickSlotBar.shortcutsHint}</p>
          <h3 id="equipment-state-title">{combatScreen.equipment.title}</h3>
          <section
            class="equipment-state"
            data-view-id={combatScreen.equipment.id}
            aria-labelledby="equipment-state-title"
          >
            <p>
              Оружие: <b>{combatScreen.equipment.weapon.name}</b> · боеприпас{" "}
              {combatScreen.equipment.weapon.ammoId} · магазин{" "}
              {combatScreen.equipment.weapon.magazine}/
              {combatScreen.equipment.weapon.magazineSize} · резерв{" "}
              {combatScreen.equipment.weapon.reserveAmmo} · durability{" "}
              {combatScreen.equipment.weapon.durability}/
              {combatScreen.equipment.weapon.maxDurability} ·{" "}
              {combatScreen.equipment.weapon.status}
            </p>
            <p>
              Броня: <b>{combatScreen.equipment.armor.name}</b> · durability{" "}
              {combatScreen.equipment.armor.durability}/
              {combatScreen.equipment.armor.maxDurability} · защита:{" "}
              {combatScreen.equipment.armor.protection}
            </p>
          </section>
          {combatScreen.controlGroups.map((group) => (
            <div
              key={group.id}
              class="tactical-options"
              data-control-group={group.id}
              role="group"
              aria-label={group.title}
            >
              {group.controls.map((control) => (
                <button
                  key={control.id}
                  type="button"
                  data-control={control.id}
                  disabled={control.disabled}
                  aria-label={control.ariaLabel}
                  onClick={() => runCombatControl(control.id)}
                >
                  {control.label}
                </button>
              ))}
            </div>
          ))}
        </section>
        <aside class="hud">
          <div class="card">
            <span class="label">ОПЕРАТИВНИК</span>
            <h2>{hero?.name ?? "Загрузка"}</h2>
            {/* Equipment state lives only in the tactical panel's equipment-state section. */}
            <div class="hp">
              <i
                style={{ width: `${hero ? (hero.hp / hero.maxHp) * 100 : 0}%` }}
              />
            </div>
            <b>
              {hero?.hp ?? 0}/{hero?.maxHp ?? 0} HP
            </b>
            <div class="ap">
              {Array.from({ length: AP_PER_TURN }, (_, index) => (
                <i class={index < (hero?.ap ?? 0) ? "active" : ""} />
              ))}
            </div>
            <small>{hero?.ap ?? 0}/10 ОЧ</small>
            {/*
              W6-03 — posture with its price stated before the press (criterion 4).

              `aria-disabled` rather than `disabled` so a keyboard or screen-reader user can still reach the
              control and hear *why* it is unavailable — which matters most for standing→prone, a permanent
              rule rather than a temporary AP shortage. The two refusals were previously one sentence.
            */}
            <div class="actions postures" role="group" aria-label="Поза">
              {postures.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-posture={option.id}
                  data-posture-cost={option.cost ?? ""}
                  aria-disabled={!option.available}
                  aria-pressed={option.current}
                  aria-label={option.ariaLabel}
                  class={option.current ? "active" : option.available ? "" : "unavailable"}
                  onClick={() => changePosture(option.id)}
                >
                  {option.label}
                  <small>
                    {option.summary}
                    {option.available || option.current ? "" : ` · ${option.reason}`}
                  </small>
                </button>
              ))}
            </div>
            {/*
              W6-03 — active statuses with their remaining duration (criterion 3).

              `statusLabels` in `combat.ts` existed and was called from nowhere, and it discarded the turn
              counter anyway. Until now the only status display was raw English keys on the canvas at 9px.
            */}
            <div class="statuses" data-status-count={heroStatuses.length}>
              <span class="label">СТАТУСЫ</span>
              {heroStatuses.length === 0 ? (
                <p class="status-empty">Активных статусов нет.</p>
              ) : (
                <ul>
                  {heroStatuses.map((status) => (
                    <li key={status.id} data-status={status.id} data-status-turns={status.turnsLeft}>
                      <b>{status.label}</b>
                      <span>
                        {status.effect} · осталось ходов: {status.turnsLeft}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {/* Target selection lives only in the tactical panel's «Видимые цели» group. */}
          <div class="card action-tray">
            <span class="label">ДЕЙСТВИЯ / КЛАВИАТУРА</span>
            <p>{target ? `Цель: ${target.name}` : "Выберите видимого врага"}</p>
            <div class="actions">
               {(Object.keys(ATTACKS) as BodyPart[]).map((id, index) => (
                 <button
                   key={id}
                   class={part === id ? "active" : ""}
                  onClick={() => setPart(id)}
                >
                  {index + 1}. {ATTACKS[id].label}
                  <em>{ATTACKS[id].apCost} ОЧ</em>
                </button>
              ))}
            </div>
            {/*
              W6-03 — the full breakdown (criteria 1, 2 and 5).

              Every one of the eight addends is listed with a label and a sign, including the zeroes: "cover
              contributes nothing here" is information, and hiding zero rows would change the list's shape
              between shots so a player could never learn what the terms are. Rendered as a table rather than
              a tooltip because doc 14 requires the information without hover.

              The total shown is the *model's* `final`, never the sum of the rows. When the 5..95 clamp is
              active the two genuinely differ, and the clamp note says so — otherwise the arithmetic would
              read as a bug in the game rather than as a floor.
            */}
            {breakdownView && (
              <div class="breakdown" data-hit-final={breakdownView.final} data-hit-raw={breakdownView.rawTotal}>
                <strong>ШАНС ПОПАДАНИЯ {breakdownView.final}%</strong>
                <table class="breakdown-terms">
                  <caption class="sr-only">Слагаемые шанса попадания</caption>
                  <tbody>
                    {breakdownView.rows.map((row) => (
                      <tr key={row.id} data-term={row.id}>
                        <th scope="row">{row.label}</th>
                        <td data-term-value={row.value}>{row.display}</td>
                      </tr>
                    ))}
                    <tr class="breakdown-total">
                      <th scope="row">Итог</th>
                      <td>{breakdownView.final}%</td>
                    </tr>
                  </tbody>
                </table>
                {breakdownView.clamp && (
                  <p class="breakdown-clamp" data-clamp={breakdownView.clamp}>
                    {breakdownView.clamp === "min"
                      ? `Сумма ${breakdownView.rawTotal} ниже минимума: шанс не опускается ниже 5%.`
                      : `Сумма ${breakdownView.rawTotal} выше максимума: шанс не превышает 95%.`}
                  </p>
                )}
                {critView && (
                  <>
                    <strong class="crit-chance" data-crit-final={critView.final}>
                      ШАНС КРИТА {critView.final}%
                    </strong>
                    <table class="breakdown-terms crit-terms">
                      <caption class="sr-only">Слагаемые шанса критического попадания</caption>
                      <tbody>
                        {critView.rows.map((row) => (
                          <tr key={row.id} data-crit-term={row.id}>
                            <th scope="row">{row.label}</th>
                            <td data-term-value={row.value}>{row.display}</td>
                          </tr>
                        ))}
                        <tr class="breakdown-total">
                          <th scope="row">Итог</th>
                          <td>{critView.final}%</td>
                        </tr>
                      </tbody>
                    </table>
                    <small class="crit-effect">
                      Крит: урон ×{critView.multiplier} · {breakdownView.effect}
                    </small>
                  </>
                )}
                <small>
                  {breakdownView.partLabel}: урон {breakdownView.damage} · {breakdownView.apCost} ОЧ
                </small>
              </div>
            )}
             <button
               class="fire"
               disabled={!target || phase !== "player" || noRangedAttack}
               onClick={attack}
             >
               ОГОНЬ
             </button>
             {noRangedAttack && (
               <p class="combat-warning" role="status">
                 {noAmmo
                   ? "Боеприпасы закончились: дальняя атака и перезарядка недоступны. Отступите, чтобы выйти без награды."
                   : "Оружие недоступно: очистка осечки требует 2 ОЧ. Отступите, чтобы выйти без награды."}
               </p>
             )}
             <button
               class="retreat"
               disabled={!retreatAvailable}
               onClick={retreat}
             >
               ОТСТУПИТЬ БЕЗ НАГРАДЫ
             </button>
             <button
              class="overwatch"
              data-overwatch-active={overwatchView.active}
              data-overwatch-reserved={overwatchView.reservedAp}
              data-overwatch-modifier={overwatchView.hitModifier}
              data-overwatch-total-ap={overwatchView.totalAp}
              data-blocked={overwatchView.blocked ?? ""}
              /* `aria-disabled`, not `disabled`: the control stays reachable so the reason is announced. It was
                 previously gated on `phase` alone, so at 5 AP it looked available and refused on click. */
              aria-disabled={!overwatchView.available}
              aria-label={overwatchView.ariaLabel}
              onClick={activateOverwatch}
            >
              {overwatchView.active ? "OVERWATCH АКТИВЕН" : "OVERWATCH (O)"}
              <small>
                {overwatchView.summary}
                {overwatchView.available || overwatchView.active ? "" : ` · ${overwatchView.reason}`}
              </small>
            </button>
            <button
              class="end"
              disabled={phase !== "player"}
              onClick={() => endTurn()}
            >
              ЗАКОНЧИТЬ ХОД (E)
            </button>
          </div>
          <div class="card log">
            <span class="label">ЖУРНАЛ</span>
            <p>{log}</p>
            {(phase === "victory" || phase === "defeat") && (
              <button
                class="end"
                onClick={phase === "victory" ? collectReward : returnHome}
              >
                ПРОДОЛЖИТЬ В КАМПАНИИ
              </button>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
  /* endregion: combat-dom */
}
