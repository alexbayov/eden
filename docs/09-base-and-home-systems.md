# 09 — Base & Home Systems

**Статус:** 🟡 M2 vertical slice реализован (17 авг. 2026); не полный MVP.

## Фактический M2 scope

В `code/` реализован короткий hub перед и после одной миссии:

- versioned JSON-каталоги для активной миссии, награды, рецепта, предмета и улучшения;
- отдельные `stash` и `backpack`: stash без лимита, backpack имеет весовой лимит;
- перенос ресурсов и предметов между пулами; при возвращении backpack разгружается в stash;
- один рецепт бинта, атомарно списывающий ткань из stash;
- одно data-driven улучшение склада, увеличивающее допустимый вес backpack;
- медотсек тратит бинт из stash и лечит только HP;
- ремонт тратит металл из stash и восстанавливает только durability persistent equipment instance.

Нет real-time таймеров, оплаты или рекламы в core loop.

## M2 data and invariants

| Сущность | Источник | Правило |
|---|---|---|
| Миссия | `code/public/config/missions.json` | активная миссия должна ссылаться на существующие arena/reward/zone |
| Награда | `code/public/config/rewards.json` | складывается в stash, не теряется из-за веса backpack |
| Рецепт | `code/public/config/recipes.json` | preflight ресурсов → списание → output; нет частичной транзакции |
| Улучшение | `code/public/config/base-upgrades.json` | применяется только на следующий уровень узла |
| Экипировка | `SaveData.inventory.equipment` | instance id/slot уникальны, `0 ≤ durability ≤ maxDurability` |

## Acceptance criteria M2

- Возвращение разгружает backpack в stash без удаления предметов.
- Крафт не меняет inventory при отсутствии ресурсов.
- Repair не меняет HP, medbay не меняет durability.
- Все действия доступны кнопками touch/keyboard-compatible UI и сохраняются локально.

## Открытые решения / не реализовано

- Полная сетка 6×8, drag-and-drop, planner presets и весь каталог узлов/рецептов.
- Полный набор слотов экипировки и боевое расходование quick slots.
- Экономический баланс, смерть с лут-штрафом, несколько зон.

## Post-M2

Расширять catalog-driven данные и UI только после UX-теста переноса stash/backpack на 360×640 и 390×844.
