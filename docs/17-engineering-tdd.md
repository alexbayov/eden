# 17 — Engineering TDD

**Статус:** сверено с кодом 24 августа 2026. M3-D performance pass implemented and committed (`61c991b`); browser E2E поднят и зелёный локально с `W1-01`…`W1-05`; runtime performance и ручная mobile QA по-прежнему **не проверены**.

**Фактический набор на 24 августа 2026 (рабочее дерево, после `W4-01`/`W4-02`/`W4-05`).** `npm test` — **23 файла / 260 тестов**: 21 файл / 234 теста в project `node`, 2 файла / 26 тестов в project `dom` (jsdom). **Набор красный: 259 зелёных, 1 падает** — `combat-shell.dom.test.tsx` («уровень и прогресс на экране награды»: тест ждёт блок нераспределённых очков, шелл его не выводит). `npm run lint` и `npm run typecheck` зелёные (**проверено**), поэтому `npm run verify` падает именно на шаге `test`. `npm run test:e2e` — **7 файлов / 82 теста** в Chromium (состав получен через `playwright test --list`; прогон в этой правке не выполнялся). Числами владеет [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md) §1–2 — при расхождении верен тот документ.

Единая команда проверки — `npm run verify` из `code/` (`lint` → `typecheck` → `test` → `build` → `analyze:budget`), она же используется в CI; Node 22 закреплён через `engines.node` и `code/.nvmrc` (тикет `W0-04`).

## Фактическое M3-B состояние

- В runtime есть одна data-driven зона с тремя encounter, validated map catalog и переключение карт по `arenaId`.
- Campaign/save flow сохраняет progression; схема сохранения — **v5** с миграциями v4→v5 и v3→v4→v5 (`W4-05`, обновлено 24 августа 2026; ранее здесь стояло «migration v3→v4»). Exactly-once reward claim гарантируется только в нормальном application flow.
- Offline `localStorage` save защищён от corruption и обычных flow-ошибок: malformed shape, неизвестные campaign/item/equipment IDs, невозможные stack/weight/count/durability/slot/link значения отклоняются. Это **не** tamper-resistance: пользователь может вручную откатить или изменить localStorage.
- Anti-tamper и authoritative leaderboards требуют будущего authoritative cloud/server save; это не часть текущего M3-B.
- M3-B strict runtime-catalog save validation подтверждена; browser E2E and performance QA остаются pending.
- M3-C ships its CSS as the first shipped change in the application bundle. Tactical controls are model-driven: weapon maintenance is gated by player turn and domain preconditions; the narrow-phone move recommendation cap is application behavior at `<=430px`, not CSS clipping.
- Phaser and `TacticalScene` are lazy-loaded behind the combat runtime boundary; base, home, and mission-select initial entry does not statically include Phaser. CI checks initial JS at `<=150 kB` gzip; combat lazy JS is reported and checked with a separate `1200 kB` gzip threshold.
- Browser geometry и рендер на 390×844 **измерены** в headless Chromium (`W1-05`, 35 тестов на пяти viewport × пяти экранах); ручная mobile/browser QA на реальных устройствах — **не проводилась**, и headless-измерение её не заменяет: device pixel ratio, chrome браузера, экранная клавиатура, safe-area insets, реальный тач-ввод и WebKit не участвовали. Статические CSS и view-model тесты сами по себе не устанавливают ни геометрию рендера, ни поведение на устройстве.

## Реализованные инженерные инварианты

- `game/combat.ts` owns the sole pure attack transition and injected rolls.
- Hero, enemy, and Overwatch shots use `combatAttack` / `performCombatAttack`.
- Live armor durability is reduced and clamped by the affected equipped armor instance.
- Save validation requires runtime campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, catalog-backed item stacks, equipment IDs/slots and combat-to-inventory links; malformed saves return validation errors instead of crashing runtime. С v5 добавлено: блок `character` сверяется **с загруженной кривой прогрессии** (`level === levelForXp(xp)`, очки не больше начисленных достигнутыми уровнями, `character.xp === campaign.xp`), а `campaign.returnReason` допустим только на экране возврата.
- `game/progression.ts` — единственная реализация кривой уровней, начисления XP и штрафа смерти (`W4-01`/`W4-02`); кривая живёт в контенте (`public/config/progression.json`), и ни один экран не пересчитывает уровень или штраф самостоятельно. Пакет `W4` **не закрыт как гейт**: verify/critic-прохода нет. Числа и формула — [`05-character-and-progression.md`](05-character-and-progression.md) §5.3.0.
- Base repair operates on the selected weapon or damaged armor instance and synchronizes the linked combat state.
- Equipment content validates bounded modifiers and ships distinct non-zero ammo examples.

Final gate: `npm run verify` (`lint`, `typecheck`, `test`, `build`, `analyze:budget`) — на 24 августа 2026 **не проходит** из-за одного падающего DOM-теста (см. шапку). Browser E2E и измеренная геометрия — проверены локально в Chromium (`W1-01`…`W1-05`); runtime performance profiling, cross-browser матрица и ручная mobile QA остаются непроверенными.

`W0-02` удалил мёртвые модули (`campaign-app.tsx`, `campaign.css`, deprecated re-export `game/config.ts`) и неиспользуемые starter-ассеты; `main.tsx` импортирует `App` напрямую. Публичные экспорты рабочих модулей не менялись: `loadArenaContent`, `parseArenaContent`, `validateArenaContent` и алиас `loadArena` остаются в `game/content.ts`. Число тестов и бюджеты бандла не изменились.
