/**
 * W10-02 — the platform boundary's guarantees, as tests.
 *
 * The ticket's criteria are about what must *not* happen: no game path blocked, no network traffic, no data leaving the
 * device, no lost progress when a platform misbehaves. Those are properties of the default implementation and of
 * `withPlatform`, so they are checked here directly; the network half is additionally asserted in a real browser by
 * `e2e/platform-noop.spec.ts`, because "makes no requests" is only credible when something actually watches the wire.
 */
import { describe, expect, it, vi } from 'vitest'
import { noopPlatform, withPlatform, type Platform, type PlatformResult } from './platform'

describe('W10-02 the no-op platform is safe and total', () => {
  it('reports itself unavailable without making any method unsafe to call', () => {
    /* Criterion 2: `available` is for hiding platform-only affordances, never for correctness. Every method must be
       callable regardless, which is what makes the game complete without a platform. */
    expect(noopPlatform.available).toBe(false)
    for (const method of ['init', 'cloudSave', 'cloudLoad', 'submitScore', 'trackEvent'] as const)
      expect(typeof noopPlatform[method], method).toBe('function')
  })

  it('resolves every call instead of throwing or hanging', async () => {
    await expect(noopPlatform.init()).resolves.toEqual({ ok: true, value: undefined })
    await expect(noopPlatform.cloudSave('{}')).resolves.toEqual({ ok: true, value: undefined })
    await expect(noopPlatform.cloudLoad()).resolves.toMatchObject({ ok: false })
    await expect(noopPlatform.submitScore('zone', 1)).resolves.toMatchObject({ ok: false })
    expect(() => noopPlatform.trackEvent('mission-complete', { zone: 'water-line' })).not.toThrow()
  })

  it('distinguishes "no cloud payload" from "cloud save failed"', async () => {
    /* The distinction that protects local progress: a `cloudLoad` that reported success-with-null would tell the game
       the server holds an empty save, which is an invitation to overwrite a real local one. */
    const result = await noopPlatform.cloudLoad()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('platform-unavailable')
  })

  it('is idempotent on init', async () => {
    await expect(noopPlatform.init()).resolves.toEqual({ ok: true, value: undefined })
    await expect(noopPlatform.init()).resolves.toEqual({ ok: true, value: undefined })
  })

  it('performs no network call of any kind', () => {
    /* Criterion 3, at unit level: the no-op implementation must not reach for a transport at all. Asserted by stubbing
       every global the platform could use and proving none is touched — an absent `fetch` spy would pass vacuously, so
       each stub is installed and then checked for zero calls. */
    const fetchSpy = vi.fn()
    const xhrSpy = vi.fn()
    const original = { fetch: globalThis.fetch, xhr: globalThis.XMLHttpRequest }
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    globalThis.XMLHttpRequest = xhrSpy as unknown as typeof globalThis.XMLHttpRequest
    try {
      noopPlatform.trackEvent('shot-fired', { part: 'torso' })
      void noopPlatform.init()
      void noopPlatform.cloudSave('{"schemaVersion":7}')
      void noopPlatform.cloudLoad()
      void noopPlatform.submitScore('zone', 42)
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(xhrSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original.fetch
      globalThis.XMLHttpRequest = original.xhr
    }
  })

  it('sends no player data anywhere, because the analytics call is dropped', () => {
    /* Criterion 4. `trackEvent` accepts a payload so a real adapter has a shape to implement, but the default discards
       it: nothing about a player leaves the device unless an adapter is installed deliberately. */
    const payload = { heroHp: 24, zone: 'water-line' }
    expect(() => noopPlatform.trackEvent('encounter-start', payload)).not.toThrow();
    /* The payload object is not retained or mutated by the call. */
    expect(payload).toEqual({ heroHp: 24, zone: 'water-line' })
  })
})

describe('W10-02 a failing platform degrades safely (criterion 5)', () => {
  const throwing = (): Platform => ({
    available: true,
    init: () => Promise.reject(new Error('sdk exploded')),
    cloudSave: () => Promise.reject(new Error('quota')),
    cloudLoad: () => {
      throw new Error('synchronous throw')
    },
    submitScore: () => Promise.reject(new Error('offline')),
    trackEvent: () => {
      throw new Error('analytics down')
    },
  })

  it('turns a rejected promise into an ordinary failed result', async () => {
    const guarded = withPlatform(throwing())
    const init = await guarded.init()
    expect(init).toMatchObject({ ok: false, reason: 'sdk exploded' })
    await expect(guarded.cloudSave('{}')).resolves.toMatchObject({ ok: false, reason: 'quota' })
    await expect(guarded.submitScore('zone', 1)).resolves.toMatchObject({ ok: false, reason: 'offline' })
  })

  it('catches a synchronous throw from an SDK method', async () => {
    /* An adapter that throws before returning a promise is the case a bare `.catch()` would miss. */
    await expect(withPlatform(throwing()).cloudLoad()).resolves.toMatchObject({ ok: false, reason: 'synchronous throw' })
  })

  it('never lets analytics break a player action', () => {
    expect(() => withPlatform(throwing()).trackEvent('anything')).not.toThrow()
  })

  it('preserves a healthy adapter’s answers unchanged', () => {
    /* The guard must be transparent, or it would be indistinguishable from a platform that never works — which is how a
       wrapper silently disables a real integration. */
    const ok: PlatformResult<string | null> = { ok: true, value: 'payload' }
    const healthy: Platform = {
      available: true,
      init: async () => ({ ok: true, value: undefined }),
      cloudSave: async () => ({ ok: true, value: undefined }),
      cloudLoad: async () => ok,
      submitScore: async () => ({ ok: true, value: undefined }),
      trackEvent: () => {},
    }
    const guarded = withPlatform(healthy)
    expect(guarded.available).toBe(true)
    return Promise.all([
      expect(guarded.cloudLoad()).resolves.toEqual(ok),
      expect(guarded.init()).resolves.toEqual({ ok: true, value: undefined }),
    ])
  })
})
