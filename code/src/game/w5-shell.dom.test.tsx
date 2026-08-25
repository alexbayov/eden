/**
 * W5 DOM tests — the three shipped W5 flows driven through the real app shell.
 *
 * Everything here goes through the rendered DOM and the real save adapter: a control is found by its
 * accessible name, clicked, and the *persisted payload* is then read back. That is the difference
 * between these and `w5-ui.test.ts`: the pure tests pin the rules, and these prove the shell actually
 * wires them to a button, an announcement and one atomic save.
 *
 * Numbers come from the shipped catalogs (`item-effects.json`, `return-tables.json`, `items.json`),
 * never restated here, so a content edit exercises these instead of quietly invalidating them.
 *
 * LIMITATION — jsdom has no layout and no canvas, and `createCombatRuntime` is mocked in
 * `dom-harness.ts`. Nothing below is a claim about geometry or touch-target size; those belong to
 * `e2e/viewport-geometry.spec.ts`. What *is* asserted here about accessibility is semantic: the
 * accessible name of every control, `aria-disabled` instead of `disabled` on unavailable-but-
 * reachable actions, the live regions, and the keyboard path.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/preact";
import {
  clearStoredSave,
  persistedSave,
  phaseLabel,
  readRawSave,
  renderApp,
  seedRawSave,
  settle,
  stubShippedContent,
} from "../test/dom-harness";
import { buildSave, loadShippedContent } from "../test/campaign-save-fixtures";
import { effectForItem } from "./consumables";
import { returnsFor } from "./dismantle";
import { PROPOSED_BACKPACK_LOSS_POLICY } from "./death-loss";
import { RESOURCE_LABELS, type ResourceId } from "./inventory";

const content = loadShippedContent();
const bandage = effectForItem(content.itemEffects, "field-bandage")!;
const bandageHeal = (bandage.effect as { kind: "heal"; amount: number }).amount;
const itemName = (id: string) => content.items.find((item) => item.id === id)?.name ?? id;

/** Persisted inventory, narrowed to what these specs read. */
const persistedInventory = () => {
  const raw = readRawSave();
  if (raw === null) throw new Error("no save persisted");
  return JSON.parse(raw).inventory as {
    quickSlots: (string | null)[];
    backpack: { resources: { id: string; quantity: number }[]; items: { id: string; quantity: number }[] };
    stash: { resources: { id: string; quantity: number }[]; items: { id: string; quantity: number }[] };
    equipment: { instanceId: string; itemId: string }[];
  };
};
const persistedHero = () => {
  const raw = readRawSave();
  if (raw === null) throw new Error("no save persisted");
  return JSON.parse(raw).units.find((unit: { id: string }) => unit.id === "hero") as {
    hp: number;
    ap: number;
    weaponState?: { reserveAmmo: number; durability: number; weaponInstanceId: string };
    armor?: { durability: number; armorInstanceId: string };
  };
};
const quantityOf = (stacks: { id: string; quantity: number }[], id: string) =>
  stacks.find((stack) => stack.id === id)?.quantity ?? 0;

/** The quick-slot button for a 1-based slot number, addressed structurally then checked by name. */
const slotButton = (container: Element, slotNumber: number) => {
  const button = container.querySelector<HTMLButtonElement>(`button[data-quick-slot="${slotNumber}"]`);
  if (!button) throw new Error(`no quick slot button ${slotNumber}`);
  return button;
};

describe("W5-03 quick slot consumable in combat", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  /** A wounded hero in an active encounter, carrying two bandages with slot 1 assigned. */
  const woundedWithBandages = (quantity = 2) =>
    buildSave(content, {
      screen: "mission",
      heroHp: 12,
      backpackItems: [{ id: "field-bandage", quantity }],
      quickSlots: { 0: "field-bandage" },
    }).raw;

  it("renders all four slots with the content price, and marks empty ones as reachable-but-unavailable", async () => {
    seedRawSave(woundedWithBandages());
    const { container } = await renderApp();

    expect(screen.getByRole("group", { name: "Быстрые слоты" })).toBeTruthy();
    const filled = slotButton(container, 1);
    /* The accessible name states what it is, what it does, what it costs and the shortcut. */
    expect(filled.getAttribute("aria-label")).toContain(itemName("field-bandage"));
    expect(filled.getAttribute("aria-label")).toContain(`${bandageHeal} HP`);
    expect(filled.getAttribute("aria-label")).toContain(`${bandage.apCost} ОЧ`);
    expect(filled.getAttribute("aria-label")).toContain("Shift+1");
    expect(filled.getAttribute("aria-label")).toContain("Доступно");
    expect(filled.getAttribute("aria-disabled")).toBe("false");

    /* The other three render too: the bar is the carried-loot readout, not just a set of actions. */
    for (const slotNumber of [2, 3, 4]) {
      const empty = slotButton(container, slotNumber);
      expect(empty.getAttribute("data-blocked")).toBe("empty-slot");
      /*
       * `aria-disabled`, never `disabled`. A `disabled` button leaves the tab order and stops
       * reporting its label, so a keyboard user could not find out why the slot is unusable — which
       * is the one thing they need mid-turn.
       */
      expect(empty.getAttribute("aria-disabled")).toBe("true");
      expect(empty).toHaveProperty("disabled", false);
      expect(empty.getAttribute("aria-label")).toContain("Недоступно");
    }
  });

  it("heals, charges AP and consumes one unit in a single atomic save", async () => {
    seedRawSave(woundedWithBandages(2));
    const { container } = await renderApp();
    const before = persistedHero();
    expect(before.hp).toBe(12);

    fireEvent.click(slotButton(container, 1));

    await settle(() => expect(persistedHero().hp).toBe(12 + bandageHeal));
    const hero = persistedHero();
    /* HP, AP and the item all moved in one write: no intermediate save can hold two of the three. */
    expect(hero.ap).toBe(before.ap - bandage.apCost);
    expect(quantityOf(persistedInventory().backpack.items, "field-bandage")).toBe(1);
    /* The slot survives while stock remains, and the log names the effect. */
    expect(persistedInventory().quickSlots[0]).toBe("field-bandage");
    expect(container.textContent).toContain(`+${bandageHeal} HP`);
    expect(slotButton(container, 1).getAttribute("aria-label")).toContain("×1");
  });

  it("clears the slot when the last unit is spent and then refuses further use", async () => {
    seedRawSave(woundedWithBandages(1));
    const { container } = await renderApp();

    fireEvent.click(slotButton(container, 1));

    await settle(() => expect(persistedInventory().quickSlots[0]).toBeNull());
    expect(quantityOf(persistedInventory().backpack.items, "field-bandage")).toBe(0);
    const emptied = slotButton(container, 1);
    expect(emptied.getAttribute("data-blocked")).toBe("empty-slot");

    /* A second press changes nothing at all — no negative stack, no phantom heal. */
    const after = readRawSave();
    fireEvent.click(emptied);
    await settle(() => expect(container.textContent).toContain("Слот пуст"));
    expect(readRawSave()).toBe(after);
  });

  it("refuses a full-HP heal without consuming the bandage", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        backpackItems: [{ id: "field-bandage", quantity: 2 }],
        quickSlots: { 0: "field-bandage" },
      }).raw,
    );
    const { container } = await renderApp();
    const before = readRawSave();
    expect(persistedHero().hp).toBe(24);

    const slot = slotButton(container, 1);
    expect(slot.getAttribute("data-blocked")).toBe("not-wounded");
    fireEvent.click(slot);

    await settle(() => expect(container.textContent).toContain("HP уже полные"));
    /* Byte-identical: a refusal must not even rewrite the save. */
    expect(readRawSave()).toBe(before);
    expect(quantityOf(persistedInventory().backpack.items, "field-bandage")).toBe(2);
  });

  it("refuses when the hero cannot pay the AP price, and says how much is missing", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        heroHp: 12,
        heroAp: bandage.apCost - 1,
        backpackItems: [{ id: "field-bandage", quantity: 1 }],
        quickSlots: { 0: "field-bandage" },
      }).raw,
    );
    const { container } = await renderApp();
    const before = readRawSave();

    const slot = slotButton(container, 1);
    expect(slot.getAttribute("data-blocked")).toBe("insufficient-ap");
    expect(slot.getAttribute("aria-label")).toContain(`Нужно ${bandage.apCost} ОЧ`);
    fireEvent.click(slot);

    await settle(() => expect(container.textContent).toContain(`Нужно ${bandage.apCost} ОЧ`));
    expect(readRawSave()).toBe(before);
  });

  it("applies the consumable from the keyboard through the shell's own listener", async () => {
    /* Shift+1, not a bare 1: the digits already select a body part, and that binding must survive. */
    seedRawSave(woundedWithBandages(2));
    const { container } = await renderApp();
    const activePart = () =>
      container.querySelector(".action-tray .actions button.active")?.textContent?.replace(/\s+/g, " ");
    expect(activePart()).toContain("Торс");

    fireEvent.keyDown(window, { key: "!", code: "Digit1", shiftKey: true });

    await settle(() => expect(persistedHero().hp).toBe(12 + bandageHeal));
    /* The body part is untouched, so the two bindings genuinely coexist. */
    expect(activePart()).toContain("Торс");
    expect(quantityOf(persistedInventory().backpack.items, "field-bandage")).toBe(1);
  });

  it("ignores the quick-slot hotkey outside an active player turn", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "home",
        backpackItems: [{ id: "field-bandage", quantity: 2 }],
        quickSlots: { 0: "field-bandage" },
      }).raw,
    );
    await renderApp();
    const before = readRawSave();

    fireEvent.keyDown(window, { key: "!", code: "Digit1", shiftKey: true });

    expect(readRawSave()).toBe(before);
    expect(quantityOf(persistedInventory().backpack.items, "field-bandage")).toBe(2);
  });

  it("restores reserve ammo and clears the slot, without touching the magazine", async () => {
    seedRawSave(
      buildSave(content, {
        screen: "mission",
        heroAmmo: { magazine: 1, reserveAmmo: 0 },
        backpackItems: [{ id: "pistol-rounds", quantity: 1 }],
        quickSlots: { 2: "pistol-rounds" },
      }).raw,
    );
    const { container } = await renderApp();
    const effect = effectForItem(content.itemEffects, "pistol-rounds")!;
    const amount = (effect.effect as { kind: "restore-ammo"; amount: number }).amount;
    expect(persistedHero().weaponState!.reserveAmmo).toBe(0);

    fireEvent.click(slotButton(container, 3));

    await settle(() => expect(persistedHero().weaponState!.reserveAmmo).toBe(amount));
    expect(persistedInventory().quickSlots[2]).toBeNull();
    /* Loading the magazine stays `reloadWeapon`'s job. */
    expect(container.textContent).toContain("запас");
  });
});

describe("W5-04 dismantle at the base", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  /** Return label for an id, read off the shipped table. */
  const returnsLabel = (itemId: string) =>
    Object.entries(returnsFor(content.returnTables, itemId))
      .map(([id, amount]) => `${RESOURCE_LABELS[id as ResourceId]} ×${amount}`)
      .join(", ");

  const dismantleButton = (container: Element, id: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[data-dismantle="${id}"]`);
    if (!button) throw new Error(`no dismantle button for ${id}`);
    return button;
  };

  it("previews the exact return before anything is destroyed", async () => {
    seedRawSave(buildSave(content, { screen: "home", stashItems: [{ id: "repair-kit", quantity: 2 }] }).raw);
    const { container } = await renderApp();

    expect(screen.getByRole("group", { name: "Разборка" })).toBeTruthy();
    const kit = dismantleButton(container, "repair-kit");
    /* The label states the payout from the table, not a percentage the UI computed. */
    expect(kit.textContent).toContain(returnsLabel("repair-kit"));
    expect(kit.getAttribute("aria-label")).toContain(`Возврат: ${returnsLabel("repair-kit")}`);
    expect(kit.getAttribute("aria-label")).toContain("необратимо");
  });

  it("destroys a stashed item and pays exactly the previewed return into the stash", async () => {
    seedRawSave(buildSave(content, { screen: "home", stashItems: [{ id: "repair-kit", quantity: 2 }] }).raw);
    const { container } = await renderApp();
    const expected = returnsFor(content.returnTables, "repair-kit") as Record<string, number>;
    const before = readRawSave();

    /* First press only arms: every destruction is irreversible, so none is one click away. */
    fireEvent.click(dismantleButton(container, "repair-kit"));
    await settle(() => expect(container.querySelector("p.dismantle-confirm")).not.toBeNull());
    expect(readRawSave()).toBe(before);

    fireEvent.click(dismantleButton(container, "repair-kit"));

    await settle(() => expect(quantityOf(persistedInventory().stash.items, "repair-kit")).toBe(1));
    const stash = persistedInventory().stash.resources;
    for (const [id, amount] of Object.entries(expected))
      expect(quantityOf(stash, id), `${id} paid into the stash`).toBe(amount);
    expect(container.textContent).toContain(returnsLabel("repair-kit"));
  });

  /**
   * The soft-lock regression. Worn gear was destructible behind a confirmation, and destroying it
   * ended the run: the shipped arenas hardcode the hero's loadout (`hero-hornet`, `starter-vest`), so
   * `hydrateArenaUnits` rebuilt a reference to the destroyed instance at mission start and
   * `validateSave` then refused every save — with no equip system and no spare gear in any reward to
   * recover with. Both presses are exercised here, so a regression cannot pass by only checking the
   * first one.
   */
  it("never destroys gear the hero is using, and says why, so the run cannot be soft-locked", async () => {
    seedRawSave(buildSave(content, { screen: "home" }).raw);
    const { container } = await renderApp();
    const before = readRawSave();

    for (const instanceId of ["starter-vest", "hero-hornet"]) {
      const worn = dismantleButton(container, instanceId);
      expect(worn.getAttribute("data-equipped"), instanceId).toBe("true");
      expect(worn.getAttribute("data-blocked"), instanceId).toBe("equipped");
      /* Reachable rather than `disabled` so the reason is announced, but permanently unavailable. */
      expect(worn.getAttribute("aria-disabled"), instanceId).toBe("true");
      expect(worn.getAttribute("aria-label"), instanceId).toContain("Недоступно");

      fireEvent.click(worn);
      fireEvent.click(dismantleButton(container, instanceId));
      await settle(() => expect(container.textContent).toContain("нельзя разобрать"));

      /* No confirmation was ever armed, nothing was saved, and the instance still exists. */
      expect(container.querySelector("p.dismantle-confirm"), instanceId).toBeNull();
      expect(readRawSave(), instanceId).toBe(before);
      expect(persistedInventory().equipment.map((entry) => entry.instanceId), instanceId).toContain(instanceId);
    }
    /* The hero is still equipped, which is what keeps the next mission startable. */
    expect(persistedHero().armor?.armorInstanceId).toBe("starter-vest");
    expect(persistedHero().weaponState?.weaponInstanceId).toBe("hero-hornet");
    expect(container.textContent).toContain("Снаряжение героя");
  });

  it("still starts the next mission after the base screen refused to dismantle worn gear", async () => {
    /* The symptom the refusal prevents, asserted end to end: the save the shell writes at mission
       start is the payload the validator rejected when the loadout could be destroyed. */
    seedRawSave(buildSave(content, { screen: "home" }).raw);
    const { container } = await renderApp();
    fireEvent.click(dismantleButton(container, "hero-hornet"));
    fireEvent.click(dismantleButton(container, "hero-hornet"));
    await settle(() => expect(container.textContent).toContain("нельзя разобрать"));

    fireEvent.click(screen.getByRole("button", { name: /ВЫБРАТЬ МИССИЮ/ }));
    await settle(() => expect(screen.getByRole("button", { name: "НАЧАТЬ" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "НАЧАТЬ" }));

    await settle(() => expect(JSON.parse(readRawSave()!).campaign.screen).toBe("mission"));
    expect(container.querySelector(".save-status")?.textContent).not.toContain("Ошибка сохранения");
    expect(persistedHero().weaponState?.weaponInstanceId).toBe("hero-hornet");
  });

  it("lets the player cancel an armed confirmation without destroying anything", async () => {
    seedRawSave(buildSave(content, { screen: "home", stashItems: [{ id: "repair-kit", quantity: 1 }] }).raw);
    const { container } = await renderApp();
    const before = readRawSave();

    fireEvent.click(dismantleButton(container, "repair-kit"));
    await settle(() => expect(container.querySelector("p.dismantle-confirm")).not.toBeNull());
    const banner = container.querySelector("p.dismantle-confirm")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain(returnsLabel("repair-kit"));
    fireEvent.click(screen.getByRole("button", { name: "ОТМЕНИТЬ" }));

    await settle(() => expect(container.querySelector("p.dismantle-confirm")).toBeNull());
    expect(readRawSave()).toBe(before);
    expect(quantityOf(persistedInventory().stash.items, "repair-kit")).toBe(1);
    /* And the row is armed again for a fresh, deliberate confirmation. */
    expect(dismantleButton(container, "repair-kit").getAttribute("data-blocked")).toBe("needs-confirmation");
  });

  it("no craft → dismantle cycle profits, driven through the real base UI", async () => {
    /*
     * W5-04 criterion 4 as the player can actually run it: craft the bandage recipe from stash cloth,
     * then dismantle the output, and compare the stash before and after. The load-time validator
     * proves the *tables* cannot profit; this proves the two shipped buttons cannot either.
     */
    const recipe = content.recipes.find((entry) => entry.id === "pistol-rounds")!;
    const metalCost = recipe.cost.metal!;
    seedRawSave(buildSave(content, { screen: "home", stashMetal: metalCost }).raw);
    const { container } = await renderApp();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${recipe.name}\\. `) }));
    await settle(() => expect(quantityOf(persistedInventory().stash.items, recipe.output.itemId)).toBe(recipe.output.quantity));
    expect(quantityOf(persistedInventory().stash.resources, "metal")).toBe(0);

    fireEvent.click(dismantleButton(container, recipe.output.itemId));
    await settle(() => expect(container.querySelector("p.dismantle-confirm")).not.toBeNull());
    fireEvent.click(dismantleButton(container, recipe.output.itemId));

    await settle(() => expect(quantityOf(persistedInventory().stash.items, recipe.output.itemId)).toBe(0));
    const recovered = quantityOf(persistedInventory().stash.resources, "metal");
    /* Strictly lossy, and never above the shipped table. */
    expect(recovered).toBeLessThan(metalCost);
    expect(recovered).toBe((returnsFor(content.returnTables, recipe.output.itemId) as Record<string, number>).metal ?? 0);
  });

  it("offers no dismantle control on the unresolved return screen", async () => {
    /* Same reason craft/upgrade are gated there: every dismantle writes a save, and the XP and loot
       penalties are only charged when the player confirms the return. */
    seedRawSave(buildSave(content, { screen: "return", stashItems: [{ id: "repair-kit", quantity: 1 }] }).raw);
    const { container } = await renderApp();

    expect(phaseLabel(container)).toBe("ВОЗВРАТ");
    expect(container.querySelectorAll("button[data-dismantle]")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Разборка" })).toBeNull();
  });
});

describe("W5-05 backpack loss on defeat", () => {
  beforeEach(() => {
    clearStoredSave();
    stubShippedContent();
  });

  const rate = PROPOSED_BACKPACK_LOSS_POLICY.rate;
  /** A defeat return carrying loot, past the free first death so the penalty actually applies. */
  const carryingLoot = (overrides: Parameters<typeof buildSave>[1] = { screen: "return" }) =>
    buildSave(content, {
      firstDeathReturnUsed: true,
      backpackMetal: 6,
      backpackItems: [{ id: "field-bandage", quantity: 4 }],
      ...overrides,
    }).raw;

  const lossNotice = (container: Element) => {
    const notice = container.querySelector("p.backpack-loss");
    if (!notice) throw new Error("no backpack-loss notice rendered");
    return notice;
  };

  it("lists exactly what will be lost before the player confirms, and labels the rule as a proposal", async () => {
    seedRawSave(carryingLoot());
    const { container } = await renderApp();
    const before = readRawSave();

    const notice = lossNotice(container);
    expect(notice.getAttribute("data-loss-applies")).toBe("true");
    expect(notice.getAttribute("data-carried-units")).toBe("10");
    expect(notice.getAttribute("data-loss-units")).toBe(String(Math.floor(10 * rate)));
    expect(notice.getAttribute("data-loss-rate")).toBe(String(Math.round(rate * 100)));
    /* Decision D-01 is open, so the number is marked as unapproved in the DOM and in the text. */
    expect(notice.getAttribute("data-proposed")).toBe("true");
    expect(notice.textContent).toContain("D-01");
    /* Every line names the item and the amount; item names come from the catalog. */
    const lines = [...container.querySelectorAll("span.loss-line")].map((line) => line.textContent ?? "");
    expect(lines).toHaveLength(2);
    expect(lines.join(" ")).toContain(RESOURCE_LABELS.metal);
    expect(lines.join(" ")).toContain(itemName("field-bandage"));
    /* What is *not* taken is stated too, so the player does not assume the base was raided. */
    expect(notice.textContent).toContain("Stash, надетая экипировка и её durability не затрагиваются");

    /* Rendering the preview must not itself charge anything. */
    expect(readRawSave()).toBe(before);
  });

  it("applies exactly the previewed loss on return, and never touches the stash", async () => {
    seedRawSave(carryingLoot({ screen: "return", stashMetal: 5 }));
    const { container } = await renderApp();
    const notice = lossNotice(container);
    const stated = [...container.querySelectorAll("span.loss-line")].map((line) => ({
      id: line.getAttribute("data-loss-id")!,
      lost: Number(line.getAttribute("data-loss-lost")),
    }));
    const statedUnits = Number(notice.getAttribute("data-loss-units"));
    expect(statedUnits).toBe(stated.reduce((sum, line) => sum + line.lost, 0));

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const inventory = persistedInventory();
    /* The backpack is emptied into the stash on return, so the surviving loot lands there: 6 metal
       carried, minus what was stated, plus the 5 that were already in the stash. */
    const lostMetal = stated.find((line) => line.id === "metal")!.lost;
    const lostBandages = stated.find((line) => line.id === "field-bandage")!.lost;
    expect(quantityOf(inventory.stash.resources, "metal")).toBe(5 + (6 - lostMetal));
    expect(quantityOf(inventory.stash.items, "field-bandage")).toBe(4 - lostBandages);
    expect(inventory.backpack.resources).toEqual([]);
    expect(inventory.backpack.items).toEqual([]);
    /* Worn equipment survives untouched. */
    expect(inventory.equipment.map((entry) => entry.instanceId)).toContain("starter-vest");
    expect(container.textContent).toContain("Потеряно из рюкзака");
  });

  it("takes nothing on the free first defeat, and says so", async () => {
    seedRawSave(carryingLoot({ screen: "return", firstDeathReturnUsed: false }));
    const { container } = await renderApp();

    const notice = lossNotice(container);
    expect(notice.getAttribute("data-loss-applies")).toBe("false");
    expect(notice.textContent).toContain("Первое поражение");

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    /* Everything carried survives into the stash: the free death costs neither XP nor loot. */
    const inventory = persistedInventory();
    expect(quantityOf(inventory.stash.resources, "metal")).toBe(6);
    expect(quantityOf(inventory.stash.items, "field-bandage")).toBe(4);
    expect(persistedSave().campaign.firstDeathReturnUsed).toBe(true);
  });

  it("takes nothing on a retreat, with a visibly different consequence from a defeat", async () => {
    seedRawSave(carryingLoot({ screen: "return", returnReason: "retreat", firstDeathReturnUsed: true }));
    const { container } = await renderApp();

    const notice = lossNotice(container);
    expect(notice.getAttribute("data-loss-applies")).toBe("false");
    expect(notice.textContent).toContain("Отступление");
    /* doc 12 requires the two exits to read differently, not to share one generic sentence. */
    expect(notice.textContent).not.toContain("Первое поражение");

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    const inventory = persistedInventory();
    expect(quantityOf(inventory.stash.resources, "metal")).toBe(6);
    expect(quantityOf(inventory.stash.items, "field-bandage")).toBe(4);
  });

  it("spares a backpack too small for the rate to reach one whole unit", async () => {
    /* Three carried units at 30% floors to zero. Deliberate: the audit's objection to the historical
       penalty was that it felt unfair, and taking the last bandage is the shape of that unfairness. */
    seedRawSave(carryingLoot({ screen: "return", firstDeathReturnUsed: true, backpackMetal: 3, backpackItems: [] }));
    const { container } = await renderApp();

    const notice = lossNotice(container);
    expect(notice.getAttribute("data-loss-applies")).toBe("true");
    expect(notice.getAttribute("data-loss-units")).toBe("0");
    expect(notice.textContent).toContain("округляются в ноль");
    expect(container.querySelectorAll("span.loss-line")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "ВЕРНУТЬСЯ НА БАЗУ" }));

    await settle(() => expect(phaseLabel(container)).toBe("БАЗА"));
    expect(quantityOf(persistedInventory().stash.resources, "metal")).toBe(3);
  });

  it("charges the same loss when the player retries instead of walking home", async () => {
    seedRawSave(carryingLoot());
    const { container } = await renderApp();
    const statedUnits = Number(lossNotice(container).getAttribute("data-loss-units"));
    expect(statedUnits).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "ПОВТОРИТЬ МИССИЮ" }));

    await settle(() => expect(phaseLabel(container)).toBe("ВАШ ХОД"));
    /* Retry is not a free undo: the backpack is charged, and the surviving loot is still carried
       (a retry re-enters the mission rather than depositing into the stash). */
    const inventory = persistedInventory();
    const carriedAfter =
      quantityOf(inventory.backpack.resources, "metal") + quantityOf(inventory.backpack.items, "field-bandage");
    expect(carriedAfter).toBe(10 - statedUnits);
    /* The stash was never the source of the penalty. */
    expect(inventory.stash.resources).toEqual([]);
  });

  it("does not escalate: a second defeat prices the same carried backpack identically", async () => {
    const first = () => {
      seedRawSave(carryingLoot());
      return renderApp();
    };
    const { container, unmount } = await first();
    const stated = lossNotice(container).getAttribute("data-loss-units");
    unmount();

    clearStoredSave();
    stubShippedContent();
    /* Same backpack, a later defeat: nothing in the rule reads a death counter. */
    seedRawSave(carryingLoot({ screen: "return", firstDeathReturnUsed: true, xp: 120, claimedRewards: [] }));
    const second = await renderApp();

    expect(lossNotice(second.container).getAttribute("data-loss-units")).toBe(stated);
  });
});
