# EDEN PROTOCOL

> Одиночная браузерная тактическая RPG в жанре пошагового постапокалипсиса для Яндекс.Игр.

**Elevator pitch:** прицельный пошаговый бой, база с крафтом, вылазки и герой, которого нельзя убить — но каждая смерть стоит.

## Статус проекта

> **Новый разработчик — начинать с [`docs/25-developer-handoff.md`](docs/25-developer-handoff.md).** Там фактическое состояние на HEAD `f72165c` (проверенное командами), тикеты передачи `H0`–`H6`, измеренные дефекты баланса и первые 10 действий. **Раздел ниже отстаёт от git** (устаревшие HEAD `3f87b80`, «не закоммичено», 147 тестов); фактически всё описанное как незакоммиченное находится в `origin`, локально зелёные 181 vitest и 76 Playwright теста, но **CI job `e2e` на HEAD красный**. Приведение этого раздела к факту — тикет `H0`.

**Текущий статус: M3-D release-readiness pass закоммичен и находится в `origin`.**

M3-D зафиксирован коммитом `61c991b feat(M3-D): harden runtime and release readiness`: combat hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser boundary и CI-бюджет бандла. HEAD ветки `main` = `3f87b80 docs: add delivery plan and developer work packages`, `origin/main` — на том же коммите.

Тикет `W0-01` при этом закрыт **частично**: работа выведена из единственной локальной копии, но рабочее дерево не чисто, ветки и PR не было, прогона CI на коммите `61c991b` нет, и M3-D зафиксирован одним коммитом вместо четырёх — разбор по критериям в [`docs/22`](docs/22-developer-work-packages.md) §`W0-01`.

В рабочем дереве есть незакоммиченные изменения тикета `W0-04` (единая команда `verify`, `engines.node`, `code/.nvmrc`, корневой CI-workflow переведён на `npm run verify` и `node-version-file`, инертный `code/.github/workflows/quality.yml` удалён), прохода `W0-02`/`W0-03`/`W0-05` и тикетов `W1-01`…`W1-05` (Playwright harness, DOM-тесты в jsdom, E2E happy path/failure/save/geometry, CI job `e2e`).

В `code/` реализованы одна зона, три data-driven encounter, runtime map switching через validated arena catalog, campaign progression, schema-v4 local save и responsive/a11y UX layer. **19 vitest files / 147 automated tests** (`npm test`, включая 19 DOM-тестов настоящего шелла в jsdom) и **7 Playwright files / 63 browser tests** в Chromium (`npm run test:e2e`) проходят локально. Статический бюджет бандла: initial JS 36.2 kB gzip (лимит 150), combat lazy JS 349.7 kB gzip (порог 1200) — фактический вывод `npm run analyze:budget` на 23 августа 2026; DOM- и E2E-инфраструктура на бандл не влияет (dev-only).

**Что проверено в браузере (`W1-01`…`W1-05`, 23 августа 2026):** полный happy path зоны из трёх encounter, exactly-once награда, поражение/отступление/retry, reload на пяти стадиях кампании, recovery при порче сохранения, гейтинг боевых горячих клавиш, и **измеренная** геометрия на 360×640 / 390×844 / 768×1024 / 1280×720 / 800×400 — горизонтального переполнения нет, все интерактивные элементы ≥44×44 px.

**Что не проверено:** runtime-производительность (`W1-06`), реальные устройства и тач-ввод (`W2-06`) — измерения `W1-05` сделаны в headless Chromium при заданном CSS-размере окна и device-тестом не являются, доступность с ассистивными технологиями, WebKit и Firefox, визуальный регресс (`W1-08`), платформенные интеграции. CI job `e2e` написан, но ни разу не выполнялся на GitHub Actions.

**Найденные дефекты, зафиксированные тестами и не исправленные:** главный CTA виден без прокрутки только на базе и только в портрете (`ОГОНЬ` на 360×640 — y≈2170 при высоте окна 640 px); неизвестный `arenaId` вне активного encounter не отклоняется валидатором. Подробности — [`docs/24-test-matrix-and-release-gates.md`](docs/24-test-matrix-and-release-gates.md) §7.2 и §3.3.

Это ещё **не готовый MVP**: отсутствуют 4 зоны, прогрессия персонажа, полный production-контент, финальная экономика, ассеты и платформенные интеграции. Первый публичный релиз планируется как полный MVP на 10–15 часов основного контента, desktop + mobile с первого playable.

## Утверждённые решения

- Combat MVP: 6 body parts, postures, statuses, Overwatch, armor/durability/malfunctions.
- Монетизация без P2W и без tempo-бонусов: только добровольная реклама за неигровую/несиловую награду и косметика, если это совместимо с платформой.
- Нарратив: «Время» как мета-антагонист и «Восход» как локальный источник миссий.
- `docs/04-combat-system.md` требует отдельного formula reconciliation с `code/src/game/combat.ts` до production.

## Запуск code prototype

```bash
cd code
npm install
npm run dev
```

Проверки — одной командой, воспроизводящей CI:

```bash
npm run verify
```

Она последовательно прогоняет `lint`, `typecheck`, `test`, `build` и `analyze:budget`; любой красный шаг делает красной всю команду. Шаги можно запускать и по отдельности теми же именами. Требуется Node ≥ 22 (`engines.node`); CI берёт версию из `code/.nvmrc` (`22`). Последний прогон `verify` выполнялся локально на уже установленном `node_modules` и на Node v24; на чистом `npm ci` и на Node 22 он не проверялся.

Браузерные E2E — отдельной командой, в `verify` намеренно не входят, чтобы `verify` не зависел от скачивания браузера:

```bash
npx playwright install chromium   # один раз
npm run test:e2e                  # 63 теста в Chromium, ~1.6 мин
npm run test:e2e:headed           # то же, но видно приложение
```

`test:e2e` сначала собирает свежий `dist/`, затем `playwright.config.ts` поднимает `vite preview` на порту 4317 с `reuseExistingServer: false`, чтобы уже запущенный preview-сервер не маскировал этот build. Трейс, скриншот и видео пишутся в `test-results/` только при падении.

`npm test` состоит из двух Vitest project: `node` (162 теста чистых функций, view-моделей и симулятора баланса) и `dom` (19 DOM-тестов настоящего шелла в jsdom). Запустить по отдельности — `npx vitest run --project node` и `npx vitest run --project dom`.

Симулятор баланса — отдельные команды, в `verify` не входят (они пишут файлы в `design-data/`):

```bash
npm run simulate:balance   # каждая encounter со снаряжением начала кампании
npm run simulate:economy   # проход по трём encounter подряд с переносом состояния
```

По умолчанию 200 боёв на encounter, seed `12345`, политика `cover-torso`. Флаги: `--runs`, `--seed`, `--policy`, `--mode isolated|chain`, `--turn-limit`, `--out`, `--no-write`. Отчёты (JSON + Markdown) пишутся в `design-data/balance/`. Симулятор считает бой **тем же** модулем, что игра, и не содержит ни одной собственной формулы.

Фактический локальный package baseline: Phaser 4.2.1, TypeScript, Preact, Vite, Vitest. Решение Phaser 3/4 для production ещё открыто; не путать его с утверждением старых документов.

## Документация

**Пакет разработки — начинать отсюда:**

0. [`docs/25-developer-handoff.md`](docs/25-developer-handoff.md) — handoff разработчику: проверенное состояние репозитория, граница MVP, иерархия источников истины, порядок работ, тикеты `H0`–`H6`, дефекты баланса `BAL-1`…`BAL-9`, правила ветвления и критики, гейты, внешне заблокированные пакеты, чек-лист первых 10 действий.
1. [`docs/21-delivery-plan-and-backlog.md`](docs/21-delivery-plan-and-backlog.md) — executive status, приоритеты P0/P1/P2, 8-недельный последовательный план, зависимости, риски, DoR/DoD, гейты G0–G5 и решения, требуемые от владельца продукта.
2. [`docs/22-developer-work-packages.md`](docs/22-developer-work-packages.md) — 60 реализуемых тикетов/ТЗ в пакетах W0–W10 с целями, границами scope, контрактами API, критериями приёмки, тестами и требованиями к commit/PR.
3. [`docs/23-data-contracts-and-content-pipeline.md`](docs/23-data-contracts-and-content-pipeline.md) — схемы контента, версионирование, cross-reference валидация, контракт сохранения и миграции, RNG/детерминизм, владение данными, процесс автора контента.
4. [`docs/24-test-matrix-and-release-gates.md`](docs/24-test-matrix-and-release-gates.md) — фактическое покрытие, DOM/E2E уровни, матрица устройств, ручные скрипты, бюджеты производительности, проверки доступности, severity дефектов, гейты.

**Дизайн и scope:**

5. [`docs/00-index.md`](docs/00-index.md) — оглавление, статусы, approved decisions и source of truth.
6. [`docs/00-critical-audit.md`](docs/00-critical-audit.md) — read-only аудит и P0/P1.
7. [`docs/20-mvp-scope-and-roadmap.md`](docs/20-mvp-scope-and-roadmap.md) — scope первого публичного релиза.
8. [`docs/04-combat-system.md`](docs/04-combat-system.md) — полный combat scope; числа — в [`docs/04-combat-formula-reconciliation.md`](docs/04-combat-formula-reconciliation.md).
9. [`docs/09-base-and-home-systems.md`](docs/09-base-and-home-systems.md), [`docs/10-exploration-and-zones.md`](docs/10-exploration-and-zones.md), [`docs/11-enemies-and-ai.md`](docs/11-enemies-and-ai.md), [`docs/12-economy-and-balance.md`](docs/12-economy-and-balance.md).
10. [`docs/13-narrative-and-setting.md`](docs/13-narrative-and-setting.md), [`docs/14-ui-ux-and-art-direction.md`](docs/14-ui-ux-and-art-direction.md), [`docs/15-audio-design.md`](docs/15-audio-design.md), [`docs/16-monetization.md`](docs/16-monetization.md).
11. [`docs/17-engineering-tdd.md`](docs/17-engineering-tdd.md), [`docs/18-qa-test-plan.md`](docs/18-qa-test-plan.md), [`docs/19-art-and-design-brief.md`](docs/19-art-and-design-brief.md).

> **Важно:** документы 13 (нарратив), 15 (аудио) и 19 (арт) — это направления и требования, а **не** реализуемые спецификации. Для каждого нужен отдельный implementation spec с конкретными id, форматами, размерами, лицензиями и fallback, а также фактическая поставка ассетов, прежде чем пакеты W7-03/W7-04, W9-01/W9-02 и W8-03…W8-05 могут стартовать. Подробности — doc 22 §«Сводка блокировок».

Старые документы сохранены и не удалены; их применимость определяется порядком source of truth в индексе.

## Реалистичный roadmap

Детальный план — [`docs/21-delivery-plan-and-backlog.md`](docs/21-delivery-plan-and-backlog.md). Кратко:

1. **Неделя 1 — стабилизация, без новых механик:** закоммитить M3-D ✅, поднять браузерный E2E harness ✅, провести первую ручную mobile QA (не сделано), запустить симулятор баланса ✅, вычистить непроверенные утверждения из документов ✅.
2. **Неделя 2:** ввод, доступность, mobile-геометрия.
3. **Неделя 3:** баланс и экономика по данным симулятора ✅ (измерения получены), balance lock v1 — ждёт решения владельца.
4. **Неделя 4:** прогрессия персонажа и save schema v5.
5. **Неделя 5:** база, инвентарь, крафт до MVP-объёма.
6. **Неделя 6:** реальный objective runtime, AI, roster 6 врагов.
7. **Неделя 7:** 4 зоны, туториал, design tokens и asset registry, настройки.
8. **Неделя 8:** платформа, релизный процесс, hardening до release candidate.

Арт, аудио и платформенные интеграции не входят в этот объём до поступления implementation specs и ассетов.

## Репозиторий

```text
eden/
├── README.md
├── docs/           ← живая Game Bible + пакет разработки 21–24
├── code/           ← существующий combat prototype (Phaser + Preact + TS)
├── design-data/    ← отчёты симулятора баланса (есть), perf и ручной QA (нет)
├── art/            ← исходники ассетов и их реестр (пуст, ассетов нет)
└── .github/        ← CI workflow (lint/typecheck/test/build/budget)
```

Назначение, структура и правила именования — в [`design-data/README.md`](design-data/README.md) и [`art/README.md`](art/README.md). `design-data/balance/` заполнен первыми отчётами симулятора (`W3-01`, 23 августа 2026); `perf/` и `qa/` вводятся в `W1-06` и `W2-06`. `art/` создан тикетом `W0-03` и **пуст**, наполняется в `W8-02`; production-ассетов в репозитории нет ни одного.

**Состояние рабочих изменений:** M3-D закоммичен и отправлен (`61c991b`), `W0-01` закрыт частично — рабочее дерево не чисто, ветки/PR и прогона CI на коммите не было. В рабочем дереве не закоммичены: тикет `W0-04`, проход `W0-02`/`W0-03`/`W0-05` и симулятор баланса `W3-01`…`W3-03` вместе с его отчётами.
