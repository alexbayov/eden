# 04 — Combat Formula Reconciliation

**Статус:** реализовано, 17 августа 2026.

## Authoritative pipeline

`code/src/game/combat.ts` exposes the sole shot transition: `combatAttack` / `performCombatAttack`. Every resolved shot receives injected rolls and applies AP, magazine, weapon durability, malfunction, ammo modifiers, penetration, hit, crit, body-part status, HP, and live armor wear.

A valid trigger attempt spends AP, one round, and `durabilityPerShot`. A malfunction stops projectile resolution after those costs. Armor loses its affected body-part protection value per hit, clamped to zero; at zero it mitigates no damage.

Overwatch is resolved during enemy movement only when an enemy crosses from no LOS into LOS. It makes one torso reaction through the same pipeline, consumes the hero's reserved state, ammunition and weapon durability, and records a resolution log only after an actual action result.

## Persistence contract

Player combat `weaponState` and `armor` IDs, item IDs, slots, durability, and maximum durability must exactly match their inventory equipment instances. Structurally valid but divergent saves are rejected; only legacy schema migration may normalize data. Current schema: **v5** (`eden.save.v5`), see [`23-data-contracts-and-content-pipeline.md`](23-data-contracts-and-content-pipeline.md) §5.

## Штраф смерти не является боевой формулой

Поражение в бою — `runEnemyTurn` → `heroDefeated` → `missionDefeat` — **не отнимает ничего само по себе**. Единственная формула штрафа живёт в `code/src/game/progression.ts` (`deathPenalty`), применяется при уходе с экрана возврата и затрагивает **только XP**. Ни `combat.ts`, ни `session.ts` её не читают и не дублируют: боевой pipeline остаётся единственным источником для попадания, урона, крита, осечки и износа, а прогрессия — единственным источником для уровня и штрафа. Числа штрафа — doc 05 §5.3.0.

## Verified

The current suite covers injected Overwatch movement reactions (including persisted reaction-state synchronization), armor wear/clamping, save-link rejection, shipped catalog loading, and distinct non-zero shipped ammo modifiers. Test counts live in [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md) §2 rather than being restated here, so this document cannot go stale on a number it does not own.
