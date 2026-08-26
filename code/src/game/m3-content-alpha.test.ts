import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArenaContent, validateArenaWithEquipment } from "./content";
import { parseEquipmentCatalog } from "./equipment-content";
import { ContentValidationError } from "./content-format";
import { awardRewardTransition } from "./rewards";
import { createInventory } from "./inventory";
import {
  validateCampaignCatalog,
  validateItems,
  validateMissions,
  validateRecipes,
  validateRewards,
  validateZones,
} from "./campaign-content";
import {
  claimReward,
  createCampaign,
  missionDefeat,
  missionProgress,
  missionVictory,
  retryMission,
  startMission,
} from "./campaign";
import {
  createMemoryStorage,
  createLocalStorageAdapter,
  defaultSave,
} from "./save";

const shipped = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../public/config/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as unknown;
const missionResult = validateMissions(shipped("missions"));
if (!missionResult.ok) throw missionResult.error;
const missions = missionResult.value;
const campaignMissions = missions.map(({ id, zoneId, order, rewardId, arenaId }) => ({
  id,
  zoneId,
  order,
  rewardId,
  arenaId,
}));

describe("M3-B near-perimeter content alpha", () => {
  it("validates all catalog links and all three shipped maps", () => {
    const zones = validateZones(shipped("zones"));
    const rewards = validateRewards(shipped("rewards"));
    const items = validateItems(shipped("items"));
    const recipes = validateRecipes(shipped("recipes"));
    expect(zones.ok && rewards.ok && items.ok && recipes.ok).toBe(true);
    const maps = missions.map((mission) =>
      parseArenaContent(shipped(mission.arenaId)),
    );
    expect(
      validateCampaignCatalog(
         {
           zones: zones.ok ? zones.value : [],
           missions,
           rewards: rewards.ok ? rewards.value : [],
           items: items.ok ? items.value : [],
           recipes: recipes.ok ? recipes.value : [],
         },
         new Set(maps.map((map) => map.id)),
         new Set(items.ok ? items.value.map((item) => item.id) : []),
      ).ok,
    ).toBe(true);
    /*
     * W6-06 — the roster grew from three archetypes to six, and each shipped map's first enemy now carries one
     * of the three new ones. Asserted against the *catalog* rather than a hardcoded list, so extending the
     * roster again does not require editing this line: what matters is that every placement names an archetype
     * that actually exists, which is the reference this test is really about.
     */
    const archetypeIds = new Set(parseEquipmentCatalog(shipped("equipment")).enemies.map((entry) => entry.id));
    const placed = maps.map(
      (map) => map.units.filter((unit) => unit.team === "enemy")[0]?.archetypeId,
    );
    expect(placed).toHaveLength(3);
    for (const archetypeId of placed) {
      expect(archetypeId, "every map places a real archetype").toBeDefined();
      expect(archetypeIds.has(archetypeId!), `unknown archetype ${archetypeId}`).toBe(true);
    }
    /* And the three maps use three *different* archetypes, so the zone is not one enemy repeated. */
    expect(new Set(placed).size).toBe(3);
  });

  it("rejects invalid mission zone, arena, reward, and order references before boot", () => {
    const zonesResult = validateZones(shipped("zones"));
    const rewardsResult = validateRewards(shipped("rewards"));
    expect(zonesResult.ok && rewardsResult.ok).toBe(true);
    if (!zonesResult.ok || !rewardsResult.ok) return;
    const catalog = {
      zones: [zonesResult.value[0]],
      missions: [{ ...missions[0], zoneId: "missing-zone", arenaId: "missing-arena", rewardId: "missing-reward", order: 2 }],
      rewards: [rewardsResult.value[0]],
    };
    const result = validateCampaignCatalog(catalog, new Set(["known-arena"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ContentValidationError);
    expect(result.error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      `missions.${missions[0].id}.zoneId`,
      `missions.${missions[0].id}.arenaId`,
      `missions.${missions[0].id}.rewardId`,
      `zones.near-perimeter`,
    ]));
  });

  it("rejects unknown enemy archetypes and weapon/armor references before boot", () => {
    const arena = parseArenaContent(shipped("arena"));
    const equipment = parseEquipmentCatalog(shipped("equipment"));
    expect(() => validateArenaWithEquipment({ ...arena, units: [{ ...arena.units[0], team: "enemy", archetypeId: "missing-archetype" }, ...arena.units.slice(1)] }, equipment)).toThrow("archetypeId");
    expect(() => validateArenaWithEquipment({ ...arena, units: [{ ...arena.units[0], weaponState: { ...arena.units[0].weaponState!, weaponId: "missing-weapon" } }, ...arena.units.slice(1)] }, equipment)).toThrow("weaponId");
    expect(() => validateArenaWithEquipment({ ...arena, units: [{ ...arena.units[0], armor: { ...arena.units[0].armor!, armorId: "missing-armor" } }, ...arena.units.slice(1)] }, equipment)).toThrow("armor");
  });
  it("accepts the complete shipped boot catalog", () => {
    const zonesResult = validateZones(shipped("zones"));
    const rewardsResult = validateRewards(shipped("rewards"));
    expect(zonesResult.ok && rewardsResult.ok).toBe(true);
    if (!zonesResult.ok || !rewardsResult.ok) return;
    expect(validateCampaignCatalog(
      { zones: zonesResult.value, missions, rewards: rewardsResult.value },
      new Set(missions.map((mission) => mission.arenaId)),
    ).ok).toBe(true);
  });

  it("locks encounters in order, returns to base, retries failures, and awards once", () => {
    let state = createCampaign(campaignMissions, 'test-catalog');
    expect(state.encounters.map((entry) => entry.status)).toEqual([
      "available",
      "locked",
      "locked",
    ]);
    expect(startMission(state, "collapsed-yard", campaignMissions)).toBe(state);
    state = startMission(state, campaignMissions[0].id, campaignMissions);
    state = missionDefeat(state);
    expect(missionProgress(state, "perimeter-checkpoint")?.status).toBe(
      "failed",
    );
    state = retryMission(state, campaignMissions);
    state = missionVictory(state, campaignMissions);
    state = claimReward(state, "perimeter-checkpoint-clear", 30);
    expect(state.screen).toBe("home");
    expect(state.encounters.map((entry) => entry.status)).toEqual([
      "completed",
      "available",
      "locked",
    ]);
    expect(claimReward(state, "perimeter-checkpoint-clear", 30)).toBe(state);
  });

  it("keeps reward award and claim atomic under repeated activation", () => {
    let state = startMission(createCampaign(campaignMissions, "test-catalog"), campaignMissions[0].id, campaignMissions);
    state = missionVictory(state, campaignMissions);
    const reward = { id: campaignMissions[0].rewardId, name: "Reward", xp: 30, resources: { metal: 2 }, items: [], oneTime: true };
    const inventory = createInventory(20);
    const first = awardRewardTransition(state, inventory, reward, campaignMissions);
    const second = awardRewardTransition(first.campaign, first.inventory, reward, campaignMissions);
    expect(first.alreadyClaimed).toBe(false);
    expect(second.alreadyClaimed).toBe(true);
    expect(first.campaign.xp).toBe(30);
    expect(second.campaign).toBe(first.campaign);
    expect(second.inventory).toBe(first.inventory);
  });
  it("retains campaign progress through reload at each campaign stage", () => {
    const firstMission = missions[0];
    const arena = parseArenaContent(shipped(firstMission.arenaId));
    const adapter = createLocalStorageAdapter(createMemoryStorage(), { campaignMissions });
    let campaign = createCampaign(campaignMissions, 'test-catalog');
    for (const stage of ["available", "active", "completed"] as const) {
      if (stage === "active") campaign = startMission(campaign, firstMission.id, campaignMissions);
      if (stage === "completed") campaign = missionVictory(campaign, campaignMissions);
      const save = {
        ...defaultSave(arena.id, arena.units.map((unit) => ({ ...unit, ap: unit.team === "player" ? 10 : 0 })), undefined, campaignMissions),
        campaign,
        activeEncounterId: campaign.activeMissionId,
        phase: stage === "active" ? ("player" as const) : stage === "completed" ? ("victory" as const) : ("player" as const),
      };
      expect(adapter.save(save)).toBe(true);
      expect(adapter.load()?.ok).toBe(true);
    }
  });
});
