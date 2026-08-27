/**
 * W10-04 — release artefact audit.
 *
 * Checks the things a human reviewer reliably fails to notice in `dist/`, and refuses the release if any of them is
 * wrong. It runs against the built output, not the source, because that is the only place these questions have answers:
 * a rule about "no test fixtures shipped" cannot be checked by reading the repository, where the fixture legitimately
 * lives.
 *
 * What it enforces, and why each rule exists rather than being assumed:
 *
 *   1. **The version is present** in the artefact and matches `package.json` (criterion 5). A release nobody can
 *      identify cannot be bisected against a bug report.
 *   2. **No source maps** expose the original sources. Vite omits them by default, so this is a guard against a config
 *      change, not against today's build.
 *   3. **No test fixtures** in `dist/` (criterion 4). `public/config/arena.json` is the live example: it is read by five
 *      tests and by no shipped code path, so it must exist in the repo and *not* in the release.
 *   4. **Every catalog the manifest references is present**, and nothing in `dist/config` is unreferenced. A missing
 *      catalog is a boot failure; an extra one is either a fixture leak or a stale duplicate, both of which this ticket
 *      is about.
 *   5. **No debug logging** left in the shipped JavaScript.
 *
 * Exit codes follow the content validator's convention: `0` clean, `1` the artefact is wrong, `2` the check could not
 * run (missing build). Conflating "cannot check" with "check failed" is how a broken script starts reading as a
 * passing gate.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const problems = [];
const notes = [];

if (!existsSync(dist)) {
  console.error("dist/ отсутствует: сначала `npm run build`.");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const assets = join(dist, "assets");
const jsFiles = existsSync(assets)
  ? readdirSync(assets).filter((file) => file.endsWith(".js")).map((file) => join(assets, file))
  : [];
if (!jsFiles.length) {
  console.error("dist/assets не содержит JavaScript: сборка неполная.");
  process.exit(2);
}
const jsSource = jsFiles.map((file) => readFileSync(file, "utf8")).join("\n");

/* 1. Version present and matching. */
if (!jsSource.includes(pkg.version))
  problems.push(`версия ${pkg.version} из package.json не найдена в бандле — критерий 5 требует её в артефакте`);
else notes.push(`версия ${pkg.version} присутствует в бандле`);

/* 2. No source maps. */
const maps = existsSync(assets) ? readdirSync(assets).filter((file) => file.endsWith(".map")) : [];
if (maps.length) problems.push(`source map в релизе: ${maps.join(", ")} — исходники не публикуются без явного решения`);

/* 3 & 4. Catalogs: exactly what the manifest and the loaders reference. */
const configDir = join(dist, "config");
if (!existsSync(configDir)) problems.push("dist/config отсутствует: игра не загрузится");
else {
  const shipped = readdirSync(configDir).filter((file) => file.endsWith(".json"));
  const manifest = JSON.parse(readFileSync(join(configDir, "arena-manifest.json"), "utf8"));
  const arenaFiles = manifest.entries.map((entry) => entry.path.replace("/config/", ""));
  /* Catalogs loaded by fixed filename in `campaign-content.ts`/`app.tsx`, as opposed to via the manifest. */
  const fixedCatalogs = [
    "arena-manifest.json",
    "base-upgrades.json",
    "equipment.json",
    "item-effects.json",
    "items.json",
    "missions.json",
    "progression.json",
    "recipes.json",
    "return-tables.json",
    "rewards.json",
    "zones.json",
  ];
  const expected = new Set([...fixedCatalogs, ...arenaFiles]);
  for (const name of arenaFiles)
    if (!shipped.includes(name)) problems.push(`манифест ссылается на ${name}, но файла нет в dist/config`);
  for (const name of fixedCatalogs)
    if (!shipped.includes(name)) problems.push(`каталог ${name} обязателен для загрузки, но отсутствует в dist/config`);
  for (const name of shipped)
    if (!expected.has(name))
      problems.push(
        `${name} попал в релиз, но не читается ни манифестом, ни загрузчиком — тестовая фикстура или устаревший дубликат (критерий 4)`,
      );
  notes.push(`каталогов в релизе: ${shipped.length}, все ожидаемые`);
}

/*
 * 5. No debug logging **in our own code**.
 *
 * Scoped to first-party chunks deliberately. The first run of this check failed on nine `console.log` calls, all of them
 * inside `phaser.esm-*.js` — a dependency's internals, which we cannot strip and which the criterion is not about.
 * Counting them would have left a permanently red gate that the next person silences by deleting the rule. Vendor chunks
 * are reported as a finding instead, so the number is visible rather than hidden.
 */
const isVendor = (file) => /(?:^|[/\\])(?:phaser|preact)[.-]/i.test(file.split(/[/\\]/).at(-1));
const ownJs = jsFiles.filter((file) => !isVendor(file));
const ownDebug = [
  ...new Set(ownJs.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/console\.(log|debug|trace)\b/g)].map((m) => m[0]))),
];
if (ownDebug.length) problems.push(`отладочный вывод в собственном коде релиза: ${ownDebug.join(", ")}`);
const vendorDebug = jsFiles.filter(isVendor).reduce(
  (sum, file) => sum + [...readFileSync(file, "utf8").matchAll(/console\.(log|debug|trace)\b/g)].length,
  0,
);
if (vendorDebug) notes.push(`отладочных вызовов в vendor-чанках: ${vendorDebug} (не наш код, не блокирует релиз)`);

/* Size report against the doc 24 §6.3 release ceiling, as a finding rather than a hard gate: per-type asset budgets
   belong to W8/W9, and there are no assets yet. */
const totalBytes = (function walk(dir) {
  return readdirSync(dir).reduce((sum, entry) => {
    const full = join(dir, entry);
    return sum + (statSync(full).isDirectory() ? walk(full) : statSync(full).size);
  }, 0);
})(dist);
notes.push(`общий размер dist: ${(totalBytes / 1024 / 1024).toFixed(2)} МБ (потолок релиза doc 24 §6.3 — 8 МБ)`);
if (totalBytes > 8 * 1024 * 1024) problems.push(`релиз ${(totalBytes / 1024 / 1024).toFixed(2)} МБ превышает потолок 8 МБ`);

for (const note of notes) console.log(`ok  ${note}`);
for (const problem of problems) console.error(`ОШИБКА  ${problem}`);
console.log(
  problems.length ? `\nИтог: артефакт не готов к релизу, проблем: ${problems.length}.` : "\nИтог: артефакт релиза корректен.",
);
process.exit(problems.length ? 1 : 0);
