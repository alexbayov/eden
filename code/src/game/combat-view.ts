/**
 * Pure view models for the combat screen (M3-C UX remediation).
 *
 * The rendered combat DOM must be derived from these descriptors instead of hand-written
 * JSX blocks: every control group is produced exactly once here, so a duplicated equipment
 * panel or a duplicated reload/clear-malfunction group cannot be reintroduced by copy-paste
 * without failing `combat-view.test.ts` / `ui-duplication.test.ts`.
 */
import {
  cellKey,
  coverPenalty,
  defensiveCover,
  gridDistance,
  hasLineOfSight,
  isAlive,
  type Cover,
  type CoverType,
  type Reachability,
  type Unit,
} from "./combat";

export type CombatPhase = "player" | "enemy" | "victory" | "defeat";

/** Default number of reachable destinations shown before progressive disclosure. */
export const RECOMMENDED_MOVE_LIMIT = 6;
/** Narrow phone lists stay shorter through application state, not CSS clipping. */
export const COMPACT_RECOMMENDED_MOVE_LIMIT = 4;

export const recommendedMoveLimitForViewport = (width: number) =>
  width <= 430 ? COMPACT_RECOMMENDED_MOVE_LIMIT : RECOMMENDED_MOVE_LIMIT;

const COVER_LABEL: Record<CoverType, string> = {
  none: "без укрытия",
  partial: "частичное укрытие",
  full: "полное укрытие",
};

const cellLabel = (x: number, y: number) => `Клетка ${x + 1},${y + 1}`;

/* ------------------------------------------------------------------ equipment */

export interface EquipmentWeaponView {
  name: string;
  ammoId: string;
  magazine: number;
  magazineSize: number;
  reserveAmmo: number;
  durability: number;
  maxDurability: number;
  reloadAp: number;
  malfunctioned: boolean;
  status: string;
}
export interface EquipmentArmorView {
  name: string;
  durability: number;
  maxDurability: number;
  protection: string;
}
export interface EquipmentStateView {
  /** Stable id of the single equipment-state section rendered in the combat DOM. */
  id: "equipment-state";
  title: string;
  weapon: EquipmentWeaponView;
  armor: EquipmentArmorView;
  /** Single-line summary used for the aria-live announcement. */
  summary: string;
}

/** Human-readable armor reduction summary; the only implementation in the app. */
export const armorSummary = (unit: Pick<Unit, "armor"> | undefined) =>
  unit?.armor
    ? Object.entries(unit.armor.reduction)
        .map(([part, amount]) => `${part} −${amount}`)
        .join(", ") || "нет защиты"
    : "нет брони";

export function buildEquipmentState(
  hero: Unit | undefined,
  labelFor: (itemId: string) => string = (itemId) => itemId,
): EquipmentStateView {
  const weaponState = hero?.weaponState;
  const armor = hero?.armor;
  const weapon: EquipmentWeaponView = {
    name: weaponState?.name ?? "не экипировано",
    ammoId: weaponState?.ammoId ?? "—",
    magazine: weaponState?.magazine ?? 0,
    magazineSize: weaponState?.magazineSize ?? 0,
    reserveAmmo: weaponState?.reserveAmmo ?? 0,
    durability: weaponState?.durability ?? 0,
    maxDurability: weaponState?.maxDurability ?? 0,
    reloadAp: weaponState?.reloadAp ?? 0,
    malfunctioned: Boolean(weaponState?.malfunctioned),
    status: !weaponState
      ? "нет оружия"
      : weaponState.malfunctioned
        ? "ОСЕЧКА"
        : "исправно",
  };
  const armorView: EquipmentArmorView = {
    name: armor?.armorId ? labelFor(armor.armorId) : "не экипирована",
    durability: armor?.durability ?? 0,
    maxDurability: armor?.maxDurability ?? 0,
    protection: armorSummary(hero),
  };
  return {
    id: "equipment-state",
    title: "Состояние экипировки",
    weapon,
    armor: armorView,
    summary: `Оружие: ${weapon.name}, магазин ${weapon.magazine}/${weapon.magazineSize}, резерв ${weapon.reserveAmmo}, ${weapon.status}. Броня: ${armorView.name}, ${armorView.durability}/${armorView.maxDurability}.`,
  };
}

/* ------------------------------------------------------- weapon control group */

export type CombatControlId = "reload" | "clear-jam";
export interface CombatControl {
  id: CombatControlId;
  label: string;
  ariaLabel: string;
  disabled: boolean;
}
export interface CombatControlGroup {
  id: "weapon-maintenance";
  title: string;
  controls: CombatControl[];
}

/**
 * Returns the weapon-maintenance control group. Always exactly one group with exactly one
 * button per action, so the combat DOM cannot render a second reload/clear pair.
 */
export function buildCombatControlGroups(
  hero: Unit | undefined,
  phase: CombatPhase,
): CombatControlGroup[] {
  const weaponState = hero?.weaponState;
  const playerTurn = phase === "player";
  const reloadAp = weaponState?.reloadAp ?? 0;
  const canReload = Boolean(
    weaponState &&
      playerTurn &&
      !weaponState.malfunctioned &&
      weaponState.magazine < weaponState.magazineSize &&
      weaponState.reserveAmmo > 0 &&
      hero!.ap >= reloadAp,
  );
  const canClear = Boolean(
    weaponState?.malfunctioned && playerTurn && hero!.ap >= 2,
  );
  return [
    {
      id: "weapon-maintenance",
      title: "Обслуживание оружия",
      controls: [
        {
          id: "reload",
          label: `ПЕРЕЗАРЯДИТЬ — ${reloadAp} ОЧ`,
          ariaLabel: `Перезарядить оружие за ${reloadAp} ОЧ`,
           disabled: !canReload,

        },
        {
          id: "clear-jam",
          label: "ОЧИСТИТЬ ОСЕЧКУ — 2 ОЧ",
          ariaLabel: "Очистить осечку за 2 ОЧ",
           disabled: !canClear,

        },
      ],
    },
  ];
}

/* ---------------------------------------------------------------- target list */

export interface TargetOption {
  id: string;
  label: string;
  description: string;
  ariaLabel: string;
  disabled: boolean;
  selected: boolean;
  visible: boolean;
}

export function buildTargetOptions(input: {
  hero?: Unit;
  units: readonly Unit[];
  targetable: ReadonlySet<string>;
  targetId: string | null;
  phase: CombatPhase;
}): TargetOption[] {
  const { hero, units, targetable, targetId, phase } = input;
  return units
    .filter((unit) => unit.team === "enemy" && isAlive(unit))
    .map((enemy) => {
      const visible = targetable.has(cellKey(enemy.x, enemy.y));
      const distance = gridDistance(hero ?? enemy, enemy);
      const description = `${distance} кл. · ${visible ? "линия огня есть" : "линии огня нет"}${enemy.intent ? ` · ${enemy.intent}` : ""} · HP ${enemy.hp}/${enemy.maxHp}`;
      return {
        id: enemy.id,
        label: `${enemy.name} (${enemy.x + 1},${enemy.y + 1})`,
        description,
        ariaLabel: `Выбрать цель ${enemy.name}, ${description}`,
        disabled: !visible || phase !== "player",
        selected: targetId === enemy.id,
        visible,
      };
    });
}

/* -------------------------------------------------------------- move options */

export interface MoveOption {
  key: string;
  x: number;
  y: number;
  cost: number;
  cover: CoverType;
  lineOfSight: boolean;
  distanceToEnemy: number | null;
  label: string;
  description: string;
  ariaLabel: string;
  disabled: boolean;
  recommended: boolean;
}
export interface MoveOptionsView {
  total: number;
  /** Visible text summary; never relies on hover or title attributes. */
  summary: string;
  recommended: MoveOption[];
  /** Every remaining legal destination, revealed by progressive disclosure. */
  remaining: MoveOption[];
  hasMore: boolean;
  expandLabel: string | null;
  collapseLabel: string;
  liveMessage: string;
}
export interface MoveOptionsInput {
  hero?: Unit;
  units: readonly Unit[];
  cover: readonly Cover[];
  reachability: Reachability;
  phase: CombatPhase;
  targetId?: string | null;
  expanded?: boolean;
  limit?: number;
  /** Optional viewport policy input; App supplies this from matchMedia/window width. */
  viewportWidth?: number;
}

/**
 * Ranks every legal destination and splits it into a short recommended head and a
 * progressively disclosed tail. Ranking prefers cells that keep a firing line, then cover,
 * then the cheapest/nearest option; ties break on the cell key so output is deterministic.
 */
export function buildMoveOptions(input: MoveOptionsInput): MoveOptionsView {
  const { hero, units, cover, reachability, phase } = input;
  const limit = Math.max(
    0,
    input.limit ??
      (input.viewportWidth === undefined
        ? RECOMMENDED_MOVE_LIMIT
        : recommendedMoveLimitForViewport(input.viewportWidth)),
  );
  const disabled = !hero || phase !== "player";
  const enemies = units.filter((unit) => unit.team === "enemy" && isAlive(unit));
  const coverList = cover as Cover[];
  const staticBlockers = cover
    .filter((entry) => entry.kind === "full")
    .map((entry) => cellKey(entry.x, entry.y));
  const unitBlockers = units
    .filter((unit) => isAlive(unit) && unit.id !== hero?.id)
    .map((unit) => cellKey(unit.x, unit.y));
  const selectedTarget = input.targetId
    ? enemies.find((enemy) => enemy.id === input.targetId)
    : undefined;
  const reference = selectedTarget ?? (hero
    ? [...enemies].sort(
        (a, b) =>
          gridDistance(hero, a) - gridDistance(hero, b) ||
          a.id.localeCompare(b.id),
      )[0]
    : undefined);
  const losBlockers = new Set([
    ...staticBlockers,
    ...(reference
      ? unitBlockers.filter(
          (key) => key !== cellKey(reference.x, reference.y),
        )
      : unitBlockers),
  ]);
  const heroKey = cellKey(hero?.x ?? -1, hero?.y ?? -1);
  const options = [...reachability.costs.entries()]
    .filter(([key]) => key !== heroKey)
    .map(([key, cost]) => {
      const [x, y] = key.split(",").map(Number);
      const point = { x, y };
      const cellCover = reference
        ? defensiveCover(reference, point, coverList)
        : ("none" as CoverType);
      const lineOfSight = reference
        ? hasLineOfSight(point, reference, losBlockers)
        : false;
      const distanceToEnemy = enemies.length
        ? Math.min(...enemies.map((enemy) => gridDistance(point, enemy)))
        : null;
      const description = `${cost} ОЧ · ${COVER_LABEL[cellCover]} · ${lineOfSight ? "линия огня есть" : "линии огня нет"}${distanceToEnemy === null ? "" : ` · до врага ${distanceToEnemy} кл.`}`;
      const label = cellLabel(x, y);
      return {
        key,
        x,
        y,
        cost,
        cover: cellCover,
        lineOfSight,
        distanceToEnemy,
        label,
        description,
        ariaLabel: `Переместиться в ${label.toLowerCase()}: ${description}`,
        disabled,
        recommended: false,
      };
    })
    .sort(
      (a, b) =>
        Number(b.lineOfSight) - Number(a.lineOfSight) ||
        coverPenalty(b.cover) - coverPenalty(a.cover) ||
        a.cost - b.cost ||
        (a.distanceToEnemy ?? 0) - (b.distanceToEnemy ?? 0) ||
        a.key.localeCompare(b.key),
    );
  const recommended = options
    .slice(0, limit)
    .map((option) => ({ ...option, recommended: true }));
  const remaining = options.slice(limit);
  const total = options.length;
  const hasMore = remaining.length > 0;
  const shownCount = input.expanded ? total : recommended.length;
  const summary = !hero
    ? "Перемещение недоступно: оперативник не загружен."
    : phase !== "player"
      ? "Перемещение недоступно: сейчас не ваш ход."
      : hero.posture === "prone"
        ? "Перемещение недоступно: оперативник лежит и должен сначала сменить позу."
        : hero.statuses?.immobilized
          ? "Перемещение недоступно: оперативник обездвижен."
          : hero.statuses?.shocked
            ? "Перемещение недоступно: оперативник в шоке, ход пропущен."
            : total === 0
              ? "Нет доступных клеток: не хватает ОЧ или проходов."
              : input.expanded
                ? `Доступно клеток: ${total}. Показаны все.`
                : hasMore
                  ? `Доступно клеток: ${total}. Показаны ${shownCount} рекомендуемых (линия огня, укрытие, близость).`
                  : `Доступно клеток: ${total}. Показаны все.`;
  return {
    total,
    summary,
    recommended,
    remaining,
    hasMore,
    expandLabel: hasMore ? `Показать ещё (${remaining.length})` : null,
    collapseLabel: "Свернуть полный список клеток",
    liveMessage:
      total === 0
        ? summary
        : input.expanded
          ? `Показаны все ${total} клеток для перемещения.`
          : hasMore
            ? `Показаны ${recommended.length} из ${total} клеток. Кнопка «Показать ещё» открывает остальные.`
            : `Показаны все ${total} клеток для перемещения.`,
  };
}

/* ------------------------------------------------------------ combat screen */

export interface CombatScreenView {
  /** Exactly one equipment-state section for the whole combat screen. */
  equipment: EquipmentStateView;
  /** Exactly one weapon-maintenance control group for the whole combat screen. */
  controlGroups: CombatControlGroup[];
  targets: TargetOption[];
  moves: MoveOptionsView;
  /** Keyboard shortcut hint; visible text, not a hover-only affordance. */
  shortcutsHint: string;
}
export interface CombatScreenInput extends MoveOptionsInput {
  targetable: ReadonlySet<string>;
  targetId: string | null;
  labelFor?: (itemId: string) => string;
}

/**
 * The single descriptor the combat DOM renders from. Because the equipment section and the
 * weapon-maintenance group are produced here once, rendering this view cannot emit duplicate
 * panels or duplicate reload/clear-malfunction buttons.
 */
export function buildCombatScreen(input: CombatScreenInput): CombatScreenView {
  return {
    equipment: buildEquipmentState(input.hero, input.labelFor),
    controlGroups: buildCombatControlGroups(input.hero, input.phase),
    targets: buildTargetOptions({
      hero: input.hero,
      units: input.units,
      targetable: input.targetable,
      targetId: input.targetId,
      phase: input.phase,
    }),
    moves: buildMoveOptions(input),
    shortcutsHint:
      "Tab/Shift+Tab — переход между кнопками, Enter/Space — действие, E — конец хода, O — Overwatch, 1–6 — часть тела.",
  };
}

/** Flat control inventory used by duplication assertions and by the DOM renderer. */
export const combatControlIds = (view: CombatScreenView): CombatControlId[] =>
  view.controlGroups.flatMap((group) =>
    group.controls.map((control) => control.id),
  );
