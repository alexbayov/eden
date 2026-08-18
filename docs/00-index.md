# EDEN PROTOCOL — Game Bible

> Живой русскоязычный production-документ. Рабочее название проекта.

**Владелец продукта:** Alex Bayov
**Документатор:** Lindy
**Целевая платформа:** Яндекс.Игры, desktop + mobile
**Модель:** single-player; асинхронные лидерборды и платформенные интеграции — после проверки совместимости.

## Source-of-truth order

1. Явные утверждённые решения владельца и таблица ниже.
2. [`20-mvp-scope-and-roadmap.md`](20-mvp-scope-and-roadmap.md) — scope первого публичного релиза.
3. Production-документы 09–19 и [`13-narrative-and-setting.md`](13-narrative-and-setting.md).
4. [`04-combat-formula-reconciliation.md`](04-combat-formula-reconciliation.md) — authoritative v1.0 numerical combat contract for the prototype.
5. Старые 01–08 и [`13-narrative-antagonist-options.md`](13-narrative-antagonist-options.md) — исторический/детальный материал, не удалённый и действующий только без конфликта.
6. `code/` — источник фактического поведения **combat prototype**, реализующий reconciliation v1.0 в пределах текущего scope.

**М3-B:** strict save validation подтверждена; browser E2E и performance QA остаются pending. Фактический slice: одна зона, три encounter, runtime map switching и campaign/save flow. Exactly-once действует только в normal application flow. LocalStorage save защищён от corruption и обычных flow-ошибок, но не от ручного rollback/edit; anti-tamper и authoritative leaderboards требуют будущего cloud/server save.

**M3-C:** UX remediation shipped in CSS and application/view-model behavior on 18 августа 2026. 15 test files / 121 tests cover the static and pure-model contracts. Browser E2E, rendered geometry including 390x844, performance, and manual mobile/browser QA remain unverified.

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
| [00-critical-audit](00-critical-audit.md) | 🟡 M3-B browser E2E/performance pending | read-only аудит, P0/P1 и правила истины |
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
| [17-engineering-tdd](17-engineering-tdd.md) | 🟡 M3-B browser E2E/performance pending | инженерное ТЗ |
| [18-qa-test-plan](18-qa-test-plan.md) | 🟢 v1.0 | QA и exit criteria |
| [19-art-and-design-brief](19-art-and-design-brief.md) | 🟢 v1.0 | production brief |
| [20-mvp-scope-and-roadmap](20-mvp-scope-and-roadmap.md) | 🟢 v1.0 | scope lock и roadmap |

Легенда: 🟢 production/утверждено для текущего прохода; 🟡 baseline/требует сверки; ⚪ ожидает; 🔴 блокирует решение.

## Changelog

| Дата | Изменение |
|---|---|
| 30 июл 2026 | Созданы vision, critic, loop, combat и первые системные черновики. |
| 31 июл 2026 | Обновлены progression, weapons, inventory, crafting. |
| 17 авг 2026 | Добавлен critical audit, нормализованы 03/09–20, зафиксированы MVP, no-P2W, code prototype и formula reconciliation; README обновлён. |
| 18 авг 2026 | M3-C: shipped CSS remediation, model-driven combat controls and boot state; 15 test files / 121 tests documented. Browser/mobile rendered QA remains unverified. |

## Открытые решения

См. отдельные разделы документов. Общие блокеры: formula reconciliation, Phaser 3/4, платформенные API и финальные численные balance/performance budgets.
