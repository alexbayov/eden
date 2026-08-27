/**
 * W1-02 — DOM tests for the combat side of the app shell: tactical controls, reward/return
 * screens, and the combat hotkey gate. Campaign screens live in `app-shell.dom.test.tsx`; the
 * split lets Vitest run both files in parallel workers.
 *
 * The hotkey block is the one this repository most needed. `input-gating.ts` was already covered
 * as a pure function, but a pure function cannot prove the *shell's* `window` keydown listener is
 * gated — and that listener is what actually protects the player from an accidental enemy turn on
 * the base screen. Fake timers make the assertion sharper than a sleep would: the enemy phase is
 * only ever reached through `window.setTimeout`, so "zero timers pending" proves no transition was
 * scheduled at all, rather than proving none had fired yet.
 *
 * LIMITATION — jsdom has no layout engine and no canvas, and `createCombatRuntime` is mocked in
 * `dom-harness.ts`. Nothing here is a claim about geometry, touch-target size, or Phaser
 * rendering; those belong to `e2e/viewport-geometry.spec.ts` (W1-05) and `e2e/smoke.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/preact";
import {
  clearStoredSave,
  persistedSave,
  phaseLabel,
  readRawSave,
  renderApp,
  seedRawSave,
  settle,
  shellElement,
  stubShippedContent,
} from "../test/dom-harness";
import {
  buildSave,
  loadShippedContent,
  orderedEncounters,
} from "../test/campaign-save-fixtures";
import { levelForXp, skillPointsGranted } from "./progression";

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [first] = encounters;

/**
 * Recipes and base upgrades come from `loadShippedContent`, which validates them with the runtime
 * validators, so a renamed recipe cannot leave the assertions below matching nothing.
 */
const shippedRecipes = content.recipes;
const shippedUpgrades = content.upgrades;

describe("W1-02 combat controls", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders the tactical panel, the weapon controls and all six body parts", async () => {
    seedRawSave(buildSave(content, { screen: "mission" }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("ВАШ ХОД");
    expect(screen.getByRole("heading", { name: "Тактическое управление" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Обслуживание оружия" })).toBeTruthy();
    /* Exactly one reload and one clear-jam control: the duplication contract from M3-C. */
    expect(screen.getAllByRole("button", { name: /^Перезарядить оружие за \d+ ОЧ$/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Очистить осечку за 2 ОЧ" })).toHaveLength(1);
    /* Six body-part controls, labelled from the combat catalog. */
    for (const label of ["Голова", "Торс", "Рука", "Нога", "Глаз", "Пах"])
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    /* The no-reward exit is present and enabled during the player phase. */
    expect(screen.getByRole("button", { name: /ОТСТУПИТЬ БЕЗ НАГРАДЫ/ })).toHaveProperty("disabled", false);
  });

  it("enables ОГОНЬ only after a target with a firing line is selected", async () => {
    /* Hero placed with line of sight to the shooter, so target selection is legal. */
    seedRawSave(buildSave(content, { screen: "mission", heroAt: { x: 5, y: 2 } }).raw);
    const { container } = await renderApp();

    const fire = () => screen.getByRole("button", { name: "ОГОНЬ" });
    expect(fire()).toHaveProperty("disabled", true);

    const target = screen.getByRole("button", { name: /^Выбрать цель / });
    expect(target).toHaveProperty("disabled", false);
    fireEvent.click(target);

    await settle(() => expect(fire()).toHaveProperty("disabled", false));
    /* The hit breakdown is rendered as visible text, not a hover-only tooltip. */
    expect(container.textContent).toMatch(/ШАНС ПОПАДАНИЯ \d+%/);
  });

  it("selects a body part from the keyboard through the real DOM handler", async () => {
    seedRawSave(buildSave(content, { screen: "mission" }).raw);
    const { container } = await renderApp();

    const activePart = () =>
      container.querySelector(".action-tray .actions button.active")?.textContent?.replace(/\s+/g, " ");
    expect(activePart()).toContain("Торс");

    fireEvent.keyDown(window, { key: "1" });

    expect(activePart()).toContain("Голова");
  });
});

describe("W1-02 reward and return screens", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("awards the catalog reward exactly once and returns to base", async () => {
    const reward = content.rewards.find((entry) => entry.id === first.rewardId)!;
    seedRawSave(buildSave(content, { screen: "reward" }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("НАГРАДА");
    fireEvent.click(screen.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const persisted = persistedSave();
    /* XP and resources come from the shipped reward definition, not a literal in this test. */
    expect(persisted.campaign.xp).toBe(reward.xp);
    expect(persisted.campaign.claimedRewards).toEqual([reward.id]);
    expect(persisted.inventory.stash.resources).toEqual(
      Object.entries(reward.resources).map(([id, quantity]) => ({ id, quantity, weight: 1 })),
    );
    /* The claim button is gone, so the UI itself cannot offer a second claim. */
    expect(screen.queryByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" })).toBeNull();
    expect(container.textContent).toContain(`XP: ${reward.xp}`);
  });

  it("offers return and retry after a failure, without granting a reward", async () => {
    seedRawSave(buildSave(content, { screen: "return" }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("ВОЗВРАТ");
    expect(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const persisted = persistedSave();
    expect(persisted.campaign.xp).toBe(0);
    expect(persisted.campaign.claimedRewards).toEqual([]);
  });

  it("shows the level and the progress to the next level on the reward screen", async () => {
    /* W4-01 criterion 4: the reward screen is one of the two places the level must be visible. */
    const reward = content.rewards.find((entry) => entry.id === first.rewardId)!;
    seedRawSave(buildSave(content, { screen: "reward" }).raw);
    const { container } = await renderApp();

    /* Two progression readouts render at once — the base panel and the reward panel — and the
       criterion asks for both, so each is addressed rather than taking whichever comes first. */
    const readouts = () => [...container.querySelectorAll("p.progression")].map((node) => node.textContent ?? "");
    expect(readouts()).toHaveLength(2);
    for (const text of readouts()) expect(text).toContain("Уровень 1");
    expect(readouts().some((text) => text.includes(`+${reward.xp} XP`))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "ЗАБРАТЬ НАГРАДУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    /* The claim advanced the persisted level, not just the XP counter. */
    const level = levelForXp(reward.xp, content.progression.curve);
    expect(persistedSave().character).toEqual({
      level,
      xp: reward.xp,
      unspentSkillPoints: skillPointsGranted(level, content.progression.curve),
    });
    expect(readouts()[0]).toContain(`Уровень ${level}`);
    /* D-02 sent skills post-MVP: the point is persisted above but never advertised on screen. */
    expect(readouts()[0]).not.toContain("нераспределённых очков");
  });
});

describe("W4-02 death penalty on the return screen", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  const curve = content.progression.curve;
  /** XP mid-band on L2, so a penalty is charged by the rate rather than clipped by the level floor. */
  const chargedXp = curve.thresholds[0] + 20;

  it("states that the first defeat is free before the player confirms the return", async () => {
    seedRawSave(buildSave(content, { screen: "return", xp: chargedXp, claimedRewards: [] }).raw);
    const { container } = await renderApp();

    const notice = container.querySelector("p.death-penalty")!;
    expect(notice.getAttribute("data-reason")).toBe("defeat");
    expect(notice.getAttribute("data-penalty")).toBe("0");
    expect(notice.textContent).toContain("Первое поражение");

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const persisted = persistedSave();
    expect(persisted.campaign.xp).toBe(chargedXp);
    expect(persisted.campaign.firstDeathReturnUsed).toBe(true);
  });

  it("charges exactly the XP it stated on a later defeat, and never drops the level", async () => {
    seedRawSave(
      buildSave(content, { screen: "return", xp: chargedXp, claimedRewards: [], firstDeathReturnUsed: true }).raw,
    );
    const { container } = await renderApp();

    const notice = container.querySelector("p.death-penalty")!;
    const stated = Number(notice.getAttribute("data-penalty"));
    expect(stated).toBeGreaterThan(0);
    expect(notice.textContent).toContain(`−${stated} XP`);
    /*
     * The message names what is *not* taken, so the player is not left guessing.
     *
     * Since W5-05 that list no longer includes «ресурсы»: a non-free defeat does take part of the
     * *carried* backpack, resources included. Claiming otherwise here would be the test asserting a
     * promise the code has stopped keeping. What survives unconditionally is the base — the stash and
     * worn equipment — and that is what both notices state.
     */
    expect(notice.textContent).toContain("Stash и экипировка не затронуты");
    expect(notice.textContent).not.toContain("Ресурсы, stash и экипировка не затронуты");
    expect(container.querySelector("p.backpack-loss")!.textContent).toContain(
      "Stash, надетая экипировка и её durability не затрагиваются",
    );

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const persisted = persistedSave();
    /* Exactly the number that was shown, and the level survives it. */
    expect(persisted.campaign.xp).toBe(chargedXp - stated);
    expect(persisted.character.xp).toBe(chargedXp - stated);
    expect(persisted.character.level).toBe(levelForXp(chargedXp, curve));
  });

  it("shows a different, XP-free consequence for a retreat", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "return",
        returnReason: "retreat",
        xp: chargedXp,
        claimedRewards: [],
        firstDeathReturnUsed: true,
      }).raw,
    );
    const { container } = await renderApp();

    const notice = container.querySelector("p.death-penalty")!;
    expect(notice.getAttribute("data-reason")).toBe("retreat");
    expect(notice.getAttribute("data-penalty")).toBe("0");
    expect(notice.textContent).toContain("XP не теряется");

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    expect(persistedSave().campaign.xp).toBe(chargedXp);
  });

  it("charges a retry the same as a walk home, so retry is not a free undo", async () => {
    seedRawSave(
      buildSave(content, { screen: "return", xp: chargedXp, claimedRewards: [], firstDeathReturnUsed: true }).raw,
    );
    const { container } = await renderApp();
    const stated = Number(container.querySelector("p.death-penalty")!.getAttribute("data-penalty"));

    fireEvent.click(screen.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" }));

    await settle(() => expect(phaseLabel(container)).toBe("ВАШ ХОД"));
    expect(persistedSave().campaign.xp).toBe(chargedXp - stated);
  });
});

/**
 * The return screen shares its outer layout with the base screen, so every base affordance is one
 * `campaign.screen !== "return"` guard away from rendering behind an unresolved defeat. That is not
 * cosmetic: repairing, healing, crafting and upgrading all write a save through `persist`, and the
 * pending XP penalty is only charged when the player confirms the return. A player who spent stash
 * metal here would be acting on the base before the defeat had been paid for.
 *
 * Addressed by accessible name, so this is a claim about what a player can reach, not about markup.
 * Craft and upgrade labels come from the shipped catalogs rather than string literals — a renamed
 * recipe must break the *control* case below instead of silently making these queries vacuous.
 */
const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BASE_ONLY_ACTIONS: ReadonlyArray<{ label: string; name: RegExp | string }> = [
  { label: "ремонт", name: /^РЕМОНТ:/ },
  { label: "медотсек", name: "МЕДОТСЕК — БИНТ ИЗ STASH" },
  { label: "выбор миссии", name: "ВЫБРАТЬ МИССИЮ" },
  /* Since W5-01/W5-02 both controls carry an `aria-label` that states the effect and the price, so
     the accessible name starts with the catalog name followed by a full stop, not by the raw label
     text. Matched on that prefix, which is what a screen-reader user actually hears. */
  ...shippedRecipes.map((recipe) => ({
    label: `крафт «${recipe.id}»`,
    name: new RegExp(`^${escapeForRegExp(recipe.name)}\\. `),
  })),
  ...shippedUpgrades.map((entry) => ({
    label: `улучшение «${entry.id}»`,
    name: new RegExp(`^${escapeForRegExp(entry.name)}\\. `),
  })),
];
const equipmentStateSections = (container: Element) => container.querySelectorAll("section.equipment-state");

describe("W4-02 the return screen offers no base actions before the defeat is resolved", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders no repair, medbay, mission-select, craft or upgrade control, and keeps both exits", async () => {
    /* Stash metal is seeded so the repair and upgrade controls would have something to spend: an
       empty stash could hide a missing guard behind a merely unaffordable action. */
    seedRawSave(buildSave(content, { screen: "return", stashMetal: 8 }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("ВОЗВРАТ");
    for (const action of BASE_ONLY_ACTIONS)
      expect(
        screen.queryAllByRole("button", { name: action.name }),
        `${action.label} must not render on the return screen`,
      ).toHaveLength(0);

    /* M3-C's single-equipment-state contract, on this screen: the base readout is gated out with
       the base actions, so nothing duplicates the combat panel's section and the count is never
       above one. */
    expect(equipmentStateSections(container)).toHaveLength(0);

    /* The screen must not become a dead end: both documented exits survive and are operable. */
    expect(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" })).toHaveProperty("disabled", false);
    /* And the penalty is still stated, so what is hidden is the base, not the consequence. */
    expect(container.querySelector("p.death-penalty")).not.toBeNull();
  });

  it("finds every one of those controls on the base screen, so the queries above are not vacuous", async () => {
    /* The control case. Without it, a renamed label would make the assertions above pass by matching
       nothing at all — the exact failure mode a negative query invites. */
    seedRawSave(buildSave(content, { screen: "home", stashMetal: 8 }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("БАЗА");
    for (const action of BASE_ONLY_ACTIONS)
      expect(
        screen.queryAllByRole("button", { name: action.name }).length,
        `${action.label} must render on the base screen`,
      ).toBeGreaterThan(0);

    /* Exactly one equipment readout once the base is live again: the guard scopes the section to a
       screen, it does not delete it. */
    expect(equipmentStateSections(container)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" })).toBeNull();
  });

  it("hides stash transfer and quick slots on terminal return and reward screens", async () => {
    for (const screenName of ["return", "reward"] as const) {
      seedRawSave(buildSave(content, { screen: screenName, stashMetal: 8 }).raw);
      const { container } = await renderApp();
      expect(phaseLabel(container)).toBe(screenName === "return" ? "ВОЗВРАТ" : "НАГРАДА");
      expect(screen.queryAllByRole("button", { name: /^metal ×8 → рюкзак$/ })).toHaveLength(0);
      expect(screen.queryAllByRole("button", { name: /^\d+: / })).toHaveLength(0);
      clearStoredSave();
    }
  });
});

describe("W1-02 combat hotkey gating through the real DOM handler", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("leaves the hero untouched when E is pressed on the base screen", async () => {
    /* Acceptance criterion 4, asserted through the shell's own listener rather than through
       `resolveCombatShortcut`. Fake timers are installed after boot so the check is a statement
       about *scheduling*, not about elapsed time. */
    seedRawSave(buildSave(content, { screen: "home" }).raw);
    const before = readRawSave();
    const { container } = await renderApp();

    vi.useFakeTimers();
    try {
      for (const key of ["e", "E", "o", "O", "1", "6"]) fireEvent.keyDown(window, { key });
      expect(vi.getTimerCount(), "a combat hotkey must not schedule an enemy transition").toBe(0);
      vi.advanceTimersByTime(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(readRawSave()).toBe(before);
    const persisted = persistedSave();
    const hero = persisted.units.find((unit) => unit.id === "hero")!;
    expect(persisted.phase).toBe("player");
    expect(persisted.turn).toBe(1);
    expect(hero.hp).toBe(24);
    expect(hero.ap).toBe(10);
    expect(phaseLabel(container)).toBe("БАЗА");
    /* No combat shell and no canvas host may appear from a keypress. */
    expect(shellElement(container).classList.contains("combat")).toBe(false);
    expect(container.querySelectorAll(".canvas-wrap")).toHaveLength(0);
  });

  it("ignores E on mission select, reward and return screens as well", async () => {
    for (const screenName of ["mission-select", "reward", "return"] as const) {
      clearStoredSave();
      stubShippedContent();
      seedRawSave(buildSave(content, { screen: screenName }).raw);
      const before = readRawSave();
      const { unmount } = await renderApp();

      vi.useFakeTimers();
      try {
        fireEvent.keyDown(window, { key: "e" });
        fireEvent.keyDown(window, { key: "o" });
        expect(vi.getTimerCount(), `screen ${screenName} must not schedule a transition`).toBe(0);
        vi.advanceTimersByTime(60_000);
      } finally {
        vi.useRealTimers();
      }

      expect(readRawSave(), `screen ${screenName} must ignore combat hotkeys`).toBe(before);
      unmount();
    }
  });

  it("still ends the turn when E is pressed during an active encounter", async () => {
    /* The control case: without it, the gating tests above could pass because the listener was
       never attached at all. Symmetry matters — the same instrumentation that shows *zero*
       scheduled transitions on home shows one here. */
    seedRawSave(buildSave(content, { screen: "mission" }).raw);
    const { container } = await renderApp();

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, { key: "e" });

      expect(phaseLabel(container)).toBe("ПРОТИВНИК");
      /* The enemy snapshot is written synchronously, before the resolution timer is scheduled. */
      expect(persistedSave().phase).toBe("enemy");
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      /* The shell resolves the enemy phase on a 300 ms timer and hands the turn back. */
      vi.advanceTimersByTime(300);

      const persisted = persistedSave();
      expect(persisted.phase).toBe("player");
      expect(persisted.turn).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("W1-02 encounters beyond the first", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders every catalog encounter from its own arena", async () => {
    /* Guards against a shell that always renders the first arena regardless of the active
       encounter — the failure mode a single-encounter test cannot see. */
    for (const encounter of encounters.slice(1)) {
      clearStoredSave();
      stubShippedContent();
      seedRawSave(buildSave(content, { screen: "mission", encounterId: encounter.id }).raw);
      const { container, unmount } = await renderApp();

      expect(shellElement(container).classList.contains("combat")).toBe(true);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(encounter.name);
      expect(persistedSave().arenaId).toBe(encounter.arenaId);
      unmount();
    }
  });
});
