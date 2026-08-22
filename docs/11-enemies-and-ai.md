# 11 — Enemies & AI

**Статус:** 🟡 M3-B content alpha, 17 августа 2026. Реализовано **3 архетипа из 6** целевых.

Целевой MVP по [`20-mvp-scope-and-roadmap.md`](20-mvp-scope-and-roadmap.md) — 6 типов врагов. В `code/public/config/equipment.json` определены **три** архетипа; roster доводится до шести пакетом `W6-02`.

## Фактические архетипы

Источник: `equipment.json`, секция `enemies`. `applyEnemyArchetype` строит live weapon/armor state из каталога.

| `id` | Имя | `behavior` | Оружие | Броня |
|---|---|---|---|---|
| `lone-shooter` | Одиночка | `shooter` | `pm` | — |
| `wild-rusher` | Дикий пёс | `rusher` | `hornet` | — |
| `sun-defender` | Стрелок Восхода | `defender` | `akm` | `patched-vest` |

## Фактическая расстановка по картам

Источник: файлы карт в `code/public/config/`, поле `units[].archetypeId`. Ровно то, что лежит в данных:

| Карта | Юниты (id → архетип, HP) |
|---|---|
| `perimeter-checkpoint` | `checkpoint-shooter` → `lone-shooter`, 15 HP |
| `collapsed-yard` | `yard-rusher` → `wild-rusher`, 14 HP |
| `relay-station` | `relay-defender` → `sun-defender`, 18 HP; `relay-shooter` → `lone-shooter`, 14 HP |

Итого в зоне: 4 врага на 3 encounter. Первые две карты — один противник, третья — два. Никакого «escort» на КПП и никакого отдельного elite-юнита в данных нет.

Файлы `arena.json`, `arena-checkpoint.json`, `arena-yard.json` и `arena-relay.json` содержат другие, более крупные расстановки, но **не входят в arena manifest** и не используются кампанией; `arena.json` применяется только как тестовая фикстура. Расстановку определяют три карты из таблицы выше.

## AI

- Shooter/rusher/defender routing data-driven и детерминирован для supplied RNG.
- Enemy attacks используют тот же pure combat pipeline, что и герой (`combatAttack`): расходуются магазин и durability, возможна осечка.
- RNG enemy-фазы входит в сохранение (`rngState`) и корректно продолжается после reload.
- Решения врага в `runEnemyTurn`: атака при наличии линии видимости и достаточного AP, иначе перемещение к выбранной точке; Overwatch героя срабатывает на появление в линии видимости.

## Ограничения

- `behavior` влияет на выбор точки перемещения; отдельных классов, способностей, групповой координации и morale нет.
- «Elite-lite» из более раннего описания — это тюнинг HP в данных, а не механика и не отдельный класс врага. В актуальных трёх картах усиленного защитника нет: `relay-defender` имеет 18 HP.
- Relay defender ограничен deterministic damage bound: критическое попадание в торс через starter vest не убивает 24-HP героя с одного выстрела. Подтверждено регрессией в `m3-d-regressions.test.ts`.
- Поведение AI проверено только автотестами на чистых функциях и фикстурах; в браузере не проверялось.
