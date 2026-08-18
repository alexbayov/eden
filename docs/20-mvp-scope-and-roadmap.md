# 20 — MVP Scope & Roadmap

**Статус:** M3-B runtime alpha; strict save validation confirmed, browser E2E/performance pending, 17 августа 2026.

## Фактический M3-B scope

- Одна data-driven зона «Ближняя окраина» с тремя последовательными encounter-миссиями.
- Versioned runtime content validation и cross-reference checks для zone, encounter, rewards, items, equipment и карт.
- Production initialization загружает и валидирует catalogs до создания campaign/save; boot без сохранения выбирает первый доступный encounter динамически из validated catalog.
- Campaign progress со статусами locked/available/active/completed/failed, lock ordering, return to base, retry после defeat и exactly-once rewards в normal application flow.
- Save/reload campaign stages и migration v3→v4: active encounter/map, campaign zone/status, XP, first-death flag, item/equipment IDs, stack values, quick slots и equipment links проверяются against loaded runtime catalogs.
- Phaser runtime использует единый validated arena catalog; при смене encounter загружается соответствующая карта и уничтожается stale scene state.
- Local offline save защищён от corruption и обычных flow-ошибок валидацией, но не защищён от ручного rollback/edit в localStorage. Anti-tamper и authoritative leaderboards требуют будущего cloud/server save.
- **Code implementation coverage:** 11 test files / 66 automated tests проверяют catalog contracts, save migration/validation, map lookup, progression и runtime fixtures.

## Gate

**M3-B strict save validation подтверждена. Browser E2E/performance QA остаются pending; текущий slice не является полным MVP.

## Ручная browser QA, не заявленная как implementation coverage

- Browser/device E2E, accessibility walkthrough и visual regression.
- Ручная проверка Mission Select, Phaser rendering и переключения всех encounter maps в настоящем браузере; это не покрывается unit/integration runtime fixtures.
- Performance profiling, production bundle budget, final art/audio.

## За пределами M3-B alpha

- Вторая зона, открытый мир, procedural maps, non-combat routes и repeatable contracts.
- Новые objective mechanics: `secure` пока использует существующую eliminate-all combat resolution.
- Energy, ads, premium currency и любые monetization mechanics.
