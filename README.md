# EDEN PROTOCOL

> Одиночная браузерная тактическая RPG в жанре пошагового постапокалипсиса для Яндекс.Игр.

**Elevator pitch:** прицельный пошаговый бой, база с крафтом, вылазки и герой, которого нельзя убить — но каждая смерть стоит.

## Статус проекта

**Текущий статус: M3-D release-readiness pass реализован, но НЕ закоммичен и НЕ отправлен в remote.**

HEAD ветки `main` = `373a99f fix(M3-C): harden combat UX and loading state`. В рабочем дереве 16 изменённых и 5 новых файлов M3-D: combat hotkey gating, retreat/no-ammo protection, relay balance bounds, persistent hero condition, lazy Phaser boundary и CI-бюджет бандла. Первая задача плана — `W0-01` — зафиксировать эту работу в `origin` до любых других изменений.

В `code/` реализованы одна зона, три data-driven encounter, runtime map switching через validated arena catalog, campaign progression, schema-v4 local save и responsive/a11y UX layer. **17 test files / 128 automated tests проходят локально.** Статический бюджет бандла: initial JS 36.2 kB gzip (лимит 150), combat lazy JS 349.7 kB gzip (порог 1200).

**Что не проверено:** browser/device E2E, геометрия рендера на любом viewport (включая 390×844 и 360×640), runtime-производительность, доступность с ассистивными технологиями, платформенные интеграции. В репозитории нет headless-браузера и DOM-инфраструктуры — все 128 тестов статические и модельные. Ручных прогонов на устройствах не было.

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

Проверки:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Фактический локальный package baseline: Phaser 4.2.1, TypeScript, Preact, Vite, Vitest. Решение Phaser 3/4 для production ещё открыто; не путать его с утверждением старых документов.

## Документация

**Пакет разработки — начинать отсюда:**

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

1. **Неделя 1 — стабилизация, без новых механик:** закоммитить M3-D, поднять браузерный E2E harness, провести первую ручную mobile QA, запустить симулятор баланса, вычистить непроверенные утверждения из документов.
2. **Неделя 2:** ввод, доступность, mobile-геометрия.
3. **Неделя 3:** баланс и экономика по данным симулятора, balance lock v1.
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
├── docs/       ← живая Game Bible + пакет разработки 21–24
└── code/       ← существующий combat prototype (Phaser + Preact + TS)
```

Каталоги `design-data/` и `art/` пока **не созданы**: они появятся в тикетах `W0-03` (структура), `W3-01` (отчёты симулятора), `W8-02` (реестр ассетов).

**Состояние рабочих изменений:** локальные изменения M3-D не закоммичены и не отправлены в remote. Это первая задача плана (`W0-01`).
