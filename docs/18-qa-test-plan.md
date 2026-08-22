# 18 — QA Test Plan

**Статус:** M3-D performance pass implemented and committed (`61c991b`); initial bundle budget automated, browser E2E/performance and manual mobile QA unverified, 18 августа 2026. Матрица тестов и релизные гейты — [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md).

## Реализованное и автоматически проверяемое

- **17 test files / 128 tests**: combat, content, save/reload, session, campaign, inventory/base, M3-B catalog/progression, shipped runtime fixtures, M3-C boot/combat-view/responsive contracts, and M3-D state/retreat/balance/persistence regressions.
- Production boot сначала загружает и валидирует zone/mission/reward/item/equipment/arena catalogs; при отсутствии save начальная campaign создаётся только из первого доступного encounter активного каталога.
- Save contract сохраняет schema v4: v3→v4 migration и legacy-default migration используют переданный validated catalog, а v4 saves проходят strict cross-field validation без изменения schema version. `home`/`mission-select` принимают только `player`; `mission` принимает только `player`/`enemy`; terminal `victory`/`defeat` допустимы только на явных `reward`/`return` экранах.
- Проверяются существование campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, item stack IDs/weights/counts, equipment IDs/slots/durability и combat-to-inventory links, quick slots и unknown-ID rejection; malformed save возвращает validation error вместо runtime crash.
- Интеграционные tests получают карту через `mission.arenaId` активного validated mission catalog, проверяя catalog links, lock ordering, failed retry, exactly-once reward и reload at available/active/completed stages.
- M3-C CSS is the first shipped change in the application bundle. The suite verifies the imported stylesheet, control-size declarations, non-hover affordances, responsive rules, boot-state selection, and combat view-model policies. This is not a browser geometry assertion.
- Глобальные `E`/`O`/`1–6` принимаются только на `campaign.screen === mission` в player-фазе; regression проверяет, что `E` на home не запускает enemy resolution и не меняет HP героя.
- Из боя есть явное `Отступить без награды`: оно переводит active encounter в failed/return и недоступно лишь на enemy transition. При пустом магазине и резерве UI показывает причину и этот выход.
- Релейный defender uses bounded AKM damage: even a critical torso hit through the starter vest is below the 24-HP starting hero; deterministic regression covers the bound.
- HP и статусы живого героя переносятся между encounter через hydration; после defeat retry получает HP/statuses из mission template. Медотсек лечит HP на базе и не снимает боевые статусы.
- CI runs `npm ci` and `npm run verify`, который последовательно выполняет `lint`, `typecheck`, `test`, `build` и `analyze:budget` (тикет `W0-04`).
- Initial entry JavaScript is budgeted at `<=150 kB` gzip. Phaser and `TacticalScene` are lazy combat chunks and are reported separately; the current combat threshold is `1200 kB` gzip and is not treated as an unrealistic total Phaser budget.

## Gate и ручная QA

M3-C automated checks and the M3-D initial bundle budget are confirmed; browser E2E, performance profiling, visual regression, accessibility walkthrough, and manual mobile/browser QA remain unverified. No actual 390x844 rendered test or browser-geometry claim has been made. Browser/device E2E and ручной проход Mission Select/Phaser runtime-switching всех encounter maps не заменяются unit/integration fixtures.

- Browser profiling remains unverified; the build budget is a static gzip gate, not a substitute for runtime performance measurement.
- Command: `npm run verify` из `code/`. Отдельные шаги: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, `npm run analyze:budget`.
- Фактический вывод `analyze:budget` на 22 августа 2026: initial JS 36.2 kB gzip (лимит 150), combat lazy JS 349.7 kB gzip (порог 1200).
- Отчёты ручной QA складываются в `design-data/qa/` по правилам [`design-data/README.md`](../design-data/README.md); на 22 августа 2026 отчётов нет ни одного.
