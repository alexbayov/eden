# 18 — QA Test Plan

**Статус:** `W1-02`…`W1-05` выполнены 23 августа 2026 (не закоммичено). Автоматическая проверяемость: **20 vitest files / 151 test** (`npm test`, из них 19 DOM-тестов в jsdom) и **7 Playwright files / 76 tests** в Chromium (`npm run test:e2e`) — все зелёные локально. Это первые фактические утверждения проекта о rendered DOM и об измеренной геометрии. `W1-06` (runtime performance profiling) и ручная mobile QA (`W2-06`) по-прежнему **не выполнены**. Матрица тестов и релизные гейты — [`24-test-matrix-and-release-gates.md`](24-test-matrix-and-release-gates.md).

## Реализованное и автоматически проверяемое

- **20 vitest files / 151 test** (`npm test`), разделённые на два project:
  - project `node` (18 files / 132 tests): combat, content, save/reload, session, campaign, inventory/base, M3-B catalog/progression, shipped runtime fixtures, M3-C boot/combat-view/responsive contracts, M3-D state/retreat/balance/persistence regressions. Как и раньше — чистые функции и view-модели, без DOM.
  - project `dom` (2 files / 19 tests, `W1-02`): jsdom + `@testing-library/preact`, рендер настоящего Preact-шелла. См. отдельный раздел ниже.
- Production boot сначала загружает и валидирует zone/mission/reward/item/equipment/arena catalogs; при отсутствии save начальная campaign создаётся только из первого доступного encounter активного каталога.
- Save contract сохраняет schema v4: v3→v4 migration и legacy-default migration используют переданный validated catalog, а v4 saves проходят strict cross-field validation без изменения schema version. `home`/`mission-select` принимают только `player`; `mission` принимает только `player`/`enemy`; terminal `victory`/`defeat` допустимы только на явных `reward`/`return` экранах.
- Проверяются существование campaign zone/id/status, finite nonnegative XP, boolean `firstDeathReturnUsed`, item stack IDs/weights/counts, equipment IDs/slots/durability и combat-to-inventory links, quick slots и unknown-ID rejection; malformed save возвращает validation error вместо runtime crash.
- Интеграционные tests получают карту через `mission.arenaId` активного validated mission catalog, проверяя catalog links, lock ordering, failed retry, exactly-once reward и reload at available/active/completed stages.
- M3-C CSS is the first shipped change in the application bundle. `responsive-css.test.ts` verifies the imported stylesheet, control-size **declarations**, non-hover affordances, responsive rules, boot-state selection, and combat view-model policies. Это по-прежнему **не** browser-geometry assertion — измеренная геометрия появилась отдельно в `W1-05` (см. ниже), и оба слоя оставлены сознательно: статический проверяет намерение таблицы стилей за миллисекунды и покрывает состояния, куда E2E-матрица не заходит (`prefers-reduced-motion`, `:focus-visible`), измеренный ловит правило, которое не сматчилось или было сжато flex-родителем.
- Глобальные `E`/`O`/`1–6` принимаются только на `campaign.screen === mission` в player-фазе. Гейт закрыт тремя независимыми слоями: чистая функция (`resolveCombatShortcut`), реальный DOM-слушатель шелла в jsdom (`W1-02`) и настоящее нажатие клавиши в Chromium (`e2e/input-gating.spec.ts`, `W1-03`). Третий слой нужен потому, что первые два отправляют синтезированное событие: баг, зависящий от `event.target` или фокуса, прошёл бы jsdom и упал бы в браузере.
- Из боя есть явное `Отступить без награды`: оно переводит active encounter в failed/return и недоступно лишь на enemy transition. При пустом магазине и резерве UI показывает причину и этот выход.
- Релейный defender uses bounded AKM damage: even a critical torso hit through the starter vest is below the 24-HP starting hero; deterministic regression covers the bound.
- HP и статусы живого героя переносятся между encounter через hydration; после defeat retry получает HP/statuses из mission template. Медотсек лечит HP на базе и не снимает боевые статусы.
- CI job `verify` runs `npm ci` and `npm run verify`, который последовательно выполняет `lint`, `typecheck`, `test`, `build` и `analyze:budget` (тикет `W0-04`).
- CI job `e2e` (`needs: verify`) устанавливает Chromium с кэшем по версии Playwright, запускает `npm run test:e2e` и при падении выгружает `code/test-results/` и `code/playwright-report/` артефактом. **Не проверено фактическим прогоном на GitHub Actions** — см. §CI ниже.
- Initial entry JavaScript is budgeted at `<=150 kB` gzip. Phaser and `TacticalScene` are lazy combat chunks and are reported separately; the current combat threshold is `1200 kB` gzip and is not treated as an unrealistic total Phaser budget.
- Initial JS budget не затронут `W1-02`…`W1-05`: `jsdom`, `@testing-library/preact` и Playwright — только devDependencies. Фактический вывод `analyze:budget` до и после: **initial JS 36.2 kB gzip**.

## DOM-тесты shell (`W1-02`, 19 тестов)

`npm test` project `dom`: jsdom 30.0.1 + `@testing-library/preact` 3.2.4 (точные версии). Файлы `src/game/app-shell.dom.test.tsx` (10) и `src/game/combat-shell.dom.test.tsx` (9); разделены на два файла ради параллельных worker-ов. Запросы идут по доступной роли и подписи, а не по CSS-классу; два исключения (`main.game-shell.*` и индикатор фазы) вынесены в хелперы и определяют *какой экран смонтирован*, а не содержимое контрола.

Что доказано рендером настоящего шелла: загрузочный экран не разыменовывает `campaign === null`; recovery при битом JSON (с backup) и при невалидном каталоге (**без** кнопки сброса — сброс save не лечит контент); база с HP/stash из save; mission select со всеми encounter каталога и их состоянием разблокировки; `ПОВТОРИТЬ` вместо `НАЧАТЬ` для failed encounter; тактическая панель с ровно одной парой reload/clear-jam и всеми шестью частями тела; `ОГОНЬ` активируется только после выбора цели с линией огня; выбор части тела с клавиатуры; ровно-однократная выдача награды с XP и ресурсами из shipped-каталога; return/retry без награды; рендер каждого encounter из своей арены.

Ключевая деталь реализации: боевая горячая клавиша на home проверяется через `vi.getTimerCount() === 0`, а не через sleep. Enemy-фаза достигается только через `window.setTimeout`, поэтому «ноль запланированных таймеров» доказывает, что переход не был запланирован вообще, а не что он ещё не успел сработать. Симметрично: в активном бою тот же счётчик показывает ровно один таймер.

**Чего DOM-тесты не проверяют.** Геометрию, размеры тач-таргетов и канвас: в jsdom нет layout engine и нет canvas-контекста. `createCombatRuntime` замокан (иначе транзорм Phaser на 1.4 МБ добавлял бы ~3.2 с к каждому прогону). Реальный канвас проверяется в браузере (`e2e/smoke.spec.ts`), геометрия — в `e2e/viewport-geometry.spec.ts`.

**Цена по времени.** `npm test` вырос с **1.55–1.64 с** до **3.6–3.85 с**, то есть примерно **+130%**. Исходный критерий приёмки `W1-02` требовал роста не более 100%, и он **не выполнен**. Что уже сделано для сокращения: split на два файла ради параллелизма (−0.5 с), мок `combat-runtime` вместо реального Phaser (−3.2 с), fake timers вместо реальных ожиданий (−0.9 с), `waitFor` с интервалом 5 мс вместо дефолтных 50 мс, кэш текста shipped-конфигов. Остаток — неустранимая цена jsdom: сам старт окружения занимает ~0.8 с на worker, и «пустой» dom-project с одним тривиальным тестом уже даёт 2.2 с. Дальнейшее сокращение требует либо отказа от jsdom (happy-dom), либо удаления тестов; ни то, ни другое не оправдано ради выполнения оценочного норматива.

## Браузерный E2E (`W1-01`…`W1-05`, 76 тестов)

`npm run test:e2e` — 76 тестов в Chromium, 7 файлов, зелёные локально (~1.7 мин).

| Файл | Тестов | Тикет | Что доказано в реальном браузере |
|---|---|---|---|
| `smoke.spec.ts` | 4 | W1-01 | рендер базы из пустого `localStorage` без ошибок консоли; Mission Select со статусами; Phaser-канвас первого encounter с ненулевыми размерами; отсутствие Phaser в initial payload до входа в бой |
| `corrupt-save.spec.ts` | 2 | W1-01 | recovery при битом JSON и при неверной схеме, с сохранением исходного payload в backup-ключ |
| `campaign-happy-path.spec.ts` | 5 | W1-03 | путь база → mission select → бой → победа → награда → база; порядок разблокировки трёх encounter; exactly-once награда (UI + `localStorage`); зона `completed` только после третьего encounter |
| `campaign-failure.spec.ts` | 8 | W1-03 | поражение переводит encounter в `failed` без награды; retry с чистого первого хода; `Отступить без награды` (включая ammo soft lock); отступление недоступно на enemy transition и вне активного боя |
| `save-reload.spec.ts` | 15 | W1-04 | reload на стадиях available/active/completed/reward/return с побайтово равным save и идентичным текстом экрана; reload после реального прогресса, заработанного через UI; разрешение прерванной enemy-фазы при следующем boot; отказ от save с неизвестной encounter/ареной; недоступная квота хранилища; отказ от сброса при неудачном backup |
| `viewport-geometry.spec.ts` | 35 | W1-05 | измеренная геометрия на 360×640, 390×844, 768×1024, 1280×720, 800×400 × пяти экранах (`home`, `mission-select`, `combat`, `reward`, `return`) |
| `input-gating.spec.ts` | 7 | W1-03 | `E`/`O`/`1–6` инертны на home/mission-select/reward/return и во время enemy transition; `E` в бою действительно заканчивает ход; ввод в текстовое поле не запускает боевое действие |

**Как достигнут детерминизм боя.** Каждая атака берёт три числа из сохранённого `rngState`, а шанс попадания зажат сверху 95%, поэтому никакая последовательность кликов не гарантирует исход. Вместо этого `src/test/campaign-save-fixtures.ts` ищет seed, при котором *следующая* тройка бросков даёт подтверждённое убийство (`lethalShotSeed`) или гибель героя на ходу противника (`heroDefeatSeed`), используя настоящие `performCombatAttack` и `runEnemyTurn`. Спеки затем играют этот выстрел через реальный UI. Если баланс изменится и seed перестанет быть смертельным, поиск падает с явным сообщением, а не флейкует. Фикстуры валидируются той же `validateSave`, что и runtime (требование doc 23 §5).

## Измеренная геометрия (`W1-05`)

Первые фактические числа о геометрии в проекте. Chromium раскладывает страницу на пяти CSS-viewport, значения берутся из `getBoundingClientRect` и `scrollWidth`.

Результаты:

- **Горизонтального переполнения нет** ни на одном из пяти viewport ни на одном из **пяти** экранов (home, mission select, combat, reward, return) — 25 измеренных комбинаций. Проверяется двумя способами: `scrollWidth` против `clientWidth` и правый край каждого элемента.
- **Ни один интерактивный элемент не меньше 44×44 CSS px** ни на одном viewport. Отдельная проверка не даёт пройти «пусто» за «нет нарушений».
- Экраны `reward` и `return` добавлены в матрицу, потому что игрок проходит через них принудительно после каждого encounter. Их сохранения строятся тем же `buildSave`, поэтому проходят runtime-валидацию `validateSave`, а CTA `ЗАБРАТЬ НАГРАДУ` и `ВЕРНУТЬСЯ НА БАЗУ` не только измеряются, но и **нажимаются** на 360×640 с фактическим переходом на `БАЗА`.
- **Все шесть частей тела** присутствуют на 390×844, имеют размер ≥44 px и реально переключаются по клику.
- Тактическая панель с единственными контролами reload/clear-jam не обрезается на 360×640; канвас не выходит за правый край на 800×400.
- Recovery-экран (единственный, куда игрок попадает не по своей воле) целиком влезает в 360×640, и кнопка сброса не требует прокрутки.

**Доступность главного CTA: критерий выполнен на ширинах телефона, дефект сохраняется выше 760 px.** Критерий приёмки `W1-05` №3 требует, чтобы главный CTA каждого экрана был видим и кликабелен без прокрутки на 360×640. На 360×640 и 390×844 это выполняется для **всех пяти** экранов: блок `@media (max-width: 760px)` переводит главное действие в закреплённую нижнюю полосу (`position: fixed`, `bottom: calc(12px + env(safe-area-inset-bottom))`).

Измеренные `y` (высота CTA везде 44 px):

| viewport | home | mission select | combat | reward | return |
|---|---|---|---|---|---|
| 360×640 | ✅ y=472 | ✅ y=584 fixed | ✅ y=584 fixed | ✅ y=584 fixed | ✅ y=584 fixed |
| 390×844 | ✅ y=472 | ✅ y=788 fixed | ✅ y=788 fixed | ✅ y=788 fixed | ✅ y=788 fixed |
| 768×1024 | ✅ y=503 | ❌ y=1457 | ❌ y=1738 | ❌ y=1756 | ❌ y=1756 |
| 1280×720 | ✅ y=503 | ❌ y=1437 | ❌ y=897 | ❌ y=1736 | ❌ y=1736 |
| 800×400 | ❌ y=503 | ❌ y=1457 | ❌ y=1517 | ❌ y=1756 | ❌ y=1756 |

**Политика заявлена явно.** Закреплённый CTA **считается** доступным без прокрутки, когда он действительно виден: поэтому геометрический `withinFold` всегда проверяется в паре с `toBeInViewport`, а для `reward`/`return` дополнительно проверяется нажатие без прокрутки — прямоугольник сам по себе не доказал бы, что элемент не перекрыт и не обрезан.

**800×400 — двойственный случай, поэтому политика для него сформулирована отдельно.** Экран шириной 800 px находится **выше** breakpoint 760 px, поэтому закреплённой полосы не получает вообще, а 400 px высоты меньше, чем шапка плюс панель над любым CTA. Закреплять нечего, и тест утверждает **фактическое** измеренное значение: `false` на всех пяти экранах, включая базу.

**Исправлено ранее опубликованное неверное число.** Прежняя версия этого раздела указывала `mission-select` на 1280×720 как `✅ y≈420`. Измерение на текущей сборке даёт y=1437 (`false`). Причина: `.campaign-grid` больше не трёхколоночная сетка, а `display: flex; flex-direction: column`, поэтому карточки кампании складываются в столбец на любой ширине. Проверено экспериментом: возврат старого правила `grid-template-columns` возвращает y=420 на 1280×720, но одновременно ломает базовый CTA на 360×640 (y=670 при высоте 640). Старое число относилось к другой вёрстке.

Причина остатка дефекта: ниже 1100 px шелл складывает канвас, тактическую панель и HUD в одну вертикальную колонку. Закрытие требует изменения вёрстки (расширение breakpoint закреплённой полосы или правило по высоте для короткого landscape), а мандат `W1-05` — измерять, не меняя вёрстку и геймплей. Поэтому состояние трёх широких viewport **зафиксировано тестом как baseline** (таблица проверяется целиком, регресс упадёт), а ширины телефона проверяются как **требование**, а не как baseline. Отдельный тест доказывает, что боевой экран работоспособен: на 360×640 игрок выбирает цель, стреляет, и `ОТСТУПИТЬ` тоже достижимо. Вёрстку правит будущий тикет (кандидаты — `W2-02`, `W2-05`).

**Второй дефект, найденный `W1-04`: неизвестный `arenaId` вне активного encounter не отклоняется.** На `home`/`mission-select` активного encounter нет, поэтому cross-field правило, связывающее `arenaId` с `activeEncounterId`, не применяется, и `validateSave` не сверяет голый `arenaId` с `campaignCatalog.arenaIds`. Save с несуществующей ареной загружается, значение живёт в хранилище до следующей записи. Влияния на игрока сегодня нет: ни один экран не читает `arenaId` до старта encounter, а старт его перезаписывает. Зафиксировано исполняемым тестом, чтобы (а) не переоценивать утверждение «неизвестные ссылки каталога отклоняются» и (б) при ужесточении валидатора тест упал и изменение было замечено. Исправление означает правку `validateSave`, чего `W1-05`/`W1-04` не санкционируют.

## Guard от молча пропущенных тестовых файлов

`npm test` разделён на два project: `node` (`src/**/*.test.ts`, окружение node) и `dom` (`src/**/*.test.tsx`, jsdom). Разделение нужно по существу — DOM-тестам требуется jsdom, а остальным 130+ тестам не нужно платить ~0.8 с настройки jsdom на файл, — но у него есть отказ, не дающий вообще никакого вывода: файл, не попавший **ни в один** `include`, не собирается, и `vitest` при этом завершается кодом 0. Целый файл утверждений может перестать выполняться, а набор останется зелёным.

Проверено экспериментом, что оба существующих `*.dom.test.tsx` **действительно собираются** проектом `dom` (`vitest list` показывает их с префиксом `[dom]`, отдельный пробный `probe.test.tsx` тоже подхватывается). То есть утверждение, будто они пропускались, не подтвердилось. Реальный пробел был другой: **ничто не проверяло сам факт покрытия**. Файл вида `foo.spec.ts` под `src/` не собирается ни одним проектом — пробный `__orphan.spec.ts` подтвердил это молчаливым успехом.

Закрыто тремя мерами:

- `src/test/test-collection.test.ts` (3 теста): перечисляет тестовые файлы на диске, читает `include`-globs из настоящего `vite.config.ts` (не дублирует их, поэтому сужение `include` падает здесь, а не тихо теряет файл) и требует, чтобы каждый файл принадлежал **ровно одному** проекту, а `.tsx` уходил в jsdom, а `.ts` — в node. Guard проверен в обе стороны: с подкинутым `__orphan.spec.ts` он падает и называет файл, без него зелёный.
- Явный `exclude: ['src/**/*.test.tsx']` в проекте `node` — фиксирует, что `.tsx` туда не попадает (замерено: паттерн `*.test.ts` действительно не матчит `.tsx` в используемом glob-движке, 17 файлов из 17 без `.tsx`).
- `passWithNoTests: false` — `include`, не сматчивший **ничего**, теперь ошибка. Это дополняет guard: `passWithNoTests` ловит целиком пустой проект, а guard — проект, собравший часть файлов, но не все.

## Известное ограничение: anti-tamper отсутствует

Ручной rollback или правка `localStorage` **не защищены**, и это известное ограничение client-only save, а не дефект. Валидатор отклоняет *некорректные* save, но любой payload, удовлетворяющий схеме, принимается: save с XP 9999 и завершённой зоной загружается штатно. Зафиксировано исполняемым тестом (`save-reload.spec.ts`), чтобы ограничение было видно в наборе, а не только в прозе. Anti-tamper и cloud save вне scope `W1-04`.

## CI

- Job `verify`: `npm ci` + `npm run verify`. Работает и раньше.
- Job `e2e` (новый, `needs: verify`): устанавливает Chromium, запускает `npm run test:e2e`, при падении выгружает артефакты. Порядок выбран так, чтобы падение lint/typecheck/unit сообщалось за секунды, а не после скачивания браузера. Оба job должны быть обязательными для merge в `main` — branch protection настраивается в настройках репозитория, а не в workflow.
- Кэш браузеров: `~/.cache/ms-playwright`, ключ `playwright-${{ runner.os }}-<версия @playwright/test>`. Версия читается из установленного пакета, а он запинен точной версией в `package.json`, поэтому апгрейд Playwright промахивается по кэшу — это и требуется, чтобы старый браузер не оказался в паре с новым клиентом. При попадании в кэш ставятся только системные библиотеки (`install-deps`), так как apt-пакеты лежат вне кэшируемого каталога.
- **Что НЕ проверено фактическим прогоном.** Job `e2e` **никогда не выполнялся на GitHub Actions**: локально нет runner-а, и коммит/push этой работой не выполнялись. Локально удалось подтвердить только части: workflow — валидный YAML с ожидаемым графом job и шагов; шаг вычисления версии выдаёт `1.62.1`; `npx playwright install-deps chromium` реально запускает apt; `npx playwright install chromium` завершается успешно; `CI=1 npx playwright test` действительно делает один retry; при падении артефакты появляются именно в `code/test-results/` и `code/playwright-report/`, то есть по путям из шага upload. **Не подтверждено:** попадание и промах кэша `actions/cache`, установка системных пакетов на ubuntu-latest, фактическая загрузка артефакта, суммарное время прогона CI. Утверждать «CI зелёный» до первого прогона на ветке нельзя.
- Оценка времени: локально `verify` ~25 с, `test:e2e` ~1.6 мин (без скачивания браузера). Даже с запасом на установку браузера и холодный `npm ci` это укладывается в 15-минутный бюджет doc 24 §6, но фактическое время CI не измерено.

## Gate и ручная QA

M3-C automated checks, M3-D initial bundle budget, `W1-01`…`W1-05` DOM- и E2E-наборы confirmed локально. Покрыты и больше не являются пробелами: полный happy path зоны, порядок encounter, reward-поток с exactly-once, retreat без награды, reload-сценарии, recovery, измеренная геометрия на пяти viewport и гейтинг горячих клавиш в браузере.

**Остаётся непроверенным.** Runtime performance profiling (`W1-06`): статический gzip-бюджет не заменяет измерения. Визуальный регресс (`W1-08`). Accessibility walkthrough со скринридером. Ручная mobile QA на реальных устройствах (`W2-06`) — измерения `W1-05` сделаны в headless Chromium при заданном CSS-размере окна и **не** являются device-тестом: device pixel ratio, chrome браузера, экранная клавиатура, safe-area insets, реальный тач-ввод и WebKit не проверялись. Cross-browser матрица целиком: единственный project — `chromium`. Фактический прогон CI job `e2e`.

- Browser profiling remains unverified; the build budget is a static gzip gate, not a substitute for runtime performance measurement (`W1-06`).
- Command: `npm run verify` из `code/`. Отдельные шаги: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, `npm run analyze:budget`.
- E2E отдельно: `npm run test:e2e` (headed-прогон для визуальной проверки — `npm run test:e2e:headed`). Требует один раз `npx playwright install chromium`. Скрипты E2E сначала собирают свежий `dist/`, затем конфиг поднимает `vite preview` на порту 4317 с `reuseExistingServer: false`, чтобы уже запущенный preview-сервер не маскировал этот build. Трейс, скриншот и видео пишутся в `test-results/` только при падении.
- Фактический вывод `analyze:budget` на 23 августа 2026: initial JS 36.2 kB gzip (лимит 150), combat lazy JS 349.7 kB gzip (порог 1200) — не изменился после `W1-02`…`W1-05`.
- Отчёты ручной QA складываются в `design-data/qa/` по правилам [`design-data/README.md`](../design-data/README.md); на 23 августа 2026 отчётов нет ни одного.
