/**
 * Initial-loading regression coverage at the pure view/state layer (M3-C item 4).
 *
 * LIMITATION — stated deliberately: this repo has no Preact DOM test infrastructure
 * (no jsdom/happy-dom environment, no @testing-library, no preact-render-to-string), so these
 * are NOT E2E or DOM tests. They exercise `selectBootView`, the pure boot view model that the
 * shell's loading/recovery/ready branches are derived from, and they assert the two properties
 * that the crash class depends on: (a) no campaign dereference before catalogs/save resolve,
 * (b) the loading state is the selected state in that window.
 */
import { describe, expect, it } from "vitest";
import { isBootReady, selectBootView, type BootInput } from "./boot-view";
import { createCampaign } from "./campaign";
import { defaultSave } from "./save";
import { parseArenaContent } from "./content";
import { parseEquipmentCatalog, applyEnemyArchetype } from "./equipment-content";
import { readFileSync } from "node:fs";

const shipped = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../public/config/${name}.json`, import.meta.url), "utf8"),
  ) as unknown;

const arena = parseArenaContent(shipped("arena"));
const equipment = parseEquipmentCatalog(shipped("equipment"));
const missions = [
  {
    id: arena.id,
    zoneId: "near-perimeter",
    order: 1,
    rewardId: `${arena.id}-clear`,
    arenaId: arena.id,
  },
];
const units = arena.units.map((unit) =>
  applyEnemyArchetype({ ...unit, ap: unit.team === "player" ? 10 : 0 }, equipment),
);
const save = defaultSave(arena.id, units, undefined, missions);
const catalog = { missions, arenas: { catalogId: "shipped" } };

const input = (overrides: Partial<BootInput> = {}): BootInput => ({
  arena: null,
  catalog: null,
  save: null,
  recovery: null,
  log: "Загрузка убежища…",
  ...overrides,
});

describe("M3-C initial loading — no null campaign dereference", () => {
  it("selects loading with nothing resolved yet", () => {
    const view = selectBootView(input());
    expect(view.phase).toBe("loading");
    expect(view.loading).toBe(true);
    expect(view.heading).toBe("Загрузка убежища…");
    expect(view.ready).toBeNull();
    expect(isBootReady(view)).toBe(false);
  });

  it("keeps loading through every partially resolved boot combination", () => {
    const combinations: Partial<BootInput>[] = [
      { arena },
      { catalog },
      { save },
      { arena, catalog },
      { arena, save },
      { catalog, save },
    ];
    for (const partial of combinations) {
      const view = selectBootView(input(partial));
      expect(view.phase).toBe("loading");
      expect(view.loading).toBe(true);
      expect(view.ready).toBeNull();
    }
  });

  it("never exposes a campaign object before catalogs and save resolve", () => {
    const view = selectBootView(input({ arena, catalog }));
    // Reading the campaign is only possible via ready, which is null while loading.
    expect(view.ready?.campaign).toBeUndefined();
    expect(() => view.ready!.campaign.screen).toThrow();
    expect(view.loading).toBe(true);
  });

  it("renders the pending log message through a polite live region while loading", () => {
    const view = selectBootView(input({ log: "Каталог загружается…" }));
    expect(view.message).toBe("Каталог загружается…");
    expect(view.live).toBe("polite");
  });

  it("treats a save without inventory or base as still loading", () => {
    const withoutInventory = {
      ...save,
      inventory: undefined,
    } as unknown as typeof save;
    const withoutBase = { ...save, base: undefined } as unknown as typeof save;
    expect(
      selectBootView(input({ arena, catalog, save: withoutInventory })).loading,
    ).toBe(true);
    expect(
      selectBootView(input({ arena, catalog, save: withoutBase })).loading,
    ).toBe(true);
  });

  it("becomes ready with a non-null campaign only once every dependency exists", () => {
    const view = selectBootView(input({ arena, catalog, save }));
    expect(view.phase).toBe("ready");
    expect(view.loading).toBe(false);
    expect(isBootReady(view)).toBe(true);
    expect(view.ready).not.toBeNull();
    expect(view.ready!.campaign).toBe(save.campaign);
    expect(view.ready!.campaign.screen).toBe("home");
    expect(view.ready!.arena.id).toBe(arena.id);
  });

  it("exposes the persisted campaign, not a synthesised placeholder, when ready", () => {
    const persisted = createCampaign(missions, "shipped");
    const resumed = { ...save, campaign: { ...persisted, screen: "mission" as const } };
    const view = selectBootView(input({ arena, catalog, save: resumed }));
    expect(view.ready!.campaign.screen).toBe("mission");
    expect(view.ready!.campaign.catalogId).toBe("shipped");
  });

  it("prefers recovery over loading and still avoids campaign access", () => {
    const view = selectBootView(
      input({
        recovery: { message: "Сохранение повреждено", content: false },
        arena,
        catalog,
        save,
      }),
    );
    expect(view.phase).toBe("recovery");
    expect(view.loading).toBe(false);
    expect(view.ready).toBeNull();
    expect(view.heading).toBe("Сохранение не загружено");
    expect(view.message).toBe("Сохранение повреждено");
  });

  it("uses the recovery message as the recovery view status", () => {
    const view = selectBootView(input({ recovery: { message: "Ошибка каталога", content: true } }));
    expect(view.message).toBe("Ошибка каталога");
    expect(view.live).toBe("polite");
  });
  it("distinguishes content recovery from save recovery in the heading", () => {
    const view = selectBootView(
      input({ recovery: { message: "Каталог сломан", content: true } }),
    );
    expect(view.heading).toBe("Контент кампании не загружен");
  });

  it("is wired as the shell's boot source", () => {
    expect(isBootReady(selectBootView(input({ arena, catalog, save })))).toBe(true);
    expect(selectBootView(input()).phase).toBe("loading");
  });

  it("is a pure function of its input", () => {
    const argument = input({ arena, catalog, save });
    const snapshot = JSON.stringify({
      arena: argument.arena?.id,
      log: argument.log,
      screen: argument.save?.campaign.screen,
    });
    selectBootView(argument);
    selectBootView(argument);
    expect(
      JSON.stringify({
        arena: argument.arena?.id,
        log: argument.log,
        screen: argument.save?.campaign.screen,
      }),
    ).toBe(snapshot);
  });
});
