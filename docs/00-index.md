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

**M3-D:** release-readiness pass реализован (combat hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser loading, root-CI bundle budget). 17 test files / 128 tests покрывают static и pure-model контракты и проходят локально.

> **Фактическое состояние на 22 августа 2026: работа M3-D НЕ закоммичена и НЕ отправлена в remote.** HEAD ветки `main` = `373a99f fix(M3-C): harden combat UX and loading state`; в рабочем дереве 16 изменённых и 5 новых файлов. Первый тикет плана — `W0-01` — фиксирует эту работу в `origin` до любых других задач.

Browser E2E, rendered geometry (включая 390×844), runtime performance и ручная mobile/browser QA **не проводились**. Статические CSS/view-model тесты не устанавливают ни геометрию рендера, ни поведение на устройстве.

**Отдельные implementation specs обязательны.** [`13-narrative-and-setting.md`](13-narrative-and-setting.md), [`15-audio-design.md`](15-audio-design.md) и [`19-art-and-design-brief.md`](19-art-and-design-brief.md) — это направления и требования, а **не** реализуемые спецификации. Пакеты W7-03/W7-04 (нарративный контент), W9-01/W9-02 (аудио) и W8-03…W8-05 (арт-интеграция) не могут стартовать до появления отдельных implementation specs и фактической поставки ассетов с проверенными лицензиями. Каталоги `art/` и `design-data/` в репозитории отсутствуют; они создаются в тикетах `W0-03`, `W3-01` и `W8-02`.

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
| [09-base-and-home-systems](09-base-and-home-systems.md) | 🟢 v1.0 | production base MVP |
| [10-exploration-and-zones](10-exploration-and-zones.md) | 🟢 v1.0 | 4 зоны первого релиза |
| [11-enemies-and-ai](11-enemies-and-ai.md) | 🟢 v1.0 | roster и decision model |
| [12-economy-and-balance](12-economy-and-balance.md) | 🟢 v1.0 | baseline экономики и gates |
| [13-narrative-antagonist-options](13-narrative-antagonist-options.md) | 🟡 v0.1 | исходник вариантов, сохранён |
| [13-narrative-and-setting](13-narrative-and-setting.md) | 🟢 v1.0 | production narrative A+B |
| [14-ui-ux-and-art-direction](14-ui-ux-and-art-direction.md) | 🟢 v1.0 | desktop/mobile UX и арт-направление |
| [15-audio-design](15-audio-design.md) | 🟢 v1.0 | audio matrix |
| [16-monetization](16-monetization.md) | 🟢 v1.0 | no-P2W монетизация |
| [13-narrative-and-setting](13-narrative-and-setting.md) | 🔴 нужен implementation spec | production narrative A+B; направление, не реализуемая спецификация |
| [15-audio-design](15-audio-design.md) | 🔴 нужен implementation spec + ассеты | audio matrix; ни одного звукового файла в репозитории |
| [17-engineering-tdd](17-engineering-tdd.md) | 🟡 browser E2E/performance не проводились | инженерное ТЗ |
| [18-qa-test-plan](18-qa-test-plan.md) | 🟡 заменяется матрицей 24 | QA и exit criteria |
| [19-art-and-design-brief](19-art-and-design-brief.md) | 🔴 нужен implementation spec + ассеты | production brief; production-ассетов в репозитории нет |
| [20-mvp-scope-and-roadmap](20-mvp-scope-and-roadmap.md) | 🟢 v1.0 | scope lock и roadmap |
| [21-delivery-plan-and-backlog](21-delivery-plan-and-backlog.md) | 🟢 v1.0 | план поставки, приоритеты P0/P1/P2, риски, DoR/DoD, гейты G0–G5 |
| [22-developer-work-packages](22-developer-work-packages.md) | 🟢 v1.0 | 60 тикетов/ТЗ в пакетах W0–W10 с критериями приёмки |
| [23-data-contracts-and-content-pipeline](23-data-contracts-and-content-pipeline.md) | 🟢 v1.0 | схемы, версионирование, миграции, RNG, владение данными |
| [24-test-matrix-and-release-gates](24-test-matrix-and-release-gates.md) | 🟢 v1.0 | матрица тестов, устройства, бюджеты, WCAG, severity, гейты |

Строки 13, 15 и 19 дублируются выше в исходном порядке; 🔴-статус здесь означает блокировку соответствующих пакетов реализации, а не отзыв дизайн-решений.

Легенда: 🟢 production/утверждено для текущего прохода; 🟡 baseline/требует сверки; ⚪ ожидает; 🔴 блокирует решение или реализацию.

## Changelog

| Дата | Изменение |
|---|---|
| 30 июл 2026 | Созданы vision, critic, loop, combat и первые системные черновики. |
| 31 июл 2026 | Обновлены progression, weapons, inventory, crafting. |
| 17 авг 2026 | Добавлен critical audit, нормализованы 03/09–20, зафиксированы MVP, no-P2W, code prototype и formula reconciliation; README обновлён. |
| 18 авг 2026 | M3-C: shipped CSS remediation, model-driven combat controls and boot state; 15 test files / 121 tests documented. Browser/mobile rendered QA remains unverified. |
| 18 авг 2026 | M3-D: release-readiness pass added hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser loading and root-CI bundle budget; 17 test files / 128 tests. Browser/mobile rendered QA remains unverified. |
| 22 авг 2026 | Добавлен пакет разработки 21–24: план поставки и бэклог, рабочие пакеты W0–W10, контракты данных и контентный pipeline, матрица тестов и релизные гейты. Зафиксировано, что работа M3-D остаётся незакоммиченной, что браузерная/устройственная проверка не проводилась и что документы 13/15/19 требуют отдельных implementation specs и ассетов до старта соответствующих пакетов. |

## Открытые решения

См. отдельные разделы документов. Общие блокеры: formula reconciliation, Phaser 3/4, платформенные API и финальные численные balance/performance budgets.

Решения, требуемые от владельца продукта, с дедлайнами — [`21-delivery-plan-and-backlog.md`](21-delivery-plan-and-backlog.md) §9 (D-01 штраф смерти, D-02 навыки/перки в MVP, D-03 целевая длительность, D-04 Phaser 3/4, D-05 платформенные интеграции, D-06 источник и бюджет арта/аудио).
