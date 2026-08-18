import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_MOVE_LIMIT,
  COMPACT_RECOMMENDED_MOVE_LIMIT,
  recommendedMoveLimitForViewport,
  armorSummary,
  buildCombatControlGroups,
  buildCombatScreen,
  buildEquipmentState,
  buildMoveOptions,
  buildTargetOptions,
  combatControlIds,
  type CombatScreenInput,
} from "./combat-view";
import {
  AP_PER_TURN,
  cellKey,
  findReachable,
  type Cover,
  type Unit,
  type WeaponState,
} from "./combat";

const weapon = (overrides: Partial<WeaponState> = {}): WeaponState => ({
  weaponInstanceId: "hero-hornet",
  weaponId: "hornet",
  name: "Хорнет",
  ammoId: "ammo-9",
  baseDamage: 10,
  accuracyModifier: 0,
  critModifier: 0,
  penetration: 0,
  ammoDamageModifier: 0,
  ammoPenetrationModifier: 0,
  magazine: 4,
  magazineSize: 8,
  reserveAmmo: 16,
  durability: 80,
  maxDurability: 100,
  durabilityPerShot: 2,
  reloadAp: 3,
  makeshift: false,
  ...overrides,
});

const unit = (overrides: Partial<Unit> = {}): Unit => ({
  id: "hero",
  name: "Оперативник",
  team: "player",
  x: 1,
  y: 4,
  hp: 30,
  maxHp: 30,
  aim: 55,
  color: "#8ce",
  ap: AP_PER_TURN,
  posture: "stand",
  statuses: {},
  weaponState: weapon(),
  ...overrides,
});

const enemy = (overrides: Partial<Unit> = {}): Unit =>
  unit({
    id: "raider-1",
    name: "Рейдер",
    team: "enemy",
    x: 5,
    y: 1,
    weaponState: weapon({ weaponInstanceId: "raider-1-akm" }),
    ...overrides,
  });

/** 7x6 arena mirroring public/config/arena.json geometry. */
const arena = { width: 7, height: 6 };
const cover: Cover[] = [
  { x: 3, y: 2, kind: "full" },
  { x: 4, y: 2, kind: "partial" },
  { x: 3, y: 4, kind: "full" },
  { x: 5, y: 3, kind: "partial" },
];

const reachabilityFor = (hero: Unit, units: readonly Unit[]) =>
  findReachable(
    hero,
    hero.ap,
    arena.width,
    arena.height,
    new Set([
      ...cover.filter((c) => c.kind === "full").map((c) => cellKey(c.x, c.y)),
      ...units
        .filter((u) => u.id !== hero.id && u.hp > 0)
        .map((u) => cellKey(u.x, u.y)),
    ]),
  );

const screenInput = (
  overrides: Partial<CombatScreenInput> = {},
): CombatScreenInput => {
  const hero = (overrides.hero ?? unit()) as Unit;
  const units = overrides.units ?? [hero, enemy()];
  return {
    hero,
    units,
    cover,
    reachability: reachabilityFor(hero, units),
    phase: "player",
    targetable: new Set([cellKey(5, 1)]),
    targetId: null,
    ...overrides,
  };
};

describe("M3-C combat control view model — no duplicate control groups", () => {
  it("produces exactly one equipment-state section and one weapon-maintenance group", () => {
    const view = buildCombatScreen(screenInput());
    expect(view.equipment.id).toBe("equipment-state");
    const groups = view.controlGroups.filter(
      (group) => group.id === "weapon-maintenance",
    );
    expect(groups).toHaveLength(1);
    expect(view.controlGroups).toHaveLength(1);
    const ids = combatControlIds(view);
    expect(ids).toEqual(["reload", "clear-jam"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("emits one reload and one clear-jam control across every phase and weapon state", () => {
    const phases = ["player", "enemy", "victory", "defeat"] as const;
    const heroes = [
      unit(),
      unit({ weaponState: weapon({ malfunctioned: true }) }),
      unit({ weaponState: undefined }),
      undefined,
    ];
    for (const phase of phases)
      for (const hero of heroes) {
        const ids = combatControlIds(
          buildCombatScreen(screenInput({ hero, phase })),
        );
        expect(ids.filter((id) => id === "reload")).toHaveLength(1);
        expect(ids.filter((id) => id === "clear-jam")).toHaveLength(1);
      }
  });

  it("keeps equipment-state ids unique so a second panel cannot be rendered", () => {
    const view = buildCombatScreen(screenInput());
    const sections = [view.equipment].filter(
      (section) => section.id === "equipment-state",
    );
    expect(sections).toHaveLength(1);
  });

  it("gates reload and clear-jam on every domain precondition", () => {
    const jammed = buildCombatControlGroups(
      unit({ weaponState: weapon({ malfunctioned: true }) }),
      "player",
    )[0].controls;
    expect(jammed.map((control) => control.disabled)).toEqual([true, false]);
    const fullMagazine = buildCombatControlGroups(
      unit({ weaponState: weapon({ magazine: 8, magazineSize: 8, reserveAmmo: 4 }) }),
      "player",
    )[0].controls;
    expect(fullMagazine.map((control) => control.disabled)).toEqual([true, true]);
    const reloadable = buildCombatControlGroups(
      unit({ ap: 3, weaponState: weapon({ magazine: 0, reserveAmmo: 4 }) }),
      "player",
    )[0].controls;
    expect(reloadable.map((control) => control.disabled)).toEqual([false, true]);
    const noReserve = buildCombatControlGroups(
      unit({ weaponState: weapon({ magazine: 0, reserveAmmo: 0 }) }),
      "player",
    )[0].controls;
    expect(noReserve.map((control) => control.disabled)).toEqual([true, true]);
    const lowAp = buildCombatControlGroups(
      unit({ ap: 1, weaponState: weapon({ magazine: 0, reserveAmmo: 4 }) }),
      "player",
    )[0].controls;
    expect(lowAp.map((control) => control.disabled)).toEqual([true, true]);
    const enemyTurn = buildCombatControlGroups(unit(), "enemy")[0].controls;
    expect(enemyTurn.every((control) => control.disabled)).toBe(true);
    const unarmed = buildCombatControlGroups(
      unit({ weaponState: undefined }),
      "player",
    )[0].controls;
    expect(unarmed.every((control) => control.disabled)).toBe(true);
  });

  it("labels every control without relying on hover-only text", () => {
    for (const control of buildCombatControlGroups(unit(), "player")[0]
      .controls) {
      expect(control.label.length).toBeGreaterThan(0);
      expect(control.ariaLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("M3-C equipment state view model", () => {
  it("renders live weapon and armor values from the single hero source", () => {
    const view = buildEquipmentState(
      unit({
        weaponState: weapon({ magazine: 2, malfunctioned: true }),
        armor: {
          armorInstanceId: "vest-1",
          armorId: "vest",
          reduction: { torso: 8, head: 3 },
          durability: 55,
          maxDurability: 100,
        },
      }),
      (id) => (id === "vest" ? "Бронежилет" : id),
    );
    expect(view.weapon).toMatchObject({
      name: "Хорнет",
      magazine: 2,
      magazineSize: 8,
      malfunctioned: true,
      status: "ОСЕЧКА",
    });
    expect(view.armor).toMatchObject({
      name: "Бронежилет",
      durability: 55,
      protection: "torso −8, head −3",
    });
    expect(view.summary).toContain("Хорнет");
  });

  it("degrades safely without a hero", () => {
    const view = buildEquipmentState(undefined);
    expect(view.weapon.status).toBe("нет оружия");
    expect(view.armor.name).toBe("не экипирована");
    expect(armorSummary(undefined)).toBe("нет брони");
    expect(armorSummary({ armor: { reduction: {}, durability: 1, maxDurability: 1 } })).toBe(
      "нет защиты",
    );
  });
});

describe("M3-C tactical move options — compact progressive disclosure", () => {
  const input = screenInput();

  it("caps the visible list at six recommended destinations while keeping every legal move reachable", () => {
    const moves = buildMoveOptions(input);
    expect(moves.total).toBeGreaterThan(20);
    expect(moves.recommended.length).toBeLessThanOrEqual(6);
    expect(moves.recommended).toHaveLength(RECOMMENDED_MOVE_LIMIT);
    expect(moves.hasMore).toBe(true);
    expect(moves.recommended.length + moves.remaining.length).toBe(moves.total);
    const keys = [...moves.recommended, ...moves.remaining].map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    const reachableKeys = [...input.reachability.costs.keys()].filter(
      (key) => key !== cellKey(1, 4),
    );
    expect(new Set(keys)).toEqual(new Set(reachableKeys));
  });

  it("prefers line of sight, then cover, then cheapest cells", () => {
    const moves = buildMoveOptions(input);
    const ranked = [...moves.recommended, ...moves.remaining];
    for (let i = 1; i < ranked.length; i += 1) {
      const previous = ranked[i - 1];
      const current = ranked[i];
      if (previous.lineOfSight !== current.lineOfSight)
        expect(previous.lineOfSight).toBe(true);
    }
    expect(moves.recommended.every((option) => option.recommended)).toBe(true);
    expect(moves.recommended.some((option) => option.lineOfSight)).toBe(true);
  });

  it("describes each destination with visible text and an accessible label", () => {
    for (const option of buildMoveOptions(input).recommended) {
      expect(option.label).toMatch(/^Клетка \d+,\d+$/);
      expect(option.description).toContain("ОЧ");
      expect(option.ariaLabel).toContain("Переместиться");
      expect(option.ariaLabel).toContain(option.description);
    }
  });

  it("exposes a «Показать ещё» affordance with the remaining count", () => {
    const collapsed = buildMoveOptions(input);
    expect(collapsed.expandLabel).toBe(
      `Показать ещё (${collapsed.remaining.length})`,
    );
    expect(collapsed.liveMessage).toContain(`из ${collapsed.total}`);
    const expanded = buildMoveOptions({ ...input, expanded: true });
    expect(expanded.liveMessage).toContain(`все ${expanded.total}`);
    expect(expanded.collapseLabel).toContain("Свернуть");
  });

  it("uses a shorter application policy for narrow phones", () => {
    expect(recommendedMoveLimitForViewport(430)).toBe(COMPACT_RECOMMENDED_MOVE_LIMIT);
    expect(recommendedMoveLimitForViewport(390)).toBe(COMPACT_RECOMMENDED_MOVE_LIMIT);
    expect(recommendedMoveLimitForViewport(431)).toBe(6);
    expect(buildMoveOptions({ ...input, viewportWidth: 390 }).recommended).toHaveLength(
      COMPACT_RECOMMENDED_MOVE_LIMIT,
    );
  });
  it("uses the selected target as the movement line-of-sight reference", () => {
    const moves = buildMoveOptions({ ...input, targetId: "raider-1" });
    expect(moves.recommended.some((move) => move.lineOfSight)).toBe(true);
  });

  it("keeps all moves unavailable when no hero is present", () => {
    const moves = buildMoveOptions({ ...input, hero: undefined });
    expect(moves.recommended.every((move) => move.disabled)).toBe(true);
    expect(moves.summary).toContain("оперативник не загружен");
  });

  it("supports an explicit zero recommendation limit without losing legal moves", () => {
    const moves = buildMoveOptions({ ...input, limit: 0 });
    expect(moves.recommended).toHaveLength(0);
    expect(moves.remaining).toHaveLength(moves.total);
    expect(moves.expandLabel).toBe(`Показать ещё (${moves.total})`);
  });
  it("is deterministic for identical inputs", () => {
    const first = buildMoveOptions(input).recommended.map((m) => m.key);
    const second = buildMoveOptions(screenInput()).recommended.map((m) => m.key);
    expect(first).toEqual(second);
  });

  it("disables moves and explains why outside the player phase", () => {
    const moves = buildMoveOptions({ ...input, phase: "enemy" });
    expect(moves.recommended.every((option) => option.disabled)).toBe(true);
    expect(moves.summary).toContain("не ваш ход");
  });

  it("explains posture and status blockers in the empty move reason", () => {
    for (const [hero, reason] of [
      [unit({ posture: "prone" }), "лежит"],
      [unit({ statuses: { immobilized: 2 } }), "обездвижен"],
      [unit({ statuses: { shocked: 1 } }), "шоке"],
    ] as const) {
      expect(buildMoveOptions({ ...screenInput({ hero }), hero }).summary).toContain(reason);
    }
  });
  it("reports an empty state instead of an empty list", () => {
    const hero = unit({ ap: 0 });
    const moves = buildMoveOptions({
      ...screenInput({ hero }),
      hero,
    });
    expect(moves.total).toBe(0);
    expect(moves.hasMore).toBe(false);
    expect(moves.expandLabel).toBeNull();
    expect(moves.summary).toContain("Нет доступных клеток");
  });


  it("shows all destinations without disclosure when they already fit", () => {
    const hero = unit({ ap: 1 });
    const moves = buildMoveOptions(screenInput({ hero }));
    expect(moves.total).toBeLessThanOrEqual(6);
    expect(moves.hasMore).toBe(false);
    expect(moves.summary).toContain("Показаны все");
  });
});

describe("M3-C target options", () => {
  it("marks visibility, selection and keyboard-usable labels", () => {
    const options = buildTargetOptions({
      hero: unit(),
      units: [unit(), enemy(), enemy({ id: "raider-2", x: 5, y: 4 })],
      targetable: new Set([cellKey(5, 1)]),
      targetId: "raider-1",
      phase: "player",
    });
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      id: "raider-1",
      visible: true,
      disabled: false,
      selected: true,
    });
    expect(options[1]).toMatchObject({ visible: false, disabled: true });
    expect(options[1].description).toContain("линии огня нет");
    expect(options[0].ariaLabel).toContain("Выбрать цель");
  });

  it("marks a selected visible target in the view model", () => {
    const [option] = buildTargetOptions({
      hero: unit(),
      units: [unit(), enemy()],
      targetable: new Set([cellKey(5, 1)]),
      targetId: "raider-1",
      phase: "player",
    });
    expect(option.selected).toBe(true);
    expect(option.disabled).toBe(false);
  });
  it("omits dead enemies and disables selection off-turn", () => {
    const options = buildTargetOptions({
      hero: unit(),
      units: [unit(), enemy({ hp: 0 }), enemy({ id: "raider-3", x: 5, y: 1 })],
      targetable: new Set([cellKey(5, 1)]),
      targetId: null,
      phase: "victory",
    });
    expect(options.map((option) => option.id)).toEqual(["raider-3"]);
    expect(options[0].disabled).toBe(true);
  });
});

describe("M3-C combat screen aggregate", () => {
  it("bundles one of each group plus a visible keyboard hint", () => {
    const view = buildCombatScreen(screenInput());
    expect(view.shortcutsHint).toContain("E — конец хода");
    expect(view.shortcutsHint).toContain("O — Overwatch");
    expect(view.shortcutsHint).toContain("1–6");
    expect(Object.keys(view)).toEqual([
      "equipment",
      "controlGroups",
      "targets",
      "moves",
      "shortcutsHint",
    ]);
  });
});
