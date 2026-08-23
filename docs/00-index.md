# EDEN PROTOCOL — Game Bible

> Живой русскоязычный production-документ. Рабочее название проекта.

**Владелец продукта:** Alex Bayov
**Документатор:** Lindy
**Целевая платформа:** Яндекс.Игры, desktop + mobile
**Модель:** single-player; асинхронные лидерборды и платформенные интеграции — после проверки совместимости.

## Source-of-truth order

1. Явные утверждённые решения владельца и таблица ниже.
2. [`20-mvp-scope-and-roadmap.md`](20-mvp-scope-and-roadmap.md) — scope первого публичного релиза.
3. [`21-delivery-plan-and-backlog.md`](21-delivery-plan-and-backlog.md) — порядок работ, приоритеты и релизные гейты; [`22-developer-work-packages.md`](22-developer-work-packages.md) — реализуемые ТЗ; [`23-data-contracts-and-content-pipeline.md`](23-data-contracts-and-content-pipeline.md) — контракты данных; [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md) — проверки и гейты.
4. Production-документы 09–19 и [`13-narrative-and-setting.md`](13-narrative-and-setting.md).
5. [`04-combat-formula-reconciliation.md`](04-combat-formula-reconciliation.md) — authoritative v1.0 numerical combat contract for the prototype.
6. Старые 01–08 и [`13-narrative-antagonist-options.md`](13-narrative-antagonist-options.md) — исторический/детальный материал, не удалённый и действующий только без конфликта.
7. `code/` — источник фактического поведения **combat prototype**, реализующий reconciliation v1.0 в пределах текущего scope.

**М3-B:** strict save validation подтверждена; browser E2E и performance QA остаются pending. Фактический slice: одна зона, три encounter, runtime map switching и campaign/save flow. Exactly-once действует только в normal application flow. LocalStorage save защищён от corruption и обычных flow-ошибок, но не от ручного rollback/edit; anti-tamper и authoritative leaderboards требуют будущего cloud/server save.

**M3-D:** release-readiness pass реализован (combat hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser loading, root-CI bundle budget). **W1-01…W1-05, W3-01…W3-03:** 21 vitest file / 181 test (19 файлов / 162 теста static, pure-model и симулятор баланса + 2 файла / 19 DOM-тестов настоящего шелла в jsdom) и 7 Playwright files / 76 browser tests в Chromium — все зелёные локально. Впервые проверены в реальном браузере: полный happy path зоны, reward-поток, reload-сценарии и измеренная геометрия на пяти viewport × пяти экранах (включая `reward` и `return`).

> **Фактическое состояние на 22 августа 2026: работа M3-D закоммичена и отправлена в `origin`** коммитом `61c991b feat(M3-D): harden runtime and release readiness`; тикет `W0-01` закрыт **частично** (рабочее дерево не чисто, ветки и PR не было, прогона CI на `61c991b` нет, один коммит вместо четырёх — разбор в [`22-developer-work-packages.md`](22-developer-work-packages.md) §`W0-01`). HEAD ветки `main` и `origin/main` = `3f87b80 docs: add delivery plan and developer work packages`. В рабочем дереве остаётся незакоммиченным тикет `W0-04` (единая команда `verify`, `engines.node`, `.nvmrc`, корневой CI-workflow переведён на `npm run verify` и `node-version-file`, инертный `code/.github/workflows/quality.yml` удалён), текущий проход `W0-02`/`W0-03`/`W0-05` и симулятор баланса `W3-01`…`W3-03` вместе с отчётами в `design-data/balance/`.

Фактический вывод `npm run analyze:budget` на 22 августа 2026: initial JS 36.2 kB gzip при лимите 150, combat lazy JS 349.7 kB gzip при пороге 1200. Это статические gzip-гейты, а не измерение runtime-производительности.

Browser E2E, rendered geometry (включая 390×844), runtime performance и ручная mobile/browser QA **не проводились**. Статические CSS/view-model тесты не устанавливают ни геометрию рендера, ни поведение на устройстве.

**Отдельные implementation specs обязательны.** [`13-narrative-and-setting.md`](13-narrative-and-setting.md), [`15-audio-design.md`](15-audio-design.md) и [`19-art-and-design-brief.md`](19-art-and-design-brief.md) — это направления и требования, а **не** реализуемые спецификации. Пакеты W7-03/W7-04 (нарративный контент), W9-01/W9-02 (аудио) и W8-03…W8-05 (арт-интеграция) не могут стартовать до появления отдельных implementation specs и фактической поставки ассетов с проверенными лицензиями. Каталог `art/` создан тикетом `W0-03` и **пуст**; наполняется в `W8-02`. В `design-data/` появился первый фактический вывод — `balance/` с отчётами симулятора (`W3-01`, 23 августа 2026); `perf/` и `qa/` по-прежнему отсутствуют и вводятся в `W1-06` и `W2-06`. Ни одного production-ассета (арт, иконки, звук) в репозитории нет.

## Approved decisions

| Решение | Зафиксировано |
|---|---|
| Первый публичный релиз | полный MVP на 10–15 часов основного контента |
| Платформа | desktop + mobile с первого playable |
| Combat scope | 6 body parts, postures, statuses, Overwatch, armor/durability/malfunctions в планируемом MVP |
| Монетизация | без P2W и tempo-бонусов; только opt-in реклама за неигровую/несиловую награду и косметика, если совместимо с платформой |
| Нарратив | A «Время» — мета-антагонист; B «Восход» — локальный источник миссий |
| Движок/UI | фактический prototype: Phaser 4.2.1 + TypeScript, Preact; решение Phaser 3/4 открыто |
| Код | `code/` — combat prototype, не production MVP |

## Структура и статусы

| Файл | Статус | Назначение |
|---|---|---|
| [00-critical-audit](00-critical-audit.md) | 🟡 browser E2E/performance не проводились | read-only аудит, P0/P1 и правила истины |
| [01-vision-and-pillars](01-vision-and-pillars.md) | 🟢 v0.2 | vision и столпы |
| [01-critic-vision](01-critic-vision.md) | 🟢 v0.1 | критика vision |
| [02-critic-engine](02-critic-engine.md) | 🟢 v0.1 | историческая критика движка |
| [03-core-gameplay-loop](03-core-gameplay-loop.md) | 🟡 v0.1 | старый baseline loop, требует сверки с MVP |
| [03-critic-loop](03-critic-loop.md) | 🟢 v1.0 | critic loop и review gates |
| [04-combat-system](04-combat-system.md) | 🟡 v0.2 | полный combat design; числа — в reconciliation |
| [04-combat-formula-reconciliation](04-combat-formula-reconciliation.md) | 🟢 v1.0 | authoritative combat formulas, mapping docs→code→tests |
| [04-critic-combat](04-critic-combat.md) | 🟢 v0.1 | историческая критика боя |
| [05-character-and-progression](05-character-and-progression.md) | 🟡 v0.2 | детальная прогрессия; baseline до баланса |
| [06-weapons-and-modifications](06-weapons-and-modifications.md) | 🟡 v0.2 | каталог оружия; scope урезается 20 |
| [07-inventory-and-equipment](07-inventory-and-equipment.md) | 🟡 v0.2 | инвентарь; monetization QoL перепроверить |
| [08-crafting-and-resources](08-crafting-and-resources.md) | 🟡 v0.2 | крафт; платные элементы отменены 16 |
| [09-base-and-home-systems](09-base-and-home-systems.md) | 🟡 реализован M2-слайс, не MVP | целевой base MVP; в коде — hub на один рецепт, одно улучшение, medbay и ремонт |
| [10-exploration-and-zones](10-exploration-and-zones.md) | 🟡 реализована 1 зона из 4 | цель — 4 зоны релиза; в коде одна зона «Ближняя окраина» на 3 encounter |
| [11-enemies-and-ai](11-enemies-and-ai.md) | 🟡 3 архетипа из 6 | decision model; roster неполный, elite-lite — тюнинг данных, не класс |
| [12-economy-and-balance](12-economy-and-balance.md) | 🟡 alpha-числа, balance lock не сделан | экономика не финализирована; штраф смерти отсутствует до W4 |
| [13-narrative-antagonist-options](13-narrative-antagonist-options.md) | 🟡 v0.1 | исходник вариантов, сохранён |
| [13-narrative-and-setting](13-narrative-and-setting.md) | 🔴 направление; нужен implementation spec | выбранный нарратив A+B; в коде нет ни диалогов, ни NPC, ни туториала |
| [14-ui-ux-and-art-direction](14-ui-ux-and-art-direction.md) | 🟡 UX-принципы приняты, рендер не проверен | desktop/mobile UX и арт-направление; геометрия не подтверждена |
| [15-audio-design](15-audio-design.md) | 🔴 не реализовано; нужен spec + ассеты | audio matrix; в коде нет аудио-слоя, в репозитории нет звуковых файлов |
| [16-monetization](16-monetization.md) | 🟢 v1.0 принцип; не реализовано | no-P2W принцип; монетизации в коде нет |
| [17-engineering-tdd](17-engineering-tdd.md) | 🟡 browser E2E/performance не проводились | инженерное ТЗ |
| [18-qa-test-plan](18-qa-test-plan.md) | 🟡 заменяется матрицей 24 | QA и exit criteria |
| [19-art-and-design-brief](19-art-and-design-brief.md) | 🔴 не реализовано; нужен spec + ассеты | production brief; production-ассетов в репозитории нет ни одного |
| [20-mvp-scope-and-roadmap](20-mvp-scope-and-roadmap.md) | 🟢 v1.0 | scope lock и roadmap |
| [21-delivery-plan-and-backlog](21-delivery-plan-and-backlog.md) | 🟢 v1.0 | план поставки, приоритеты P0/P1/P2, риски, DoR/DoD, гейты G0–G5 |
| [22-developer-work-packages](22-developer-work-packages.md) | 🟢 v1.0 | 60 тикетов/ТЗ в пакетах W0–W10 с критериями приёмки |
| [23-data-contracts-and-content-pipeline](23-data-contracts-and-content-pipeline.md) | 🟢 v1.0 | схемы, версионирование, миграции, RNG, владение данными |
| [24-test-matrix-and-release-gates](24-test-matrix-and-release-gates.md) | 🟢 v1.0 | матрица тестов, устройства, бюджеты, WCAG, severity, гейты |

🔴-статус означает блокировку соответствующих пакетов реализации, а не отзыв дизайн-решений: дизайн 13/15/19 утверждён как направление, но реализация ждёт implementation spec и ассетов. Дублирующиеся строки 13 и 15 удалены в `W0-05` — каждый документ имеет один статус.

Статусы 09–20 отражают **разрыв между целевым дизайном и фактической реализацией**, а не качество документов: 🟢 у документа означает, что дизайн-решение принято, а не что оно реализовано в `code/`. Что именно реализовано — в шапке каждого документа и в [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md).

Легенда: 🟢 production/утверждено для текущего прохода; 🟡 baseline/требует сверки или частично реализовано; ⚪ ожидает; 🔴 блокирует решение или реализацию.

## Changelog

| Дата | Изменение |
|---|---|
| 30 июл 2026 | Созданы vision, critic, loop, combat и первые системные черновики. |
| 31 июл 2026 | Обновлены progression, weapons, inventory, crafting. |
| 17 авг 2026 | Добавлен critical audit, нормализованы 03/09–20, зафиксированы MVP, no-P2W, code prototype и formula reconciliation; README обновлён. |
| 18 авг 2026 | M3-C: shipped CSS remediation, model-driven combat controls and boot state; 15 test files / 121 tests documented. Browser/mobile rendered QA remains unverified. |
| 18 авг 2026 | M3-D: release-readiness pass added hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser loading and root-CI bundle budget; 17 test files / 128 tests. Browser/mobile rendered QA remains unverified. |
| 22 авг 2026 | Добавлен пакет разработки 21–24: план поставки и бэклог, рабочие пакеты W0–W10, контракты данных и контентный pipeline, матрица тестов и релизные гейты. Зафиксировано, что браузерная/устройственная проверка не проводилась и что документы 13/15/19 требуют отдельных implementation specs и ассетов до старта соответствующих пакетов. |
| 22 авг 2026 | `W0-01` закрыт частично: M3-D закоммичен и отправлен в `origin` (`61c991b`); `main` и `origin/main` = `3f87b80`. Статус «не закоммичено» для M3-D снят из README и docs 00/21. Не выполнены критерии 1 (чистое рабочее дерево), 2 (ветка + PR + зелёный CI на ветке) и 3 (разделение на четыре коммита); критерии 4 и 5 выполнены. |
| 22 авг 2026 | `W0-02`: удалены мёртвые модули и ассеты — `campaign-app.tsx`, `campaign.css` (654 байта в одну минифицированную строку, мёртвый из-за отсутствия импорта, а не пустой), `game/config.ts` (deprecated re-export), starter-ассеты `src/assets/hero.png`/`preact.svg`/`vite.svg` и неиспользуемый `public/icons.svg`; `main.tsx` импортирует `App` напрямую. Файлы `public/config/*.json` не тронуты. 17 файлов / 128 тестов и бюджеты бандла без изменений. |
| 22 авг 2026 | `W0-04` реализован, но не закоммичен: скрипт `verify`, `engines.node` `>=22`, `code/.nvmrc`; корневой workflow переведён на `npm run verify` и `node-version-file: code/.nvmrc`; инертный `code/.github/workflows/quality.yml` удалён. `verify` зелёный локально на существующем `node_modules` и Node v24; прогон на чистом `npm ci` и на Node 22 не выполнялся, в CI изменения ни разу не исполнялись. |
| 22 авг 2026 | `W0-03`: созданы `design-data/` и `art/` с README (назначение, структура, правила именования); раздел §Репозиторий в корневом README приведён к фактической структуре. |
| 22 авг 2026 | `W0-05`: статусы 09–20 приведены к фактической реализации (1 зона из 4, 3 архетипа врага из 6, alpha-экономика без balance lock, штраф смерти отсутствует до W4); документы 13/15/19 помечены как нереализованные направления; убраны дублирующиеся строки статусов 13 и 15; числа бандла подписаны как фактический вывод `analyze:budget` на дату. |

## Открытые решения

См. отдельные разделы документов. Общие блокеры: formula reconciliation, Phaser 3/4, платформенные API и финальные численные balance/performance budgets.

Решения, требуемые от владельца продукта, с дедлайнами — [`21-delivery-plan-and-backlog.md`](21-delivery-plan-and-backlog.md) §9 (D-01 штраф смерти, D-02 навыки/перки в MVP, D-03 целевая длительность, D-04 Phaser 3/4, D-05 платформенные интеграции, D-06 источник и бюджет арта/аудио).
| 23 авг 2026 | `W1-02`…`W1-05`: DOM-тесты shell в jsdom (19), E2E happy path и failure/retreat кампании (20), E2E save/reload/recovery (15), измеренная геометрия viewport (22), CI job `e2e` с кэшем браузеров и выгрузкой артефактов. Итого 147 vitest + 63 Playwright теста, зелёные локально, без флейков в трёх прогонах. Найдены и зафиксированы тестами два дефекта: главный CTA ниже сгиба на mission select и в бою, неизвестный `arenaId` вне активного encounter не отклоняется. Job `e2e` на GitHub Actions не прогонялся. Docs 18/21/22/24 и README приведены в соответствие с фактом. |
| 23 авг 2026 | `W1-05` (только тесты и документация): матрица геометрии расширена до пяти экранов — добавлены `reward` и `return`; `viewport-geometry.spec.ts` 22 → 35 тестов, E2E 63 → 76, vitest 147 → 151. Главный CTA всех пяти экранов подтверждён доступным без прокрутки на 360×640 и 390×844; дефект сохранён и уточнён для 768×1024 / 1280×720 / 800×400. Исправлено ранее опубликованное неверное число (`mission-select` на 1280×720: y≈420 → фактически y=1437) и падавший `responsive-css.test.ts`. Добавлен guard от молча пропущенных тестовых файлов. |
| 23 авг 2026 | `W3-01`/`W3-02` выполнены, `W3-03` частично: симулятор баланса в `code/src/sim/` с точкой входа `cli.ts` через `tsx` 4.23.12, скрипты `simulate:balance`/`simulate:economy`, 30 тестов (vitest 151 → 181). Ни одна формула не дублирована: бой считает `combat.ts`, фазу врага — `resolveEnemyPhase`, каталоги грузят runtime-загрузчики, mission-save проходит настоящий `validateSave`. **Первые фактические измерения баланса:** 200 прогонов на каждую из трёх encounter, seed 12345, политика `cover-torso` — win rate 83.5% (`isolated`) и 71.7% (`chain`), металл в дефиците (−3.52 за проход), на третьей encounter 25.6% проходов заканчиваются нехваткой патронов. Отчёты в `design-data/balance/`; каталог больше не пуст. Балансовые числа **не изменены**: отчёт — измерение, решение принимается в `W3-04`. `W3-04` и `W3-05` не начаты. |
