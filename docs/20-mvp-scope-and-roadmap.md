# 20 — MVP Scope & Roadmap

**Статус:** сверено с кодом 24 августа 2026. M3-D performance pass implemented and committed (`61c991b`, в `origin`); strict save validation and deterministic balance bounds confirmed, initial bundle budget automated; browser E2E поднят и зелёный локально (`W1-01`…`W1-05`), runtime performance и ручная device QA — **pending**.

> **Числа набора устарели, правка 26 августа 2026.** Приведённые ниже значения относятся к 24 августа и не учитывают пакеты `W5`, `W6`, `W7-02`, `W7-05`. Актуально: **37 файлов / 526 тестов**, **12 файлов / 124 E2E**, save schema **v6**, initial JS 57.4 kB gzip, CI зелёный. Владелец чисел — [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md) §1; при расхождении верен он, а не этот абзац.

**Разрыв до полного MVP — пересчитан 26 августа 2026.** Прежняя формулировка («1 зона из 4, 3 архетипа врага из 6, 2 ресурса из 8, 1 рецепт, 1 улучшение базы, без навыков, без туториала…») устарела по шести пунктам из восьми:

| Было в разрыве | Фактически на 26 августа 2026 |
|---|---|
| 3 архетипа врага из 6 | **6 из 6** (`W6-06`) |
| 1 рецепт | **7 рецептов** (`W5-02`) |
| 1 улучшение базы | **3 узла × 3 уровня** (`W5-01`) |
| без туториала | **онбординг реализован** (`W7-05`) |
| 2 ресурса из 8 | 3 в обороте (`metal`, `cloth`, `mechanics`); лимит 8 не достигнут и не является целью сам по себе |
| цели миссий как подпись | **четыре типа целей резолвятся** (`W6-01`) |

**Что действительно осталось в разрыве:** 1 зона из 4 (`W7-01`, блокируется решением **D-03**), навыки/SPECIAL/перки (`W4-03`/`W4-04`, решение **D-02**), финальная миссия, нарратив (`W7-03`/`W7-04` — нет контент-спеки), ассеты, аудио и платформенные интеграции (`W8`–`W10` — нет ассетов, звуковых файлов, API). То есть **всё оставшееся заблокировано внешне**, а не объёмом работ. **Реализовано 24 августа 2026 и проверено набором, ожидает только финального critic-прохода:** прогрессия уровней L1–L6 (`W4-01`), единый XP-штраф смерти (`W4-02`), сохранение schema v5 с миграцией v4→v5 (`W4-05`). `npm test` — 23 файла / **263 теста, все зелёные**, `npm run verify` проходит (exit 0); прежняя запись «красный, 259 из 260, падает `combat-shell.dom.test.tsx`» **неверна и снята**. Полностью закрытым пакет всё же не называется: critic-прохода не было, а решение D-01 владельцем не принято, поэтому вариант штрафа остаётся решением реализации. **Не реализовано и остаётся в разрыве:** навыки, SPECIAL и перки (`W4-03`/`W4-04`, решение D-02) и лут-штраф с рюкзака (`W5-05`) — поражение не отнимает ни ресурсы, ни предметы. Порядок закрытия остатка — [`21-delivery-plan-and-backlog.md`](21-delivery-plan-and-backlog.md).

**Балансовый контекст.** Числа, на которых стоит прогрессия, — **предложение** balance lock v1 (`W3-04`), а не утверждённый lock: пометка alpha values в doc 12 сохранена, D-01 и D-03 не приняты. Открытым остаётся один нарушенный инвариант живучести: критический выстрел `pm`/`hornet` через стартовый жилет убивает героя с одного попадания (30 урона против 24 maxHp) на всех трёх аренах; вместо ложного утверждения он зафиксирован точным waiver-набором `KNOWN_ONE_SHOT_WAIVERS` (`W3-05`).

## Фактический M3-B scope

- Одна data-driven зона «Ближняя окраина» с тремя последовательными encounter-миссиями.
- Versioned runtime content validation и cross-reference checks для zone, encounter, rewards, items, equipment и карт.
- Production initialization загружает и валидирует catalogs до создания campaign/save; boot без сохранения выбирает первый доступный encounter динамически из validated catalog.
- Campaign progress со статусами locked/available/active/completed/failed, lock ordering, return to base, retry после defeat, явное combat-отступление без награды и exactly-once rewards в normal application flow.
- Global combat shortcuts принимаются только на active mission player-turn; save contract отклоняет невозможные phase/screen combinations до resume.
- HP/statuses живого героя переходят между encounter, а defeat/retry восстанавливает mission template. Медотсек лечит persistent HP и не маскирует статусы.
- Relay defender ограничен deterministic damage bound: critical torso hit через starter vest не может one-shot 24-HP героя на difficulty 1. **Граница держится только для defender:** `W3-05` расширил проверку на все арены и обнаружил, что для `pm`/`hornet` инвариант **нарушен** (см. балансовый контекст выше).
- Save/reload campaign stages и migration v3→v4→v5: active encounter/map, campaign zone/status, XP, уровень/очки навыков, first-death flag, `returnReason`, item/equipment IDs, stack values, quick slots и equipment links проверяются against loaded runtime catalogs. Ключ `eden.save.v5`; payload под прошлым ключом `eden.save.v4` читается, миграется и перезаписывается под новым ключом на boot, старый ключ не удаляется.
- Прогрессия L1–L6 как контент (`public/config/progression.json`, пороги `0 / 40 / 90 / 155 / 235 / 330` XP): уровень и прогресс до следующего видны на базе и на экране награды, очки навыков начисляются и персистятся (тратить их нечем до `W4-03`). Шиппящийся контент покрывает **3 уровня из 6** — полное прохождение зоны даёт 135 XP, то есть L3; полосы L4–L6 контентом не обеспечены.
- Phaser runtime uses a lazy combat boundary: base/home/mission-select initial entry does not include Phaser or `TacticalScene`; entering `campaign.screen === "mission"` loads the runtime and cleanup destroys it on exit.
- Initial JavaScript has a CI budget of `150 kB` gzip maximum. Combat lazy JavaScript is reported separately with a `1200 kB` gzip threshold; Phaser is intentionally not counted against the initial budget as if it were an entry chunk.
- Local offline save защищён от corruption и обычных flow-ошибок валидацией, но не защищён от ручного rollback/edit в localStorage. Anti-tamper и authoritative leaderboards требуют будущего cloud/server save.
- **Code implementation coverage:** фактические числа тестов — в [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md) §1–2, а не здесь: этот документ не владеет этой цифрой и не должен на ней устаревать. Покрываются catalog contracts, save migration/validation (v3→v4→v5), map lookup, кривая XP и штраф смерти, M3-C UX contracts и M3-D input/retreat/balance/persistence regressions.

## Gate

**M3-D performance gate:** initial bundle budget is automated; browser E2E and runtime performance QA remain pending.

## Ручная browser QA, не заявленная как implementation coverage

- Browser/device E2E, accessibility walkthrough и visual regression.
- Ручная проверка Mission Select, Phaser rendering и переключения всех encounter maps в настоящем браузере; это не покрывается unit/integration runtime fixtures.
- Performance profiling and browser/device verification remain pending; the static production bundle budget is covered by CI.

## За пределами M3-B alpha

- Вторая зона, открытый мир, procedural maps, non-combat routes и repeatable contracts.
- Новые objective mechanics: единственное условие победы в коде — `victoryFor` (все враги мертвы); `secure` является только подписью цели и завершается той же зачисткой. Реальный objective runtime — `W6-01`.
- Навыки, SPECIAL и перки: очки навыков начисляются за уровень и персистятся, но **потратить их нечем** (`W4-03`, `W4-04`, решение D-02). Уровень пока не влияет ни на одну боевую формулу.
- Штраф смерти реализован **только по XP** (`W4-02`): первая смерть бесплатна, далее 15% от XP до следующего уровня (с нижним клампом в 1 XP и нулём, если игрок стоит ровно на пороге), уровень не понижается, XP не уходит в минус, эскалации нет. Фактический размер невелик: максимум **8 XP** в пределах достижимого на шиппящемся контенте XP, **14 XP** на потолке кривой. Ресурсы и предметы поражение **не отнимает** — лут-штраф это `W5-05`. Отступление и поражение имеют явно различающиеся последствия. Точная формула — doc 05 §5.3.0; решение D-01 владельцем не принято, реализован консервативный вариант.
- Уровни выше L6: `MAX_SUPPORTED_LEVEL = 6`, контент с большим числом уровней отклоняется валидацией.
- Energy, ads, premium currency и любые monetization mechanics.
- Аудио-слой и production-арт: в репозитории нет ни звуковых файлов, ни ассетов (docs 15, 19).
