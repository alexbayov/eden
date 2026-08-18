# 11 — Enemies & AI

**Статус:** M3-B content alpha, 17 августа 2026.

Enemy archetypes загружаются из `code/public/config/equipment.json`; `applyEnemyArchetype` строит live weapon/armor state из каталога. В M3-B карты размещают противников по `archetypeId` в данных карт.

| Encounter | Роль | Archetype |
|---|---|---|
| КПП периметра | shooter | `lone-shooter` / defender escort |
| Обрушенный двор | rusher | `wild-rusher` |
| Релейная станция | defender, elite-lite | `sun-defender` с повышенным HP у старшего защитника |

Shooter/rusher/defender routing остаётся data-driven и детерминированным для supplied RNG. Enemy attacks используют тот же pure combat pipeline, что и герой; расходуются магазин и durability, возможна осечка. RNG enemy-фазы сохраняется и корректно resume после reload.

Ограничение: elite-lite — это content tuning существующего defender, а не новая AI-механика или отдельный класс врага.
