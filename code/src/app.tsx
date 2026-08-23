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
  type RecipeDefinition,
} from "./game/base";
import {
  firstDeathReturn,
  canRetreatFromMission,
  missionVictory,
  retreatFromMission,
  returnFromMission,
  retryMission as retryCampaignMission,
  startMission,
  type CampaignState,
} from "./game/campaign";
import {
  loadBaseUpgrades,
  loadItems,
  loadMissions,
  loadRecipes,
  loadRewards,
  loadZones,
  type ItemDefinition,
  type MissionDefinition,
  type RewardDefinition,
  validateCampaignCatalog,
} from "./game/campaign-content";
import { awardRewardTransition } from "./game/rewards";
import {
  assignQuickSlot,
  depositBackpack,
  equipmentDurabilityPercent,
  resourceQuantity,
  totalWeight,
  transferItem,
  transferResource,
} from "./game/inventory";
import {
  createLocalStorageAdapter,
  defaultSave,
  type SaveData,
  type BattlePhase,
  SaveValidationError,
} from "./game/save";
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
  getAttack,
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
  type EquipmentCatalog,
} from "./game/equipment-content";
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
  upgrades: Awaited<ReturnType<typeof loadBaseUpgrades>>;
  items: ItemDefinition[];
  equipment: EquipmentCatalog;
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
  xp: 0,
  claimedRewards: [],
};

const saveCatalogFor = (catalog: Catalog) =>
  campaignCatalogFor({
    catalogId: catalog.arenas.catalogId,
    missions: catalog.missions,
    rewardIds: catalog.rewards.map((reward) => reward.id),
    arenaIds: catalog.arenas.all.map((arena) => arena.id),
    items: catalog.items,
    equipment: catalog.equipment,
  });
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
  const [movesExpanded, setMovesExpanded] = useState(false);
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
  const campaignMissions = catalog ? campaignMissionsOf(catalog.missions) : undefined;
  const inventory = save?.inventory;
  const base = save?.base;
  const hero = units.find((unit) => unit.id === "hero");
  const activeMission = catalog ? catalog.missions.find((entry) => entry.id === (campaign.activeMissionId ?? campaign.mission.id)) ?? catalog.missions[0] : null;
  const activeReward = catalog && activeMission ? catalog.rewards.find((entry) => entry.id === activeMission.rewardId) ?? null : null;
  const persist = (
    nextUnits: Unit[],
    nextPhase: Phase = phase,
    nextCampaign = campaign,
    nextInventory = inventory,
    nextBase: BaseState | undefined = base,
    nextTurn = save?.turn ?? 1,
    nextRngState = save?.rngState ?? 0,
    nextArena: ArenaConfig | null = arena,
  ) => {
     if (!nextArena || !nextInventory || !nextBase || !save) return;
     const persistedInventory = syncEquipmentInstances(nextInventory, nextUnits);
     const next: SaveData = {

      schemaVersion: 4,
      arenaId: nextArena.id,
      activeEncounterId: nextCampaign.activeMissionId,
      units: nextUnits,
      phase: nextPhase as BattlePhase,
      campaign: nextCampaign,
       inventory: persistedInventory,
      base: nextBase,
      turn: nextTurn,
      rngState: nextRngState,
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
     const saved = persist(next);
     if (!saved) return;
      setTargetId(null);
      setHover(null);
      /* Collapse the full cell list after a move so the panel stays compact. */
      setMovesExpanded(false);
      requestAnimationFrame(() => disclosureRef.current?.focus());
      setLog(`Перемещение: −${cost} ОЧ.`);

  }
  function changePosture(next: Posture) {
    if (!hero || phase !== "player") return;
    const cost = postureChangeCost(hero.posture, next);
    if (cost === null || hero.ap < cost)
      return setLog("Смена позы сейчас недоступна.");
     if (!persist(
       units.map((unit) =>
         unit.id === hero.id
           ? { ...unit, posture: next, ap: unit.ap - cost }
           : unit,
       ),
     )) return;
     setLog(`Поза: ${POSTURES[next].label}.`);
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
    if (
      next
        .filter((unit) => unit.team === "enemy")
        .every((unit) => !isAlive(unit))
    ) {
      const nextCampaign = missionVictory(campaign, catalog!.missions);
       if (!persist(
         next,
         "victory",
         nextCampaign,
         actionInventory,
         base,
         save.turn,
         rngState,
       )) return;
       setTargetId(null);
      setLog("Победа. Награда готова на базе.");
    } else {
       if (!persist(
         next,
         "player",
         campaign,
         actionInventory,
         base,
         save.turn,
         rngState,
       )) return;
       setLog(
        action.malfunctioned
          ? "Осечка: ОЧ, патрон и durability израсходованы; очистите оружие за 2 ОЧ."
          : action.resolution?.hit
            ? `Попадание: ${action.resolution.damage} урона.`
            : "Промах.",
      );
    }
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
     const resolved = resolveEnemyPhase(snapshot, arena);
     if (!persist(
       resolved.units,
       resolved.phase,
       resolved.campaign,
       resolved.inventory,
       resolved.base,
       resolved.turn,
       resolved.rngState,
     )) return;
     inFlight.current = false;
     timer.current = null;
     setLog(
      resolved.phase === "defeat"
        ? "Оперативник выведен из строя. Возврат на базу."
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
                overwatch: { reservedAp: Math.max(0, unit.ap - 2) },
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
   function activateOverwatch() {
     if (!hero || campaign.screen !== "mission" || hero.ap < 6 || phase !== "player")
       return setLog("Для Overwatch нужны 2 ОЧ и 4 ОЧ в резерве.");
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
  function returnHome() {
    if (!inventory || !base) return;
    const nextCampaign =
      campaign.screen === "return"
        ? firstDeathReturn(campaign)
        : returnFromMission(campaign);
     if (!persist(units, "player", nextCampaign, depositBackpack(inventory), base)) return;
     setLog("Возврат на базу завершён. Рюкзак разгружен в stash.");
  }
  function retryMission() {
    if (!catalog || !inventory || !base) return;
    const selected = catalog.missions.find((entry) => entry.id === campaign.mission.id);
    const selectedArena = selected && catalog.arenas.byId.get(selected.arenaId);
    if (!selected || !selectedArena) return;
    const nextCampaign = retryCampaignMission(campaign, catalog.missions);
     if (!persist(initialUnits(selectedArena, catalog.equipment, inventory, units), "player", nextCampaign, inventory, base, 1, save?.rngState ?? 0, selectedArena)) return;
     setTargetId(null);
  }
  function collectReward() {
     if (rewardClaimInFlight.current || !activeReward || !inventory || !base || !campaignMissions) return;
     rewardClaimInFlight.current = true;
    setRewardClaimLocked(true);
    const result = awardRewardTransition(campaign, inventory, activeReward, campaignMissions);
    if (!result.alreadyClaimed) {
      const saved = persist(units, "player", result.campaign, result.inventory, base);
      if (!saved) {
        rewardClaimInFlight.current = false;
        setRewardClaimLocked(false);
        return;
      }
    }
    setLog(result.alreadyClaimed ? "Награда уже получена." : `Награда добавлена в stash: ${result.awarded.join(", ")}.`);
    rewardClaimInFlight.current = false;
    setRewardClaimLocked(false);
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
    if (!hero || !inventory || !base) return;
    const result = treatHero(base, inventory, hero.hp, hero.maxHp);
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
    if (!result.ok)
      return setLog(
        "Улучшение сейчас недоступно: проверьте уровень и stash-ресурсы.",
      );
     if (!persist(units, "player", campaign, result.inventory, result.base)) return;
     setLog(`${result.upgrade.name}: готово.`);
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
    if (!result.ok)
      return setLog(
        result.reason === "insufficient-resources"
          ? "Недостаточно ресурсов в stash."
          : "Рецепт сейчас недоступен.",
      );
     if (!persist(units, "player", campaign, result.inventory, base)) return;
     setLog(`${result.recipe.name}: создано в stash.`);
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
     setLog(`${id} перемещён.`);
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
    ])
      .then(async ([manifest, missions, rewards, upgrades, recipes, items, zones, equipment]) => {
const arenas = await loadArenaCatalog(
           manifest,
           new Set(missions.map((mission) => mission.arenaId)),
           equipment,
         );
        const validatedCampaign = validateCampaignCatalog(
          {
            zones,
            missions,
            rewards,
            items,
            recipes,
          },
          new Set(arenas.all.map((arena) => arena.id)),
          new Set(items.map((item) => item.id)),
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
          }),
        };
        saveAdapter.setValidationOptions(catalogOptions);
        const fallback = playableMissions[0];
        const loaded = saveAdapter.load(fallback.arenaId, catalogOptions);
        const appCatalog: Catalog = { missions: playableMissions, rewards: validatedCatalog.rewards, arenas, upgrades, recipes, items, equipment };
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
         const result = original?.phase === "enemy" ? { ok: true as const, error: undefined } : original ? { ok: true as const, error: undefined } : saveAdapter.saveDetailed(next);
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
        setSaveStatus(original?.phase === "enemy" ? "Сохранённый ход противника разрешён и записан." : original ? "Сохранение загружено." : "Сохранено локально.");
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
  if (bootView.loading || !arena || !catalog || !save || !inventory || !base)
    return (
      <main class="game-shell loading" data-boot-phase={bootView.phase}>
        <h1>{bootView.heading}</h1>
        <p role="status" aria-live={bootView.live}>
          {bootView.message}
        </p>
      </main>
    );
  const home = campaign.screen !== "mission";
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
        <section class="campaign-grid">
          <div class="card home-panel">
            <span class="label">БАЗА / ДОМАШНИЙ ЭКРАН</span>
            <h2>Бункер у периметра</h2>
            <p>
              Здоровье:{" "}
              <b>
                {hero?.hp ?? 0}/{hero?.maxHp ?? 0}
              </b>
            </p>
            <p>
              Рюкзак:{" "}
              <b>
                {totalWeight(inventory).toFixed(0)}/{inventory.backpackCapacity}
              </b>{" "}
              · stash без лимита
            </p>
            <p>
              Stash: металл {resourceQuantity(inventory, "metal")}, ткань{" "}
              {resourceQuantity(inventory, "cloth")}
            </p>
            <p>
              Узлы: верстак L{base.workbench}, медотсек L{base.medbay}, склад L
              {base.stash}
            </p>
            <div class="actions">
              {repairTargets.map((target) => (
                <button
                  key={target.instanceId}
                  onClick={() => repair(target.instanceId)}
                  disabled={target.durability >= target.maxDurability}
                >
                  РЕМОНТ: {itemLabel(target.itemId, catalog)} —{" "}
                  {target.durability}/{target.maxDurability},{" "}
                  {repairCostText(target)}
                </button>
              ))}
              <button onClick={medbay}>МЕДОТСЕК — БИНТ ИЗ STASH</button>
              <button onClick={openMissionSelect}>ВЫБРАТЬ МИССИЮ</button>
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
                {itemLabel(entry.itemId, catalog)}:{" "}
                <b>{equipmentDurabilityPercent(entry)}% durability</b>
              </p>
            ))}
            <h3>Крафт</h3>
            <div class="actions">
              {catalog.recipes.map((recipe) => (
                <button key={recipe.id} onClick={() => craftRecipe(recipe.id)}>
                  {recipe.name} — {recipe.description}
                </button>
              ))}
            </div>
            <h3>Улучшения</h3>
            <div class="actions">
              {catalog.upgrades.map((entry) => (
                <button
                  key={entry.id}
                  disabled={base[entry.node] >= entry.targetLevel}
                  onClick={() => upgrade(entry.id)}
                >
                  {entry.name}: {entry.description}
                </button>
              ))}
            </div>
          </div>
          <div class="card inventory-panel">
            <span class="label">STASH ↔ РЮКЗАК</span>
            <h2>Снаряжение вылазки</h2>
            <p>
              Нажмите строку, чтобы перенести одну единицу. Рюкзак имеет весовой
              лимит; stash — нет.
            </p>
            <h3>Stash</h3>
            <ul>
              {inventory.stash.resources.map((entry) => (
                <li key={`sr-${entry.id}`}>
                  <button onClick={() => moveResource(entry.id, "stash")}>
                    {entry.id} ×{entry.quantity} → рюкзак
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
            </ul>
            <h3>Рюкзак</h3>
            <ul>
              {inventory.backpack.resources.map((entry) => (
                <li key={`br-${entry.id}`}>
                  <button onClick={() => moveResource(entry.id, "backpack")}>
                    {entry.id} ×{entry.quantity} → stash
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
          <div class="card">
            <span class="label">MISSION SELECT</span>
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
            {campaign.screen === "reward" && <div class="actions"><button disabled={rewardClaimLocked} onClick={collectReward}>ЗАБРАТЬ НАГРАДУ</button></div>}
            {campaign.screen === "return" && <div class="actions"><button onClick={returnHome}>ВЕРНУТЬСЯ НА БАЗУ</button><button onClick={retryMission}>ПОВТОРИТЬ МИССИЮ</button></div>}
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
            <div class="actions">
               {(Object.keys(POSTURES) as Posture[]).map((id) => (
                 <button
                   key={id}
                   class={hero?.posture === id ? "active" : ""}
                  onClick={() => changePosture(id)}
                >
                  {POSTURES[id].label}
                </button>
              ))}
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
            {breakdown && (
              <div class="breakdown">
                <strong>ШАНС ПОПАДАНИЯ {breakdown.final}%</strong>
                <small>
                  Урон {breakdown.damage} · {getAttack(part).effect}
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
              disabled={phase !== "player"}
              onClick={activateOverwatch}
            >
              OVERWATCH (O)
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
