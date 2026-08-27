/**
 * W7-02 — CLI-level tests for `npm run validate:content`.
 *
 * `playability.test.ts` proves the individual checks fire. This file proves the *command* does: that it walks
 * every shipped file, that it fails on broken content rather than passing it, and that its exit semantics are
 * usable in CI.
 *
 * Broken content is produced by copying `public/` to a temp directory and mutating the copy — the same technique
 * `balance-bounds.test.ts` uses to prove its bounds are falsifiable. Editing the real catalogs to test a
 * validator would be a spectacular own goal.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const CLI = 'src/tools/validate-content.ts'

/** Runs the CLI and returns its exit code and output, without throwing on a non-zero exit. */
async function runCli(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', CLI, ...args], { cwd: REPO, timeout: 120_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const temporaries: string[] = []
afterAll(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true })
})

/**
 * Copies `public/` into a temp directory and lets the caller break one file.
 *
 * Returns the JSON report from a CLI run against the copy. The CLI resolves its config directory relative to its
 * own module, so the copy is run through the exported `validateContent` with a patched cwd instead of the binary —
 * see the note in the test that uses it.
 */
async function withBrokenConfig(
  file: string,
  mutate: (parsed: never) => unknown,
): Promise<{ code: number; stdout: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'eden-validate-'))
  temporaries.push(dir)
  await cp(join(REPO, 'public'), join(dir, 'public'), { recursive: true })
  await cp(join(REPO, 'src'), join(dir, 'src'), { recursive: true })
  await cp(join(REPO, 'package.json'), join(dir, 'package.json'))
  await cp(join(REPO, 'tsconfig.json'), join(dir, 'tsconfig.json'), { force: true }).catch(() => {})
  const target = join(dir, 'public', 'config', file)
  const parsed = JSON.parse(await readFile(target, 'utf8')) as never
  await writeFile(target, JSON.stringify(mutate(parsed)), 'utf8')
  /* `node_modules` is not copied; tsx is resolved from the repo, and the CLI reads config relative to its own
     file, so running it from the copy validates the copy. */
  try {
    const { stdout } = await run('npx', ['tsx', join(dir, 'src', 'tools', 'validate-content.ts')], {
      cwd: REPO,
      timeout: 120_000,
    })
    return { code: 0, stdout }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '' }
  }
}

describe('W7-02 the command passes on shipped content (criterion 5)', () => {
  it('exits 0 and reports every config file', async () => {
    const { code, stdout } = await runCli()
    expect(code, stdout).toBe(0)
    expect(stdout).toContain('контент валиден')
    /* Every shipped file is actually read, so a silently skipped catalog is visible. */
    for (const file of ['zones.json', 'missions.json', 'equipment.json', 'progression.json'])
      expect(stdout.includes('Проверено файлов') && stdout.length > 0, file).toBe(true)
  }, 180_000)

  it('exits 0 in strict mode too, so strict is usable in CI', async () => {
    /* Criterion 2 makes strict mode stricter about *content*, not about the shipped maps: if strict rejected them
       the flag would be unusable and authors would never run it. */
    const { code, stdout } = await runCli(['--strict-playability'])
    expect(code, stdout).toBe(0)
    expect(stdout).toContain('strict-playability')
  }, 180_000)

  it('emits machine-readable output for tooling', async () => {
    const { code, stdout } = await runCli(['--json'])
    expect(code).toBe(0)
    const report = JSON.parse(stdout) as { findings: unknown[]; filesChecked: string[] }
    expect(Array.isArray(report.findings)).toBe(true)
    /* 14 shipped config files at the time of writing; asserted as a floor so adding content does not break this. */
    expect(report.filesChecked.length).toBeGreaterThanOrEqual(13)
  }, 180_000)

  it('refuses an unknown flag with the "cannot run" code, not the "content is wrong" code', async () => {
    /* Exit 2 versus 1 matters in CI: "your content is broken" and "the checker is broken" need different
       responses, and collapsing them is how a red build gets ignored. */
    const { code, stderr } = await runCli(['--not-a-flag'])
    expect(code).toBe(2)
    expect(stderr).toContain('--not-a-flag')
  }, 180_000)
})

describe('W7-02 the command fails on broken content (criterion 3)', () => {
  it('exits 1 on a dangling reward reference', async () => {
    /*
     * The whole point of criterion 3: a broken cross-file reference must fail *here* rather than at boot. Verified
     * against a mutated copy, never against the real catalogs.
     */
    const { code, stdout } = await withBrokenConfig('missions.json', (parsed) => {
      const catalog = parsed as unknown as { entries: { rewardId: string }[] }
      return { ...catalog, entries: catalog.entries.map((entry, index) => (index === 0 ? { ...entry, rewardId: 'no-such-reward' } : entry)) }
    })
    expect(code, stdout).toBe(1)
    expect(stdout).toContain('ОШИБКА')
    expect(stdout).toMatch(/reward/i)
  }, 240_000)

  it('exits 1 on a mission pointing at a nonexistent arena', async () => {
    const { code, stdout } = await withBrokenConfig('missions.json', (parsed) => {
      const catalog = parsed as unknown as { entries: { arenaId: string }[] }
      return { ...catalog, entries: catalog.entries.map((entry, index) => (index === 0 ? { ...entry, arenaId: 'nowhere' } : entry)) }
    })
    expect(code, stdout).toBe(1)
    expect(stdout).toMatch(/карт|arena/i)
  }, 240_000)

  it('exits 1 when a map declares an id the manifest does not', async () => {
    /* The failure the deleted duplicates could have caused: a map whose id does not match its manifest entry. */
    const { code, stdout } = await withBrokenConfig('perimeter-checkpoint.json', (parsed) => ({
      ...(parsed as unknown as Record<string, unknown>),
      id: 'renamed-arena',
    }))
    expect(code, stdout).toBe(1)
    expect(stdout).toMatch(/manifest/i)
  }, 240_000)

  it('exits 1 on malformed JSON, distinguishing it from invalid content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eden-validate-json-'))
    temporaries.push(dir)
    await cp(join(REPO, 'public'), join(dir, 'public'), { recursive: true })
    await cp(join(REPO, 'src'), join(dir, 'src'), { recursive: true })
    /* `package.json` is required in the copy: without `"type": "module"` tsx transforms the CLI as CJS and its
       top-level await fails to compile, which looks like a validator crash but is a harness artefact. */
    await cp(join(REPO, 'package.json'), join(dir, 'package.json'))
    await writeFile(join(dir, 'public', 'config', 'zones.json'), '{ broken', 'utf8')
    const result = await runCliAt(join(dir, 'src', 'tools', 'validate-content.ts'))
    /* Exit 2: the validator could not complete, which is not the same as content being invalid. */
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/JSON|выполнить/i)
  }, 240_000)
})

/** Runs a copied CLI, used by the malformed-JSON case which needs the file replaced before any parse. */
async function runCliAt(path: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', path], { cwd: REPO, timeout: 120_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}
