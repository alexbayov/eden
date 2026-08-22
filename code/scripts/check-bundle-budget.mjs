import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const assets = join(root, "dist", "assets");
const initialLimit = 150 * 1024;
const combatLimit = 1_200 * 1024;

if (!existsSync(assets)) {
  console.error("Build output is missing: run npm run build first.");
  process.exit(1);
}

const files = readdirSync(assets)
  .filter((file) => file.endsWith(".js"))
  .map((file) => join(assets, file));
const source = (file) => readFileSync(file, "utf8");
const entryHtml = readFileSync(join(root, "dist", "index.html"), "utf8");
const entryNames = [...entryHtml.matchAll(/(?:src|href)=["']\/assets\/([^"']+\.js)["']/g)].map((match) => match[1]);
const byName = new Map(files.map((file) => [relative(assets, file), file]));
const staticImports = (text) => [...text.matchAll(/(?:from\s*["']|import\s*\()["']\.\/([^"']+\.js)["']/g)].map((match) => match[1]);
const entryFiles = entryNames.filter((name) => byName.has(name));
const initial = new Set(entryFiles);
const entrySource = entryFiles.map((name) => source(byName.get(name))).join("\n");
const combatFiles = new Set(
  [...entrySource.matchAll(/assets\/([^"'`]+\.js)/g)]
    .map((match) => match[1])
    .filter((name) => byName.has(name) && !initial.has(name)),
);
const visitStatic = (name) => {
  const file = byName.get(name);
  if (!file) return;
  for (const child of staticImports(source(file))) {
    if (!initial.has(child) && byName.has(child)) combatFiles.add(child);
    visitStatic(child);
  }
};
[...combatFiles].forEach(visitStatic);
const size = (names) => [...names].reduce((total, name) => total + gzipSync(source(byName.get(name))).length, 0);
const report = (label, names) => `${label}: ${(size(names) / 1024).toFixed(1)} kB gzip (${[...names].join(", ") || "none"})`;

console.log(report("Initial JS", initial));
console.log(report("Combat lazy JS", combatFiles));
if (size(initial) > initialLimit) {
  console.error(`Initial JS budget exceeded: ${initialLimit / 1024} kB gzip maximum.`);
  process.exitCode = 1;
}
if (size(combatFiles) > combatLimit) {
  console.error(`Combat lazy JS threshold exceeded: ${combatLimit / 1024} kB gzip threshold.`);
  process.exitCode = 1;
}
