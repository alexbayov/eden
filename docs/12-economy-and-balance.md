# 12 — Economy & Balance

**Статус:** M3-B content alpha, 17 августа 2026.

Награды трёх encounter «Ближней окраины» находятся исключительно в `code/public/config/rewards.json`; reward UI/award pipeline не использует constants миссий.

| Encounter | XP | Ресурсы | One-time |
|---|---:|---|---|
| КПП периметра | 30 | металл ×2 | да |
| Обрушенный двор | 45 | металл ×2, ткань ×1, бинт ×1 | да |
| Релейная станция | 60 | металл ×3, ткань ×2, бинт ×1 | да |

Campaign state хранит `claimedRewards`; повторный claim не добавляет XP, ресурсы или предметы. Поражение не выдаёт награду и не отмечает encounter completed. Сохраняются существующие repair, stash, medbay и craft rules.

Нет энергии, premium currency, рекламы, платного ускорения или второй экономики. Эти числа — alpha values, не финальный balance lock.
