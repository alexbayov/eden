# 20 — MVP Scope & Roadmap

**Статус:** M3-D performance pass implemented; strict save validation and deterministic balance bounds confirmed, initial bundle budget automated, browser E2E/performance pending, 18 августа 2026.

## Фактический M3-B scope

- Одна data-driven зона «Ближняя окраина» с тремя последовательными encounter-миссиями.
- Versioned runtime content validation и cross-reference checks для zone, encounter, rewards, items, equipment и карт.
- Production initialization загружает и валидирует catalogs до создания campaign/save; boot без сохранения выбирает первый доступный encounter динамически из validated catalog.
- Campaign progress со статусами locked/available/active/completed/failed, lock ordering, return to base, retry после defeat, явное combat-отступление без награды и exactly-once rewards в normal application flow.
- Global combat shortcuts принимаются только на active mission player-turn; save contract отклоняет невозможные phase/screen combinations до resume.
- HP/statuses живого героя переходят между encounter, а defeat/retry восстанавливает mission template. Медотсек лечит persistent HP и не маскирует статусы.
- Relay defender ограничен deterministic damage bound: critical torso hit через starter vest не может one-shot 24-HP героя на difficulty 1.
- Save/reload campaign stages и migration v3→v4: active encounter/map, campaign zone/status, XP, first-death flag, item/equipment IDs, stack values, quick slots и equipment links проверяются against loaded runtime catalogs.
- Phaser runtime uses a lazy combat boundary: base/home/mission-select initial entry does not include Phaser or `TacticalScene`; entering `campaign.screen === "mission"` loads the runtime and cleanup destroys it on exit.
- Initial JavaScript has a CI budget of `150 kB` gzip maximum. Combat lazy JavaScript is reported separately with a `1200 kB` gzip threshold; Phaser is intentionally not counted against the initial budget as if it were an entry chunk.
- Local offline save защищён от corruption и обычных flow-ошибок валидацией, но не защищён от ручного rollback/edit в localStorage. Anti-tamper и authoritative leaderboards требуют будущего cloud/server save.
- **Code implementation coverage:** 17 test files / 128 automated tests проверяют catalog contracts, save migration/validation, map lookup, progression, M3-C UX contracts и M3-D input/retreat/balance/persistence regressions.

## Gate

**M3-D performance gate:** initial bundle budget is automated; browser E2E and runtime performance QA remain pending.

## Ручная browser QA, не заявленная как implementation coverage

- Browser/device E2E, accessibility walkthrough и visual regression.
- Ручная проверка Mission Select, Phaser rendering и переключения всех encounter maps в настоящем браузере; это не покрывается unit/integration runtime fixtures.
- Performance profiling and browser/device verification remain pending; the static production bundle budget is covered by CI.

## За пределами M3-B alpha

- Вторая зона, открытый мир, procedural maps, non-combat routes и repeatable contracts.
- Новые objective mechanics: `secure` пока использует существующую eliminate-all combat resolution.
- Energy, ads, premium currency и любые monetization mechanics.
