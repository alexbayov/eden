/**
 * Pure boot state machine for the app shell (M3-C UX remediation, item 4).
 *
 * Before catalogs and the save are resolved there is no campaign object at all, so the shell
 * must never dereference one. `selectBootView` is the single source of truth for what the
 * shell renders and is exercised directly by `boot-view.test.ts` — it is a pure view-model
 * test, not an E2E/DOM test (no jsdom or Preact DOM test infra is installed in this repo).
 */
import type { CampaignState } from "./campaign";
import type { ArenaConfig } from "./content";
import type { SaveData } from "./save";

export type BootPhase = "loading" | "recovery" | "ready";

export interface BootInput {
  arena: ArenaConfig | null;
  /** Any truthy catalog value; the shell's Catalog type is app-local. */
  catalog: unknown;
  save: SaveData | null;
  recovery: { message: string; content: boolean } | null;
  log: string;
}

export interface BootView {
  phase: BootPhase;
  /** True while catalogs/save are still pending: the shell renders the loading screen. */
  loading: boolean;
  heading: string;
  message: string;
  /** aria-live politeness for the status paragraph. */
  live: "polite" | "off";
  /** Ready-only payload. Null in loading/recovery so a null campaign cannot be dereferenced. */
  ready: { arena: ArenaConfig; save: SaveData; campaign: CampaignState } | null;
}

/**
 * Resolves what the shell should render. Guarantees:
 * - recovery wins over everything (its own screen, no campaign access);
 * - loading is selected whenever arena/catalog/save/inventory/base are incomplete;
 * - `ready` is non-null only when every dependency exists, so callers read the campaign
 *   through `ready.campaign` instead of a nullable save.
 */
export function selectBootView(input: BootInput): BootView {
  if (input.recovery)
    return {
      phase: "recovery",
      loading: false,
      heading: input.recovery.content
        ? "Контент кампании не загружен"
        : "Сохранение не загружено",
      message: input.recovery.message,
      live: "polite",
      ready: null,
    };
  const complete = Boolean(
    input.arena && input.catalog && input.save?.inventory && input.save?.base,
  );
  if (!complete)
    return {
      phase: "loading",
      loading: true,
      heading: "Загрузка убежища…",
      message: input.log,
      live: "polite",
      ready: null,
    };
  const save = input.save!;
  return {
    phase: "ready",
    loading: false,
    heading: "Убежище готово",
    message: input.log,
    live: "polite",
    ready: { arena: input.arena!, save, campaign: save.campaign },
  };
}

/** Convenience guard used by the shell before touching campaign screens. */
export const isBootReady = (view: BootView): view is BootView & {
  ready: NonNullable<BootView["ready"]>;
} => view.ready !== null;
