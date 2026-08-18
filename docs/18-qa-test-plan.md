# 18 — QA Test Plan

**Статус:** M3-B strict save validation подтверждена; browser E2E/performance pending, 17 августа 2026.

## Реализованное и автоматически проверяемое

- **11 test files / 66 tests**: combat, content, save/reload, session, campaign, inventory/base, M3-B catalog/progression и shipped runtime fixtures.
- Production boot сначала загружает и валидирует zone/mission/reward/item/equipment/arena catalogs; при отсутствии save начальная campaign создаётся только из первого доступного encounter активного каталога.
- Save contract сохраняет schema v4: v3→v4 migration и legacy-default migration используют переданный validated catalog, а v4 saves проходят strict cross-field validation без изменения schema version.
- Проверяются существование campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, item stack IDs/weights/counts, equipment IDs/slots/durability и combat-to-inventory links, quick slots и unknown-ID rejection; malformed save возвращает validation error вместо runtime crash.
- Интеграционные tests получают карту через `mission.arenaId` активного validated mission catalog, проверяя catalog links, lock ordering, failed retry, exactly-once reward и reload at available/active/completed stages.
- Exactly-once означает только normal application flow. LocalStorage не является tamper-proof: ручной rollback/edit не блокируется; anti-tamper и authoritative leaderboards требуют будущего cloud/server save.

## Gate и ручная QA

M3-B strict save-validation checks подтверждены; browser E2E и performance QA остаются pending. Browser/device E2E, accessibility walkthrough, visual regression и ручной проход Mission Select/Phaser runtime-switching всех encounter maps не заменяются unit/integration fixtures.

- Performance profiling and resolution of the current production bundle-size warning.
- Commands: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`.
