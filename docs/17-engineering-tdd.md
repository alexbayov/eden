# 17 — Engineering TDD

**Статус:** M3-D performance pass implemented; initial JS budget is automated, browser E2E/performance and manual mobile QA unverified, 18 августа 2026.

## Фактическое M3-B состояние

- В runtime есть одна data-driven зона с тремя encounter, validated map catalog и переключение карт по `arenaId`.
- Campaign/save flow сохраняет progression и migration v3→v4; exactly-once reward claim гарантируется только в нормальном application flow.
- Offline `localStorage` save защищён от corruption и обычных flow-ошибок: malformed shape, неизвестные campaign/item/equipment IDs, невозможные stack/weight/count/durability/slot/link значения отклоняются. Это **не** tamper-resistance: пользователь может вручную откатить или изменить localStorage.
- Anti-tamper и authoritative leaderboards требуют будущего authoritative cloud/server save; это не часть текущего M3-B.
- M3-B strict runtime-catalog save validation подтверждена; browser E2E and performance QA остаются pending.
- M3-C ships its CSS as the first shipped change in the application bundle. Tactical controls are model-driven: weapon maintenance is gated by player turn and domain preconditions; the narrow-phone move recommendation cap is application behavior at `<=430px`, not CSS clipping.
- Phaser and `TacticalScene` are lazy-loaded behind the combat runtime boundary; base, home, and mission-select initial entry does not statically include Phaser. CI checks initial JS at `<=150 kB` gzip; combat lazy JS is reported and checked with a separate `1200 kB` gzip threshold.
- M3-C browser geometry, 390x844 rendering, and manual mobile/browser QA are unverified. Static CSS and view-model tests do not establish rendered geometry or device interaction.

## Реализованные инженерные инварианты

- `game/combat.ts` owns the sole pure attack transition and injected rolls.
- Hero, enemy, and Overwatch shots use `combatAttack` / `performCombatAttack`.
- Live armor durability is reduced and clamped by the affected equipped armor instance.
- Save validation requires runtime campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, catalog-backed item stacks, equipment IDs/slots and combat-to-inventory links; malformed saves return validation errors instead of crashing runtime.
- Base repair operates on the selected weapon or damaged armor instance and synchronizes the linked combat state.
- Equipment content validates bounded modifiers and ships distinct non-zero ammo examples.

Automated suite: 17 files / 128 tests. Final gate commands: `lint`, `typecheck`, `test`, `build`, and `analyze:budget`; browser E2E, geometry verification, performance profiling, and manual mobile QA remain unverified.
