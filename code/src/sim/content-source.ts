/**
 * Node-side content loading for the balance simulator (W3-01, acceptance criterion 2:
 * "loads the same JSON catalogs as the runtime and fails on invalid data the same way").
 *
 * The runtime loaders in `game/content.ts` and `game/campaign-content.ts` are `fetch(url) ->
 * validate` pipelines over absolute URLs like `/config/arena-manifest.json`. Rather than
 * re-implementing the loading (which would mean re-implementing, or at least bypassing, the
 * validation), this module installs a `globalThis.fetch` that resolves those same absolute paths
 * against `code/public/` and then calls the *real* loaders.
 *
 * Consequences, on purpose:
 *   - every validator, every cross-reference check and every error type is the runtime's;
 *   - a malformed or missing file fails with the runtime's `ContentValidationError` /
 *     `ContentLoadError`, not a bespoke simulator error;
 *   - the arena set comes from `arena-manifest.json` only. A map file that exists in
 *     `public/config/` but is absent from the manifest is not loaded and cannot be simulated,
 *     which is what "only arena-manifest live maps" means.
 *
 *     **Updated 26 August 2026.** Four of the five files this note used to list were deleted:
 *     `arena-relay.json`, `arena-yard.json` and `arena-checkpoint.json` carried the *same ids* as the
 *     live maps with different data, so editing one had no effect on the game and every chance of
 *     wasting an afternoon; `mission.json` was read by nobody at all. `arena.json` (`dusty-perimeter`)
 *     **remains and is not an orphan** — it is a live test fixture for `boot-view.test.ts`,
 *     `m3-shipped.test.ts` and `m3-content-alpha.test.ts`, which read it straight off disk rather than
 *     through the manifest. Deleting it fails four tests; that is how this correction was found.
 *
 * The fetch shim is process-local and installed only while loading.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, normalize, sep } from 'node:path'
import {
  loadArenaCatalog,
  loadArenaManifest,
  type ArenaCatalog,
} from '../game/content'
import { ContentLoadError } from '../game/content-format'
import {
  loadBaseUpgrades,
  loadItems,
  loadMissions,
  loadRecipes,
  loadRewards,
  loadZones,
  validateCampaignCatalog,
  type ItemDefinition,
  type MissionDefinition,
  type RewardDefinition,
  type ZoneDefinition,
} from '../game/campaign-content'
import type { BaseUpgradeDefinition, RecipeDefinition } from '../game/base'
import { loadEquipmentCatalog, type EquipmentCatalog } from '../game/equipment-content'
import { campaignCatalogFor } from '../game/campaign-catalog'
import { loadProgression, type ProgressionCatalog } from '../game/progression'
import type { CampaignCatalog } from '../game/save'

/** `code/public`, the directory the dev server and `vite build` serve `/config/*` from. */
export const PUBLIC_ROOT = fileURLToPath(new URL('../../public/', import.meta.url))

/**
 * Minimal `fetch` over `public/`. Only the two shapes the loaders actually request are
 * supported (`/config/x.json` and `config/x.json`); anything that escapes `public/` is refused
 * rather than silently read, so a hostile `path` in a manifest cannot read the repository.
 */
export function createPublicFetch(publicRoot = PUBLIC_ROOT): typeof globalThis.fetch {
  /**
   * `PUBLIC_ROOT` is built from a directory URL and therefore already ends in a separator, so the
   * containment prefix has to be normalised to exactly one trailing separator. Appending `sep`
   * unconditionally produces `public//`, which no `normalize`d path ever starts with — every
   * request would be refused as an escape attempt.
   */
  const boundary = normalize(publicRoot).replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '') + sep
  return (async (input: RequestInfo | URL) => {
    const requested = typeof input === 'string' ? input : input instanceof URL ? input.pathname : String(input)
    const relative = requested.replace(/^\/+/, '')
    const absolute = normalize(join(publicRoot, relative))
    if (!absolute.startsWith(boundary)) throw new ContentLoadError(requested, 403)
    let body: string
    try {
      body = await readFile(absolute, 'utf8')
    } catch {
      // Same shape the browser produces for a missing file, so `ContentLoadError` is what
      // surfaces and the simulator reports a missing map exactly like the game does.
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
}

/** Runs `load` with `globalThis.fetch` temporarily backed by `public/`. Always restores. */
export async function withPublicFetch<T>(load: () => Promise<T>, publicRoot = PUBLIC_ROOT): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = createPublicFetch(publicRoot)
  try {
    return await load()
  } finally {
    globalThis.fetch = original
  }
}

export interface SimulationContent {
  catalogId: string
  arenas: ArenaCatalog
  /** Encounters in unlocked zones only — the same filter the app shell applies on boot. */
  missions: MissionDefinition[]
  rewards: RewardDefinition[]
  zones: ZoneDefinition[]
  items: ItemDefinition[]
  recipes: RecipeDefinition[]
  upgrades: BaseUpgradeDefinition[]
  equipment: EquipmentCatalog
  progression: ProgressionCatalog
  campaignCatalog: CampaignCatalog
}

/**
 * Loads and cross-validates every shipped catalog exactly as `app.tsx` does on boot: manifest ->
 * arenas (with equipment reference checks) -> campaign cross-references -> unlocked-zone filter.
 * Throws the runtime error on the first invalid file.
 */
export async function loadSimulationContent(publicRoot = PUBLIC_ROOT): Promise<SimulationContent> {
  return withPublicFetch(async () => {
    const [manifest, missions, rewards, upgrades, recipes, items, zones, equipment, progression] = await Promise.all([
      loadArenaManifest(),
      loadMissions(),
      loadRewards(),
      loadBaseUpgrades(),
      loadRecipes(),
      loadItems(),
      loadZones(),
      loadEquipmentCatalog(),
      loadProgression(),
    ])
    const arenas = await loadArenaCatalog(manifest, new Set(missions.map((mission) => mission.arenaId)), equipment)
    const validated = validateCampaignCatalog(
      { zones, missions, rewards, items, recipes, upgrades },
      new Set(arenas.all.map((arena) => arena.id)),
      new Set(items.map((item) => item.id)),
      {
        /* W6-01: the simulator loads through the same cross-file checks the shell does, so a mutated
           catalog with an out-of-bounds objective fails here rather than producing a run whose win rate
           silently describes an unwinnable mission. */
        arenaBounds: new Map(arenas.all.map((arena) => [arena.id, { width: arena.width, height: arena.height }])),
      },
    )
    if (!validated.ok) throw validated.error
    const unlocked = new Set(validated.value.zones.filter((zone) => zone.unlocked).map((zone) => zone.id))
    const playable = validated.value.missions.filter((mission) => unlocked.has(mission.zoneId))
    if (!playable.length) throw new Error('Каталог кампании не содержит доступной encounter.')
    return {
      catalogId: arenas.catalogId,
      arenas,
      missions: playable,
      rewards: validated.value.rewards,
      zones: validated.value.zones,
      items,
      recipes,
      upgrades,
      equipment,
      progression,
      campaignCatalog: campaignCatalogFor({
        catalogId: arenas.catalogId,
        missions: playable,
        rewardIds: validated.value.rewards.map((reward) => reward.id),
        arenaIds: arenas.all.map((arena) => arena.id),
        items,
        equipment,
        progression: progression.curve,
      }),
    }
  }, publicRoot)
}
