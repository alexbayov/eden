# EDEN PROTOCOL

> Одиночная браузерная тактическая RPG в жанре пошагового постапокалипсиса для Яндекс.Игр.

**Elevator pitch:** прицельный пошаговый бой, база с крафтом, вылазки и герой, которого нельзя убить — но каждая смерть стоит.

## Статус проекта

**Текущий статус: M3-C UX/QA pass; gate закрыт по code review.** В `code/` реализованы одна зона, три data-driven encounter, runtime map switching через validated arena catalog, campaign progression, schema-v4 local save и responsive/a11y UX layer. Есть 15 test files / 121 automated tests. Browser/device E2E, rendered 390×844 geometry, performance profiling и platform integration остаются pending. Это ещё **не готовый MVP**: отсутствуют полноценные 4 зоны, полный production-контент, финальная экономика, browser E2E и платформенные интеграции.

Первый публичный релиз планируется как полный MVP на 10–15 часов основного контента, с desktop + mobile с первого playable. Производственная реализация идёт последовательно по M2/M3/M4/M5 gates.

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

1. [`docs/00-index.md`](docs/00-index.md) — оглавление, статусы, approved decisions и source of truth.
2. [`docs/00-critical-audit.md`](docs/00-critical-audit.md) — read-only аудит и P0/P1.
3. [`docs/20-mvp-scope-and-roadmap.md`](docs/20-mvp-scope-and-roadmap.md) — scope первого публичного релиза.
4. [`docs/04-combat-system.md`](docs/04-combat-system.md) — полный combat scope, пока с обязательной сверкой формул.
5. [`docs/09-base-and-home-systems.md`](docs/09-base-and-home-systems.md), [`docs/10-exploration-and-zones.md`](docs/10-exploration-and-zones.md), [`docs/11-enemies-and-ai.md`](docs/11-enemies-and-ai.md), [`docs/12-economy-and-balance.md`](docs/12-economy-and-balance.md).
6. [`docs/13-narrative-and-setting.md`](docs/13-narrative-and-setting.md), [`docs/14-ui-ux-and-art-direction.md`](docs/14-ui-ux-and-art-direction.md), [`docs/15-audio-design.md`](docs/15-audio-design.md), [`docs/16-monetization.md`](docs/16-monetization.md).
7. [`docs/17-engineering-tdd.md`](docs/17-engineering-tdd.md), [`docs/18-qa-test-plan.md`](docs/18-qa-test-plan.md), [`docs/19-art-and-design-brief.md`](docs/19-art-and-design-brief.md).

Старые документы сохранены и не удалены; их применимость определяется порядком source of truth в индексе.

## Реалистичный roadmap

1. Formula reconciliation между дизайном и combat prototype.
2. Vertical slice на desktop/mobile: база → зона 1 → бой → лут/крафт → сохранение.
3. Production MVP: 4 зоны, база, экономика, 6 типов врагов, финал на 10–15 часов.
4. QA/balance/release candidate без P0 и без платной силы/темпа.
5. Post-MVP: дополнительные зоны, narrative fragments, accessibility и косметика после platform review.

## Репозиторий

```text
eden/
├── README.md
├── docs/       ← живая Game Bible
├── code/       ← существующий combat prototype
├── design-data/
└── art/
```

Состояние рабочих изменений: локальные изменения не закоммичены и не отправлены в remote.
