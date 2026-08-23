/**
 * Guard against silently skipped test files.
 *
 * `npm test` splits into two Vitest projects: `node`, which includes every `.test.ts` file under
 * `src`, and `dom`, which includes every `.test.tsx` file under `src`. That split is a correctness
 * mechanism — the DOM files need jsdom and the rest must not pay 0.8 s of jsdom setup each — but it
 * has a failure mode that produces no output at all: a test file matched by *neither* `include` is
 * never collected, and Vitest still exits 0. A whole file of assertions can stop running while the
 * suite stays green.
 *
 * Concrete ways that happens, all cheap mistakes:
 *
 *   • A DOM test named `foo.test.tsx` when the `dom` include is narrowed to `*.dom.test.tsx`.
 *   • A test named `foo.spec.ts` under `src/`, matched by neither project's include.
 *   • A test named `foo.test.mts` / `.mtsx`, likewise unmatched.
 *
 * The first case is the one this repository actually shipped a risk of: `include` used to be the only
 * thing pointing jsdom at the two shell tests, with nothing asserting the pointer still resolved.
 *
 * So this test enumerates test-looking files under `src/` from the filesystem and asserts each is
 * claimed by exactly one project's pattern. It reads the *real* `vite.config.ts` include globs rather
 * than restating them, so editing the config cannot drift away from this guard — narrowing an include
 * fails here instead of quietly dropping a file.
 *
 * `passWithNoTests: false` in the config is the complementary half: it catches an include that matches
 * *nothing* (a whole project silently empty). This test catches an include that matches *some* files
 * but not all of them, which `passWithNoTests` cannot see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const codeRoot = new URL("../../", import.meta.url).pathname;
const srcRoot = join(codeRoot, "src");

/** Anything a reader would reasonably expect `npm test` to run. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?tsx?$/;

/** Every test-looking file under `src/`, as POSIX-style paths relative to `code/`. */
function findTestFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules") continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...findTestFiles(absolute));
      continue;
    }
    if (TEST_FILE_PATTERN.test(entry)) found.push(relative(codeRoot, absolute).split("\\").join("/"));
  }
  return found.sort();
}

/**
 * The `include` globs actually configured, read out of `vite.config.ts` as text.
 *
 * Text extraction rather than importing the config: importing it pulls the Preact plugin and the
 * whole Vite pipeline into a node-environment unit test for no benefit, and the config is a plain
 * literal list. The equality assertion below fails if the shape ever stops being extractable, so this
 * cannot silently start reading zero patterns and passing vacuously.
 *
 * Comments are dropped *line-wise* rather than with a block-comment regex on purpose. Such a regex
 * is actively wrong here: a recursive glob contains the byte sequence that both opens and closes a
 * block comment, so the regex deletes the very patterns this function exists to read — which is how
 * the first version of this guard reported all 20 files as uncollected.
 */
function configuredIncludes(): string[] {
  const config = readFileSync(join(codeRoot, "vite.config.ts"), "utf8");
  const code = config
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
    })
    .join("\n");
  return [...code.matchAll(/include:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((quoted) => quoted[1]),
  );
}

/**
 * Minimal matcher for the two recursive glob shapes the config uses. Deliberately not a
 * general glob engine: a hand-rolled one that silently mismatched would defeat the purpose. Any
 * pattern outside the supported shape throws, so an unsupported glob fails loudly here rather than
 * being treated as "matches nothing".
 */
function globToRegExp(pattern: string): RegExp {
  if (!/^[\w./*-]+$/.test(pattern)) throw new Error(`unsupported glob for this guard: ${pattern}`);
  const source = pattern
    .split("**/")
    .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`);
}

describe("npm test collects every test file under src/", () => {
  const testFiles = findTestFiles(srcRoot);
  const includes = configuredIncludes();

  it("finds the test files and the include patterns it is supposed to compare", () => {
    /* Stops the whole guard from passing vacuously if either side reads as empty. */
    expect(testFiles.length, "expected to discover test files under src/").toBeGreaterThan(10);
    expect(includes, "expected the node and dom include globs from vite.config.ts").toEqual([
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ]);
  });

  it("claims each test file with exactly one project include", () => {
    const matchers = includes.map((pattern) => ({ pattern, regex: globToRegExp(pattern) }));
    const claims = testFiles.map((file) => ({
      file,
      by: matchers.filter((matcher) => matcher.regex.test(file)).map((matcher) => matcher.pattern),
    }));

    /* Named separately so a failure says which file is orphaned and which is double-claimed, rather
       than printing one opaque diff. A file claimed twice would run in both environments, which is
       wasted time and a confusing pair of results for the same assertions. */
    expect(
      claims.filter((claim) => claim.by.length === 0).map((claim) => claim.file),
      "these files are collected by no Vitest project and therefore never run",
    ).toEqual([]);
    expect(
      claims.filter((claim) => claim.by.length > 1),
      "these files are collected by more than one Vitest project",
    ).toEqual([]);
  });

  it("routes .tsx files to the jsdom project and .ts files to the node project", () => {
    /* The environment split is the reason the projects exist, so the routing itself is asserted:
       a `.tsx` file landing in the node project fails on `document is not defined`, and a `.ts`
       file landing in jsdom silently pays the setup cost the split exists to avoid.
       Scoped to the `.test.` naming the includes actually target; a stray `.spec.ts` is an orphan,
       which the previous test already reports without this one adding a confusing second message. */
    const nodeRegex = globToRegExp("src/**/*.test.ts");
    const domRegex = globToRegExp("src/**/*.test.tsx");
    for (const file of testFiles.filter((entry) => /\.test\.tsx?$/.test(entry))) {
      const expectDom = file.endsWith(".tsx");
      expect(domRegex.test(file), `${file} should ${expectDom ? "" : "not "}be a dom-project file`).toBe(expectDom);
      expect(nodeRegex.test(file), `${file} should ${expectDom ? "not " : ""}be a node-project file`).toBe(!expectDom);
    }
  });
});
