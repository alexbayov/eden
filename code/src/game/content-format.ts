/** One versioned envelope + validation primitives for every content file (arena/map, items, recipes, base upgrades, zones, missions). */
export const CONTENT_VERSION = 1

export interface ContentIssue { path: string; message: string }

export class ContentValidationError extends Error {
  readonly code: 'parse' | 'version' | 'shape'
  readonly issues: ContentIssue[]
  constructor(code: ContentValidationError['code'], issues: ContentIssue[]) {
    super(`Некорректный контент (${code}): ${issues.map((issue) => `${issue.path} — ${issue.message}`).join('; ')}`)
    this.name = 'ContentValidationError'
    this.code = code
    this.issues = issues
  }
}

export class ContentLoadError extends Error {
  readonly status: number
  constructor(url: string, status: number) {
    super(`Не удалось загрузить контент ${url} (${status})`)
    this.name = 'ContentLoadError'
    this.status = status
  }
}

export type ContentResult<T> = { ok: true; value: T } | { ok: false; error: ContentValidationError }

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Older files without `contentVersion` are treated as v1; any other version is an explicit error. */
export function migrateContent(value: unknown): unknown {
  if (isRecord(value) && value.contentVersion === undefined) return { ...value, contentVersion: CONTENT_VERSION }
  return value
}

/** Shared version gate so every content kind fails the same way on an unsupported file. */
export function checkEnvelope(input: unknown): ContentResult<Record<string, unknown>> {
  const value = migrateContent(input)
  if (!isRecord(value)) return { ok: false, error: new ContentValidationError('shape', [{ path: '$', message: 'ожидался объект' }]) }
  if (value.contentVersion !== CONTENT_VERSION) return { ok: false, error: new ContentValidationError('version', [{ path: '$.contentVersion', message: `поддерживается только ${CONTENT_VERSION}` }]) }
  return { ok: true, value }
}

export function checkEntries(value: unknown, kind: string, issues: ContentIssue[]): unknown[] {
  if (!isRecord(value) || value.kind !== kind) { issues.push({ path: '$.kind', message: `ожидалось "${kind}"` }); return [] }
  if (!Array.isArray(value.entries) || value.entries.length === 0) { issues.push({ path: '$.entries', message: 'непустой массив' }); return [] }
  return value.entries
}

export function checkUniqueIds(entries: { id: string }[], issues: ContentIssue[], path = '$.entries') {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) issues.push({ path: `${path}[${entry.id}]`, message: 'дублирующийся id' })
    seen.add(entry.id)
  }
}

/** Collection validator shared by every list-shaped content kind. */
export function validateCollection<T extends { id: string }>(input: unknown, kind: string, check: (value: unknown, path: string, issues: ContentIssue[]) => T | null): ContentResult<T[]> {
  const envelope = checkEnvelope(input)
  if (!envelope.ok) return envelope
  const issues: ContentIssue[] = []
  const entries = checkEntries(envelope.value, kind, issues)
  const values: T[] = []
  entries.forEach((entry, index) => { const checked = check(entry, `$.entries[${index}]`, issues); if (checked) values.push(checked) })
  if (issues.length === 0) checkUniqueIds(values, issues)
  return issues.length > 0 ? { ok: false, error: new ContentValidationError('shape', issues) } : { ok: true, value: values }
}

export async function fetchContent(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new ContentLoadError(url, response.status)
  try { return await response.json() as unknown } catch { throw new ContentValidationError('parse', [{ path: '$', message: 'ответ не является JSON' }]) }
}
