import { describe, expect, it } from "vitest";
import { buildCombatScreen, combatControlIds } from "./combat-view";
import { AP_PER_TURN, cellKey, findReachable, type Unit, type WeaponState } from "./combat";

const weapon = (): WeaponState => ({
  weaponInstanceId: "hero-w",
  weaponId: "w",
  name: "Оружие",
  ammoId: "a",
  baseDamage: 8,
  accuracyModifier: 0,
  critModifier: 0,
  penetration: 0,
  ammoDamageModifier: 0,
  ammoPenetrationModifier: 0,
  magazine: 3,
  magazineSize: 6,
  reserveAmmo: 12,
  durability: 70,
  maxDurability: 100,
  durabilityPerShot: 2,
  reloadAp: 3,
  makeshift: false,
});
const hero: Unit = {
  id: "hero", name: "Оперативник", team: "player", x: 1, y: 4, hp: 30,
  maxHp: 30, aim: 55, color: "#8ce", ap: AP_PER_TURN, statuses: {},
  weaponState: weapon(),
};
const foe: Unit = { ...hero, id: "foe", team: "enemy", x: 5, y: 1 };

const view = (phase: "player" | "enemy" | "victory" | "defeat" = "player") =>
  buildCombatScreen({
    hero,
    units: [hero, foe],
    cover: [],
    reachability: findReachable(hero, hero.ap, 7, 6, new Set()),
    phase,
    targetable: new Set([cellKey(5, 1)]),
    targetId: null,
  });

describe("M3-C combat view model has no duplicate state or controls", () => {
  it("exposes exactly one equipment section and maintenance group", () => {
    const combat = view();
    expect(combat.equipment.id).toBe("equipment-state");
    expect(combat.controlGroups.map((group) => group.id)).toEqual(["weapon-maintenance"]);
    expect(combatControlIds(combat)).toEqual(["reload", "clear-jam"]);
  });

  it("keeps one control per action and gates both controls off-turn", () => {
    for (const phase of ["player", "enemy", "victory", "defeat"] as const) {
      const controls = view(phase).controlGroups[0].controls;
      expect(controls.map((control) => control.id)).toEqual(["reload", "clear-jam"]);
      if (phase !== "player") expect(controls.every((control) => control.disabled)).toBe(true);
    }
  });

  it("uses one target collection and preserves visible keyboard labels", () => {
    const combat = view();
    expect(combat.targets).toHaveLength(1);
    expect(combat.targets[0].ariaLabel).toContain("Выбрать цель");
    expect(combat.shortcutsHint).toContain("Tab/Shift+Tab");
  });

  it("keeps every legal move in the model, including disclosed destinations", () => {
    const combat = view();
    expect(combat.moves.recommended.length).toBeLessThan(combat.moves.total);
    expect(combat.moves.remaining.length).toBe(combat.moves.total - combat.moves.recommended.length);
    expect(new Set([...combat.moves.recommended, ...combat.moves.remaining].map((move) => move.key)).size)
      .toBe(combat.moves.total);
  });
});
