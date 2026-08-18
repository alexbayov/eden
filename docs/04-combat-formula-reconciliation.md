# 04 — Combat Formula Reconciliation

**Статус:** реализовано, 17 августа 2026.

## Authoritative pipeline

`code/src/game/combat.ts` exposes the sole shot transition: `combatAttack` / `performCombatAttack`. Every resolved shot receives injected rolls and applies AP, magazine, weapon durability, malfunction, ammo modifiers, penetration, hit, crit, body-part status, HP, and live armor wear.

A valid trigger attempt spends AP, one round, and `durabilityPerShot`. A malfunction stops projectile resolution after those costs. Armor loses its affected body-part protection value per hit, clamped to zero; at zero it mitigates no damage.

Overwatch is resolved during enemy movement only when an enemy crosses from no LOS into LOS. It makes one torso reaction through the same pipeline, consumes the hero's reserved state, ammunition and weapon durability, and records a resolution log only after an actual action result.

## Persistence contract

Player combat `weaponState` and `armor` IDs, item IDs, slots, durability, and maximum durability must exactly match their inventory equipment instances. Schema-v3 saves that are structurally valid but divergent are rejected; only legacy schema migration may normalize data.

## Verified

The current 11-file / 66-test suite covers injected Overwatch movement reactions (including persisted reaction-state synchronization), armor wear/clamping, save-link rejection, shipped catalog loading, and distinct non-zero shipped ammo modifiers.
