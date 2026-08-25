/**
 * W6-01 DOM tests — the objective runtime driven through the real Preact shell.
 *
 * `objective.test.ts` pins the rules; this file proves the shell wires them to a rendered panel, an
 * action and one atomic save. The difference matters for exactly the reason W6-01 exists: the old code
 * had a correct-looking `objective` field in `missions.json` that nothing read, so "the rule is
 * implemented" and "the game plays by the rule" were different claims.
 *
 * `retrieve` and `escape` have **no shipped missions** — the MVP zone is two `eliminate` encounters and
 * one `secure`. Rather than adding content the design has not asked for, those two types are exercised
 * by overriding `missions.json` through the harness, which is the same path the shell's own loader
 * takes. That keeps the objective *runtime* fully covered while leaving content decisions to W7.
 *
 * LIMITATION — jsdom has no layout and no canvas, and `createCombatRuntime` is mocked. Nothing here is
 * a claim about geometry; that belongs to `e2e/viewport-geometry.spec.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/preact";
import {
  clearStoredSave,
  readRawSave,
  renderApp,
  seedRawSave,
  settle,
  shippedConfig,
  stubShippedContent,
} from "../test/dom-harness";
import { buildSave, loadShippedContent } from "../test/campaign-save-fixtures";
import type { ObjectiveParams } from "./objective";

const content = loadShippedContent();
const relay = content.missions.find((mission) => mission.id === "relay-station")!;
const holdTurns = relay.objectiveParams.kind === "secure" ? relay.objectiveParams.holdTurns : 0;

/** The persisted objective block, which is the only state the board cannot reproduce. */
const persistedObjective = () => {
  const raw = readRawSave();
  if (raw === null) throw new Error("no save persisted");
  return JSON.parse(raw).objective as { heldTurns: number; carrying: boolean };
};
const persistedPhase = () => JSON.parse(readRawSave()!).phase as string;
const persistedScreen = () => JSON.parse(readRawSave()!).campaign.screen as string;

/**
 * The end-turn control and a movement cell, addressed the way the shell actually labels them.
 *
 * Cell labels are **1-based** (`Клетка 7,6` is the cell at `x: 6, y: 5`), so the conversion lives here
 * once rather than in every call site where an off-by-one would look like a missing button.
 */
const endTurn = () => screen.getByRole("button", { name: /ЗАКОНЧИТЬ ХОД/ });
/**
 * Clicks a movement cell, expanding the list first.
 *
 * The panel shows only the top-ranked cells by default (progressive disclosure, W1-02), so an
 * arbitrary reachable cell is not in the DOM until «Показать ещё» is pressed. Expanding
 * unconditionally keeps a spec from passing or failing on where its target happened to rank.
 */
const moveTo = async (x: number, y: number) => {
  const expand = screen.queryByRole("button", { name: /Показать ещё/ });
  if (expand) {
    fireEvent.click(expand);
    await settle(() => expect(screen.queryByRole("button", { name: /Показать ещё/ })).toBeNull());
  }
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`Переместиться в клетка ${x + 1},${y + 1}:`) }));
};

const panel = (container: Element) => {
  const found = container.querySelector(".objective-panel");
  if (!found) throw new Error("objective panel not rendered");
  return found;
};
const done = (container: Element) => Number(panel(container).getAttribute("data-objective-done"));

/**
 * Replaces one shipped mission's objective, keeping everything else.
 *
 * Used only for `retrieve`/`escape`, which have no shipped encounter. The catalog still goes through the
 * real validator — including the arena bounds check — so a fixture cannot describe a mission the game
 * would refuse to load.
 */
const withObjective = (missionId: string, objective: string, objectiveParams: unknown, turnLimit?: number) => {
  const missions = shippedConfig("missions.json") as { entries: Record<string, unknown>[] };
  return {
    "missions.json": {
      ...missions,
      entries: missions.entries.map((entry) =>
        entry.id === missionId
          ? { ...entry, objective, objectiveParams, ...(turnLimit === undefined ? {} : { turnLimit }) }
          : entry,
      ),
    },
  };
};

/** A content bundle whose first encounter carries `params`, for the fixture builder to read. */
const contentWith = (params: ObjectiveParams, turnLimit?: number) => {
  const overrides = withObjective(
    "perimeter-checkpoint",
    params.kind,
    Object.fromEntries(Object.entries(params).filter(([key]) => key !== "kind")),
    turnLimit,
  );
  stubShippedContent(overrides);
  return { overrides, content: loadShippedContent(overrides as Record<string, unknown>) };
};

describe("W6-01 secure: the shipped hold objective", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders the objective and its progress every turn", async () => {
    seedRawSave(buildSave(content, { screen: "mission", encounterId: "relay-station", heroAt: { x: 5, y: 3 } }).raw);
    const { container } = await renderApp();

    const objective = panel(container);
    expect(objective.getAttribute("data-objective")).toBe("secure");
    expect(objective.getAttribute("data-objective-total")).toBe(String(holdTurns));
    expect(objective.getAttribute("data-objective-done")).toBe("0");
    /* The label states what to do and how far along it is, without hover (doc 14). */
    expect(objective.textContent).toContain("Удерживать точку");
    expect(objective.textContent).toContain(`0/${holdTurns}`);
  });

  it("does not complete on a cleared board, which is the whole point of the ticket", async () => {
    /*
     * `relay-station` used to end the moment the last enemy died, making `secure` a label. Here every
     * enemy starts dead and the mission is still running.
     */
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        encounterId: "relay-station",
        heroAt: { x: 5, y: 3 },
        enemyHp: { "relay-defender": 0, "relay-shooter": 0 },
      }).raw,
    );
    const { container } = await renderApp();

    expect(persistedScreen()).toBe("mission");
    expect(persistedPhase()).toBe("player");
    expect(panel(container).getAttribute("data-objective-done")).toBe("0");
  });

  it("counts one held turn per ended turn and completes at the threshold", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        encounterId: "relay-station",
        heroAt: { x: 5, y: 3 },
        enemyHp: { "relay-defender": 0, "relay-shooter": 0 },
      }).raw,
    );
    const { container } = await renderApp();

    /*
     * One increment per turn boundary — the property that broke first: counting the hold inside the
     * evaluator advanced it twice per turn, finishing a two-turn hold in 1.3 turns.
     *
     * The loop stops one turn short because the final boundary both reaches the threshold *and* ends the
     * mission, which resets the persisted progress. Waiting for `heldTurns === holdTurns` after that turn
     * would wait forever for a value the completion has already cleared.
     */
    for (let turn = 0; turn < holdTurns - 1; turn += 1) {
      expect(done(container), `hold count before turn ${turn + 1}`).toBe(turn);
      fireEvent.click(endTurn());
      await settle(() => expect(persistedObjective().heldTurns).toBe(turn + 1));
      expect(persistedScreen(), `mission still running after ${turn + 1} of ${holdTurns} turns`).toBe("mission");
    }

    /* The last held turn completes it. */
    expect(done(container)).toBe(holdTurns - 1);
    fireEvent.click(endTurn());

    await settle(() => expect(persistedScreen()).toBe("reward"));
    expect(persistedPhase()).toBe("victory");
    /* Progress is reset once the mission is over, so the next encounter cannot inherit it. */
    expect(persistedObjective()).toEqual({ heldTurns: 0, carrying: false });
  });

  it("resets the hold when the hero leaves the zone", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        encounterId: "relay-station",
        heroAt: { x: 5, y: 3 },
        enemyHp: { "relay-defender": 0, "relay-shooter": 0 },
        objective: { heldTurns: 1 },
      }).raw,
    );
    const { container } = await renderApp();
    expect(done(container)).toBe(1);

    /* Step out of the zone, then end the turn: the count drops rather than pausing, because
       "consecutive" is the rule. The cell is two steps away, outside radius 1 of (5,3). */
    await moveTo(3, 5);
    await settle(() => expect(readRawSave()).not.toBeNull());
    fireEvent.click(endTurn());

    await settle(() => expect(persistedObjective().heldTurns).toBe(0));
    expect(persistedScreen()).toBe("mission");
  });

  it("does not count a turn while a living enemy contests the zone", async () => {
    /* Without the contested rule, `secure` degenerates into "stand still while being shot" and the
       guards could be ignored entirely. `relay-shooter` starts at (5,4), inside radius 1 of (5,3). */
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        encounterId: "relay-station",
        heroAt: { x: 5, y: 3 },
        enemyHp: { "relay-defender": 0 },
      }).raw,
    );
    const { container } = await renderApp();
    expect(done(container)).toBe(0);

    fireEvent.click(endTurn());

    await settle(() => expect(JSON.parse(readRawSave()!).turn).toBeGreaterThan(1));
    expect(persistedObjective().heldTurns).toBe(0);
    expect(persistedScreen()).toBe("mission");
  });
});

describe("W6-01 escape: reaching the exit", () => {
  const exit = { x: 6, y: 5 };
  const params: ObjectiveParams = { kind: "escape", exit };

  beforeEach(() => clearStoredSave());

  it("completes by standing on the exit, with enemies still alive", async () => {
    /* The condition an `eliminate`-shaped win check cannot express: the mission ends with a living
       enemy on the board, because leaving *is* the objective. */
    const bundle = contentWith(params, 12);
    seedRawSave(buildSave(bundle.content, { screen: "mission", heroAt: { x: 6, y: 4 } }).raw);
    const { container } = await renderApp();

    const objective = panel(container);
    expect(objective.getAttribute("data-objective")).toBe("escape");
    expect(objective.textContent).toContain("точки выхода");
    /* The deadline is visible, because a timed objective the player cannot see the clock on is a trap. */
    expect(objective.textContent).toContain("ходов осталось");

    await moveTo(exit.x, exit.y);

    await settle(() => expect(persistedScreen()).toBe("reward"));
    expect(persistedPhase()).toBe("victory");
    /* The enemy is untouched: nothing was killed to win this. */
    const enemyHp = JSON.parse(readRawSave()!).units.find((unit: { id: string }) => unit.id === "checkpoint-shooter").hp;
    expect(enemyHp).toBeGreaterThan(0);
  });

  it("fails as its own outcome when the deadline passes with the hero alive", async () => {
    /*
     * W6-01 criterion 4. The encounter is `failed` and retryable exactly like a defeat, but nothing was
     * lost in combat — the hero is at full HP. The message has to say which of the two happened.
     */
    const bundle = contentWith(params, 1);
    seedRawSave(buildSave(bundle.content, { screen: "mission", heroAt: { x: 1, y: 4 }, turn: 1 }).raw);
    const { container } = await renderApp();

    fireEvent.click(endTurn());

    await settle(() => expect(persistedScreen()).toBe("return"));
    expect(persistedPhase()).toBe("defeat");
    const hero = JSON.parse(readRawSave()!).units.find((unit: { id: string }) => unit.id === "hero");
    expect(hero.hp).toBe(hero.maxHp);
    expect(container.textContent).toContain("Цель провалена");
    /* Retryable, like any failed encounter. */
    const encounters = JSON.parse(readRawSave()!).campaign.encounters as { id: string; status: string }[];
    expect(encounters.find((entry) => entry.id === "perimeter-checkpoint")?.status).toBe("failed");
  });
});

describe("W6-01 retrieve: cargo then exit", () => {
  const at = { x: 4, y: 4 };
  const exit = { x: 1, y: 4 };
  const params: ObjectiveParams = { kind: "retrieve", itemId: "relay-core", at, exit };

  beforeEach(() => clearStoredSave());

  it("requires the cargo before the exit counts", async () => {
    const bundle = contentWith(params, 20);
    /* The hero starts *on* the exit without the cargo: an exit-only rule would end the mission here. */
    seedRawSave(buildSave(bundle.content, { screen: "mission", heroAt: exit }).raw);
    const { container } = await renderApp();

    expect(persistedScreen()).toBe("mission");
    const objective = panel(container);
    expect(objective.getAttribute("data-objective")).toBe("retrieve");
    expect(objective.textContent).toContain("Забрать груз");
    /* The pickup control is reachable but unavailable, and says why. */
    const take = container.querySelector("button[data-objective-take]")!;
    expect(take.getAttribute("aria-disabled")).toBe("true");
    expect(take.textContent).toContain("подойдите");
  });

  it("takes the cargo on its cell and then completes at the exit", async () => {
    const bundle = contentWith(params, 20);
    seedRawSave(buildSave(bundle.content, { screen: "mission", heroAt: at }).raw);
    const { container } = await renderApp();

    const take = container.querySelector<HTMLButtonElement>("button[data-objective-take]")!;
    expect(take.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(take);

    await settle(() => expect(persistedObjective().carrying).toBe(true));
    /* Still running: the cargo is not the mission, delivering it is. */
    expect(persistedScreen()).toBe("mission");
    expect(panel(container).textContent).toContain("выходу");

    await moveTo(exit.x, exit.y);

    await settle(() => expect(persistedScreen()).toBe("reward"));
    expect(persistedPhase()).toBe("victory");
  });

  it("refuses a pickup away from the cargo cell without changing anything", async () => {
    const bundle = contentWith(params, 20);
    seedRawSave(buildSave(bundle.content, { screen: "mission", heroAt: { x: 1, y: 4 } }).raw);
    const { container } = await renderApp();
    const before = readRawSave();

    /* Forced because the control is `aria-disabled` rather than `disabled` — deliberately reachable so a
       screen-reader user hears why. Forcing it is what proves the *handler* refuses. */
    fireEvent.click(container.querySelector<HTMLButtonElement>("button[data-objective-take]")!);

    await settle(() => expect(container.textContent).toContain("стоя на его клетке"));
    expect(readRawSave()).toBe(before);
    expect(persistedObjective().carrying).toBe(false);
  });
});
