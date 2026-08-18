# 18 — QA Test Plan

**Статус:** M3-C UX remediation implemented; browser E2E/performance and manual mobile QA unverified, 18 августа 2026.

## Реализованное и автоматически проверяемое

- **15 test files / 121 tests**: combat, content, save/reload, session, campaign, inventory/base, M3-B catalog/progression, shipped runtime fixtures, and M3-C boot/combat-view/responsive contracts.
- Production boot сначала загружает и валидирует zone/mission/reward/item/equipment/arena catalogs; при отсутствии save начальная campaign создаётся только из первого доступного encounter активного каталога.
- Save contract сохраняет schema v4: v3→v4 migration и legacy-default migration используют переданный validated catalog, а v4 saves проходят strict cross-field validation без изменения schema version.
- Проверяются существование campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, item stack IDs/weights/counts, equipment IDs/slots/durability и combat-to-inventory links, quick slots и unknown-ID rejection; malformed save возвращает validation error вместо runtime crash.
- Интеграционные tests получают карту через `mission.arenaId` активного validated mission catalog, проверяя catalog links, lock ordering, failed retry, exactly-once reward и reload at available/active/completed stages.
- M3-C CSS is the first shipped change in the application bundle. The suite verifies the imported stylesheet, control-size declarations, non-hover affordances, responsive rules, boot-state selection, and combat view-model policies. This is not a browser geometry assertion.
- At `<=430px`, the app supplies the compact four-destination recommended-move policy; the complete legal move set remains reachable through disclosure.

## Gate и ручная QA

M3-C automated checks are confirmed; browser E2E, performance, visual regression, accessibility walkthrough, and manual mobile/browser QA remain unverified. No actual 390x844 rendered test or browser-geometry claim has been made. Browser/device E2E and ручной проход Mission Select/Phaser runtime-switching всех encounter maps не заменяются unit/integration fixtures.

- Performance profiling and resolution of the current production bundle-size warning.
- Commands: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`.
