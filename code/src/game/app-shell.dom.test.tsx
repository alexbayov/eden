/**
 * W1-02 — DOM tests for the campaign side of the app shell: loading, recovery, base and mission
 * select. The combat side lives in `combat-shell.dom.test.tsx`; splitting the two lets Vitest run
 * them in parallel workers, which is what keeps the jsdom project's contribution to `npm test`
 * down.
 *
 * These are the first tests in this repository that render the actual Preact shell. Everything
 * before W1-02 was either a pure view-model test (`boot-view.test.ts`, `combat-view.test.ts`) or a
 * source-text assertion (`responsive-css.test.ts`). What jsdom adds is that the *rendered DOM* and
 * the *real event handlers* are exercised: `selectBootView` returning `loading` and the shell
 * actually rendering a loading screen without dereferencing a null campaign are two different
 * claims, and only the second is checked here.
 *
 * Queries go through accessible role + name, never a CSS class, per acceptance criterion 1. The
 * two exceptions — `shellElement` and `phaseLabel` — are helpers in `dom-harness.ts` that assert
 * *which screen is mounted*, not the content of a control, and the shell gives those containers
 * no accessible name.
 *
 * LIMITATION — jsdom has no layout engine and no canvas. Nothing here may be read as a claim about
 * geometry, touch-target size, or the Phaser canvas. Those live in `e2e/viewport-geometry.spec.ts`
 * (W1-05) and `e2e/smoke.spec.ts` (W1-01).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/preact";
import {
  clearStoredSave,
  persistedSave,
  phaseLabel,
  readBackup,
  readRawSave,
  renderApp,
  renderBootingApp,
  seedRawSave,
  settle,
  shellElement,
  stubShippedContent,
} from "../test/dom-harness";
import { buildSave, loadShippedContent, orderedEncounters } from "../test/campaign-save-fixtures";

const content = loadShippedContent();
const encounters = orderedEncounters(content);
const [first] = encounters;

describe("W1-02 loading screen", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders a loading screen before catalogs resolve, without dereferencing a null campaign", () => {
    /* Acceptance criterion 2: proven by rendering, not by calling `selectBootView`. If the shell
       touched `campaign` before boot completed, this render would throw instead of asserting. */
    const { container } = renderBootingApp();
    const loading = container.querySelector("main.game-shell.loading");
    expect(loading).not.toBeNull();
    expect(loading!.getAttribute("data-boot-phase")).toBe("loading");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Загрузка убежища…");
    /* A polite live region, so a screen reader announces boot progress. */
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    /* No campaign affordance may exist yet. */
    expect(screen.queryByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeNull();
  });

  it("replaces the loading screen with the base screen once boot finishes", async () => {
    const { container } = await renderApp();
    expect(container.querySelector("main.game-shell.loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Бункер у периметра" })).toBeTruthy();
  });
});

describe("W1-02 recovery screen", () => {
  beforeEach(() => {
    clearStoredSave();
  });

  it("shows save recovery for a malformed payload and keeps the original in a backup", async () => {
    stubShippedContent();
    const corrupt = "{ not valid json";
    seedRawSave(corrupt);
    const { container } = await renderApp();

    expect(shellElement(container).classList.contains("recovery")).toBe(true);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Сохранение не загружено");
    /* Non-destructive recovery: the corrupt payload survives and is copied, not deleted. */
    expect(readRawSave()).toBe(corrupt);
    expect(readBackup()).toBe(corrupt);
    /* Reset is offered but explicit, and no playable screen renders behind it. */
    expect(screen.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeNull();
  });

  it("recovers into a playable base screen after an explicit reset", async () => {
    stubShippedContent();
    seedRawSave(JSON.stringify({ schemaVersion: 99, arenaId: first.arenaId }));
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" }));

    await settle(() => expect(screen.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeTruthy());
    expect(persistedSave().campaign.screen).toBe("home");
  });

  it("shows content recovery, with no reset offered, when the catalog itself is invalid", async () => {
    /* An encounter pointing at a non-existent arena: the cross-reference validator must stop boot
       before any progression starts. Resetting the save cannot fix broken content, so the shell
       must not offer that button here. */
    stubShippedContent({
      "missions.json": {
        contentVersion: 1,
        kind: "missions",
        entries: [
          {
            id: "ghost-encounter",
            zoneId: first.zoneId,
            order: 1,
            name: "Фантом",
            description: "Ссылается на несуществующую карту.",
            objective: "eliminate",
            arenaId: "no-such-arena",
            difficulty: 0,
            rewardId: first.rewardId,
          },
        ],
      },
    });
    const { container } = await renderApp();

    expect(shellElement(container).classList.contains("recovery")).toBe(true);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Контент кампании не загружен");
    expect(screen.queryByRole("button", { name: "ЯВНО СБРОСИТЬ И НАЧАТЬ ЗАНОВО" })).toBeNull();
    expect(container.textContent).toContain("Прогрессия не запускалась");
  });
});

describe("W1-02 base screen", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders hero state, stash and the mission-select entry point", async () => {
    seedRawSave(buildSave(content, { screen: "home", stashMetal: 4 }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("БАЗА");
    expect(screen.getByRole("heading", { name: "Бункер у периметра" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Снаряжение вылазки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "МЕДОТСЕК — БИНТ ИЗ STASH" })).toBeTruthy();
    /* Hero HP and stash contents come from the save, not from placeholder text. */
    expect(container.textContent).toContain("24/24");
    expect(container.textContent).toContain("металл 4");
    /* The base screen is not the combat shell. */
    expect(shellElement(container).classList.contains("combat")).toBe(false);
  });

  it("switches to mission select and persists that screen", async () => {
    seedRawSave(buildSave(content, { screen: "home" }).raw);
    const { container } = await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "ВЫБРАТЬ МИССИЮ" }));

    await settle(() => expect(phaseLabel(container)).toBe("МИССИЯ"));
    expect(screen.getByRole("button", { name: "НАЗАД НА БАЗУ" })).toBeTruthy();
    expect(persistedSave().campaign.screen).toBe("mission-select");
  });
});

describe("W1-02 mission select screen", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("lists every catalog encounter with its unlock state", async () => {
    seedRawSave(buildSave(content, { screen: "mission-select" }).raw);
    await renderApp();

    /* One card heading per encounter, taken from the shipped catalog rather than hardcoded. Level
       3 specifically: the active encounter's name is also the page's h1, so an unqualified name
       query would match twice for the first entry. */
    for (const encounter of encounters)
      expect(screen.getByRole("heading", { level: 3, name: encounter.name })).toBeTruthy();

    expect(screen.getByRole("button", { name: "НАЧАТЬ" })).toHaveProperty("disabled", false);
    /* Every later encounter stays locked on a fresh save. */
    const locked = screen.getAllByRole("button", { name: "ЗАБЛОКИРОВАНО" });
    expect(locked).toHaveLength(encounters.length - 1);
    for (const button of locked) expect(button).toHaveProperty("disabled", true);
  });

  it("starts the selected encounter and mounts the combat shell", async () => {
    seedRawSave(buildSave(content, { screen: "mission-select" }).raw);
    const { container } = await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "НАЧАТЬ" }));

    await settle(() => expect(shellElement(container).classList.contains("combat")).toBe(true));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(first.name);
    expect(persistedSave().campaign.screen).toBe("mission");
  });

  it("offers a retry button instead of a start button for a failed encounter", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission-select",
        encounters: { [first.id]: { status: "failed" } },
      }).raw,
    );
    await renderApp();

    expect(screen.getByRole("button", { name: "ПОВТОРИТЬ" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "НАЧАТЬ" })).toBeNull();
  });
});
