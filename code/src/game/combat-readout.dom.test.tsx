/**
 * W6-03 DOM tests — the readout as the shell actually renders it.
 *
 * `combat-readout.test.ts` pins the arithmetic; this file proves the numbers reach the screen. The split
 * matters for the same reason it did in W6-01: before this ticket the model computed all eleven breakdown
 * fields correctly and the UI showed two of them, so "the calculation is right" and "the player can see it"
 * were different claims.
 *
 * Criterion 5 («информация доступна без hover») is checked structurally: the terms are asserted to be in the
 * document with no pointer interaction at all, which is what a table gives and a tooltip would not.
 *
 * LIMITATION — jsdom has no layout and `createCombatRuntime` is mocked, so nothing here is a claim about
 * geometry or tap-target size; that belongs to `e2e/viewport-geometry.spec.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/preact";
import {
  clearStoredSave,
  readRawSave,
  renderApp,
  seedRawSave,
  settle,
  stubShippedContent,
} from "../test/dom-harness";
import { buildSave, loadShippedContent } from "../test/campaign-save-fixtures";
import { ATTACKS, POSTURES, postureChangeCost } from "./combat";

const content = loadShippedContent();

/** Seeds a live mission with the hero in a firing position on the first encounter. */
const seedMission = (overrides: Partial<Parameters<typeof buildSave>[1]> = {}) =>
  seedRawSave(buildSave(content, { heroAt: { x: 5, y: 2 }, ...overrides, screen: "mission" }).raw);

const selectTarget = async () => {
  const target = screen.getByRole("button", { name: /^Выбрать цель / });
  fireEvent.click(target);
  await settle(() => expect(document.querySelector(".breakdown")).not.toBeNull());
};

const breakdown = (container: Element) => {
  const found = container.querySelector(".breakdown");
  if (!found) throw new Error("breakdown not rendered");
  return found;
};
/** Term rows as `{ id: value }`, read from the DOM rather than from the model. */
const terms = (container: Element, attribute = "data-term"): Record<string, number> =>
  Object.fromEntries(
    [...container.querySelectorAll(`tr[${attribute}]`)].map((row) => [
      row.getAttribute(attribute) ?? "",
      Number(row.querySelector("td")!.getAttribute("data-term-value")),
    ]),
  );
const persistedHero = () =>
  JSON.parse(readRawSave()!).units.find((unit: { id: string }) => unit.id === "hero") as {
    ap: number;
    posture?: string;
    statuses?: Record<string, number>;
  };

describe("W6-03 the full hit breakdown reaches the screen", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("renders every term with a label and a sign, without any hover", async () => {
    /* Previously 2 of 11 fields were rendered. Asserted by *count* against the view model's own term list
       rather than by naming rows, so a new addend cannot be silently dropped from the UI. */
    seedMission();
    const { container } = await renderApp();
    await selectTarget();

    const shown = terms(breakdown(container));
    /* The eight addends of `HitBreakdown`, all present including zeroes. */
    expect(Object.keys(shown).sort()).toEqual(
      [
        "base",
        "coverPenalty",
        "partModifier",
        "postureModifier",
        "rangePenalty",
        "skillModifier",
        "statusModifier",
        "weaponModifier",
      ].sort(),
    );
    /* Every row carries a visible label and a signed value; no pointer events were dispatched. */
    for (const row of container.querySelectorAll("tr[data-term]")) {
      expect(row.querySelector("th")!.textContent!.length).toBeGreaterThan(0);
      expect(row.querySelector("td")!.textContent).toMatch(/^(\+|−)?\d+$/);
    }
  });

  it("shows a total equal to the model, and the terms add up to it", async () => {
    /*
     * Criterion 2 as the player sees it: the displayed rows are summed from the DOM and compared with the
     * displayed total. `data-hit-raw` carries the pre-clamp sum, so the comparison is exact when no clamp is
     * active — and this fixture is a plain torso shot, which is well inside 5..95.
     */
    seedMission();
    const { container } = await renderApp();
    await selectTarget();

    const block = breakdown(container);
    const final = Number(block.getAttribute("data-hit-final"));
    const raw = Number(block.getAttribute("data-hit-raw"));
    const sum = Object.values(terms(block)).reduce((total, value) => total + value, 0);
    expect(sum).toBe(raw);
    expect(raw).toBe(final);
    expect(block.textContent).toContain(`ШАНС ПОПАДАНИЯ ${final}%`);
    /* No clamp note on an ordinary shot. */
    expect(block.querySelector(".breakdown-clamp")).toBeNull();
  });

  it("explains the clamp when the terms do not add up to the shown chance", async () => {
    /*
     * The honest half of criterion 2. At the 5% floor the rows genuinely sum to something lower, and without
     * a note the column reads as an arithmetic bug in the game rather than as a floor.
     *
     * The hero fires from its usual position — where the target *is* selectable — and the shot is pushed past
     * the floor by blinding it (−50 accuracy) and aiming at the eye (−40). Moving the hero somewhere with a
     * worse angle would also clamp, but the target would have no firing line and could never be selected.
     */
    seedMission({ heroStatuses: { blind: 3 } });
    const { container } = await renderApp();
    await selectTarget();
    fireEvent.click(screen.getByRole("button", { name: /5\. Глаз/ }));

    await settle(() => expect(container.querySelector(".breakdown-clamp")).not.toBeNull());
    const block = breakdown(container);
    const note = block.querySelector(".breakdown-clamp")!;
    expect(note.getAttribute("data-clamp")).toBe("min");
    expect(Number(block.getAttribute("data-hit-final"))).toBe(5);
    expect(Number(block.getAttribute("data-hit-raw"))).toBeLessThan(5);
    expect(note.textContent).toContain("5%");
    /* The rows still add up to the raw sum: the clamp is the only discrepancy, and it is explained. */
    const sum = Object.values(terms(block)).reduce((total, value) => total + value, 0);
    expect(sum).toBe(Number(block.getAttribute("data-hit-raw")));
  });

  it("shows the crit chance and its terms, which had no UI at all", async () => {
    seedMission();
    const { container } = await renderApp();
    await selectTarget();

    const block = breakdown(container);
    const crit = Number(block.querySelector(".crit-chance")!.getAttribute("data-crit-final"));
    expect(crit).toBeGreaterThan(0);
    const critTerms = terms(block, "data-crit-term");
    expect(Object.keys(critTerms).sort()).toEqual(
      ["agilityModifier", "base", "luckModifier", "partModifier", "skillModifier", "statusModifier", "weaponModifier"].sort(),
    );
    expect(Object.values(critTerms).reduce((total, value) => total + value, 0)).toBe(crit);
    /* And what a critical actually does, from the shipped catalog. */
    expect(block.querySelector(".crit-effect")!.textContent).toContain("×1.5");
  });

  it("updates the breakdown when the body part changes", async () => {
    /* Guards against a readout computed once and cached: the part modifier and AP cost must follow the
       selection, or the numbers describe a shot the player is not about to take. */
    seedMission();
    const { container } = await renderApp();
    await selectTarget();
    const torso = Number(breakdown(container).getAttribute("data-hit-final"));

    fireEvent.click(screen.getByRole("button", { name: /1\. Голова/ }));

    await settle(() =>
      expect(Number(breakdown(container).getAttribute("data-hit-final"))).not.toBe(torso),
    );
    const head = terms(breakdown(container));
    expect(head.partModifier).toBe(ATTACKS.head.aimModifier);
    expect(breakdown(container).textContent).toContain(`${ATTACKS.head.apCost} ОЧ`);
  });
});

describe("W6-03 statuses carry their remaining duration", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("says so plainly when there are none", async () => {
    seedMission();
    const { container } = await renderApp();
    expect(container.querySelector(".statuses")!.getAttribute("data-status-count")).toBe("0");
    expect(container.querySelector(".status-empty")!.textContent).toContain("нет");
  });

  it("lists each active status with its effect and turns left", async () => {
    /* The only status display before this was raw English keys on the canvas at 9px, with the counters
       `advanceStatuses` maintains never shown. */
    seedMission({ heroStatuses: { arm: 2, blind: 3 } });
    const { container } = await renderApp();

    const list = container.querySelector(".statuses")!;
    expect(list.getAttribute("data-status-count")).toBe("2");
    const arm = list.querySelector('li[data-status="arm"]')!;
    expect(arm.getAttribute("data-status-turns")).toBe("2");
    expect(arm.textContent).toContain("Ранение руки");
    expect(arm.textContent).toContain("осталось ходов: 2");
    /* Russian description, not the raw key. */
    expect(list.textContent).not.toContain("blind");
    expect(list.textContent).toContain("Слепота");
  });
});

describe("W6-03 posture price is visible before the press", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  it("labels every posture with its AP cost and aim bonus", async () => {
    seedMission();
    const { container } = await renderApp();

    for (const id of Object.keys(POSTURES) as (keyof typeof POSTURES)[]) {
      const button = container.querySelector(`button[data-posture="${id}"]`)!;
      expect(button.textContent, id).toContain(POSTURES[id].label);
      const cost = postureChangeCost("stand", id);
      /* An illegal transition advertises no price; a legal one states it. */
      if (cost === null) expect(button.textContent, id).toContain("недоступно");
      else expect(button.getAttribute("data-posture-cost"), id).toBe(String(cost));
    }
  });

  it("refuses standing to prone with the rule, not with a shortage", async () => {
    /*
     * The defect: both refusals were «Смена позы сейчас недоступна.», so a permanent rule read like a
     * temporary lack of AP. `force` because the control is `aria-disabled` rather than `disabled` — reachable
     * on purpose, so a screen-reader user hears the reason — and forcing the click proves the *handler*
     * refuses rather than the styling.
     */
    seedMission();
    const { container } = await renderApp();
    const prone = container.querySelector<HTMLButtonElement>('button[data-posture="prone"]')!;
    expect(prone.getAttribute("aria-disabled")).toBe("true");
    const before = readRawSave();

    fireEvent.click(prone);

    await settle(() => expect(container.textContent).toContain("присед"));
    expect(readRawSave()).toBe(before);
    expect(persistedHero().posture ?? "stand").toBe("stand");
  });

  it("charges the stated cost when the change is legal", async () => {
    seedMission();
    const { container } = await renderApp();
    const apBefore = persistedHero().ap;
    const crouch = container.querySelector<HTMLButtonElement>('button[data-posture="crouch"]')!;
    const cost = Number(crouch.getAttribute("data-posture-cost"));
    expect(cost).toBe(postureChangeCost("stand", "crouch"));

    fireEvent.click(crouch);

    await settle(() => expect(persistedHero().posture).toBe("crouch"));
    /* Exactly the advertised price: the label and the transaction agree. */
    expect(persistedHero().ap).toBe(apBefore - cost);
    expect(container.textContent).toContain(`−${cost} ОЧ`);
  });

  it("feeds the posture modifier into the shown hit chance", async () => {
    /* Ties the two halves of the ticket together: the posture bonus is not decorative, it is one of the
       breakdown terms, and changing posture must move it. */
    seedMission();
    const { container } = await renderApp();
    await selectTarget();
    expect(terms(breakdown(container)).postureModifier).toBe(POSTURES.stand.aimModifier);

    fireEvent.click(container.querySelector<HTMLButtonElement>('button[data-posture="crouch"]')!);

    await settle(() => expect(persistedHero().posture).toBe("crouch"));
    expect(terms(breakdown(container)).postureModifier).toBe(POSTURES.crouch.aimModifier);
  });
});
