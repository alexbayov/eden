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
import { buildSave, loadShippedContent, orderedEncounters } from "../test/campaign-save-fixtures";

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [first] = encounters;

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
