/**
 * W10-02 — the platform boundary, with a safe no-op default.
 *
 * ## What this is, and what it deliberately is not
 *
 * Decision D-05 chose Yandex.Games for the first release. This module is **not** that integration: `W10-01` (the
 * compatibility specification) stays blocked because there is no local copy of the platform's SDK documentation, and
 * guessing method names, storage limits or consent requirements would produce code that looks integrated and is not.
 * What the ticket asks for and what is buildable today is the *boundary*: an interface the game talks to, whose default
 * implementation does nothing, so the game is complete without a platform and a real adapter can be dropped in behind
 * it later without touching a single call site.
 *
 * ## Why the default is no-op rather than absent
 *
 * The alternative — call the SDK when it happens to exist — spreads `if (window.ysdk)` through the codebase and makes
 * "does the game work outside the platform?" a question nobody can answer without auditing every branch. With a total
 * default, the answer is structural: `noopPlatform` satisfies the whole interface, so every path has an implementation.
 *
 * ## The two guarantees that are actually load-bearing
 *
 * 1. **No network traffic.** `noopPlatform` performs no `fetch`, no `XMLHttpRequest`, no dynamic `import()` of a remote
 *    script. Doc 16's no-P2W model and the privacy rule in doc 23 both depend on the game not phoning home, and an E2E
 *    spec asserts it by intercepting every request the page makes.
 * 2. **A platform failure never costs local progress.** Every method returns a result rather than throwing, and cloud
 *    save is explicitly *additive* to the local save — `cloudLoad` returning `null` means "nothing to merge", never
 *    "wipe what you have". `withPlatform` wraps a real adapter so that a rejected promise degrades to the same answer as
 *    an absent platform instead of propagating into the game loop.
 */

/** Result of a platform call. Never a thrown error: a platform is the least trustworthy thing in the process. */
export type PlatformResult<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface Platform {
  /**
   * Whether a real platform is behind this object.
   *
   * `false` for `noopPlatform`. Callers may use it to hide platform-only affordances (a leaderboard button), but must
   * never need it for correctness: every method is safe to call regardless.
   */
  readonly available: boolean
  /** Idempotent. Safe to call before the game renders and safe to call twice. */
  init(): Promise<PlatformResult<void>>
  /**
   * Stores an opaque payload. Additive to the local save, never a replacement for it.
   *
   * Takes a string rather than a `SaveData` so this module never becomes a second place that knows the save schema.
   */
  cloudSave(payload: string): Promise<PlatformResult<void>>
  /** `null` means "no cloud payload", which is a normal answer and not an error. */
  cloudLoad(): Promise<PlatformResult<string | null>>
  submitScore(board: string, value: number): Promise<PlatformResult<void>>
  /**
   * Records a gameplay event.
   *
   * Fire-and-forget by design: analytics must never be able to block or fail a player action. `noopPlatform` drops the
   * call entirely, which is also the privacy-preserving default — nothing about a player leaves the device unless a real
   * adapter is installed deliberately.
   */
  trackEvent(name: string, payload?: Readonly<Record<string, string | number | boolean>>): void
}

const unavailable = <T>(): PlatformResult<T> => ({ ok: false, reason: 'platform-unavailable' })

/**
 * The default platform: every call succeeds trivially or reports unavailability, and nothing leaves the device.
 *
 * `init` and `cloudSave` report success rather than failure on purpose. They are the paths the game *awaits* during
 * normal play, and a failed result there would push callers into writing "ignore this error" branches — which is how a
 * real platform failure later becomes invisible. `cloudLoad`/`submitScore` return unavailability because their answers
 * carry information the game would otherwise wrongly treat as "no data on the server".
 */
export const noopPlatform: Platform = {
  available: false,
  async init() {
    return { ok: true, value: undefined }
  },
  async cloudSave() {
    return { ok: true, value: undefined }
  },
  async cloudLoad() {
    return unavailable<string | null>()
  },
  async submitScore() {
    return unavailable<void>()
  },
  trackEvent() {
    /* Intentionally empty: see `trackEvent` above. Analytics is the one call the game does not await, and dropping it is
       both the safe default and the private one. */
  },
}

/**
 * Wraps a platform so that a thrown error or a rejected promise degrades to `noopPlatform`'s answer.
 *
 * Criterion 5 as a function rather than a convention: an SDK that throws synchronously, rejects, or hangs up mid-call
 * cannot take the game down with it, and local progress is untouched because none of these methods own it. A real
 * adapter can therefore be written straightforwardly, without defensive `try/catch` at every call site.
 */
export function withPlatform(platform: Platform): Platform {
  const guard = async <T>(call: () => Promise<PlatformResult<T>>): Promise<PlatformResult<T>> => {
    try {
      return await call()
    } catch (error) {
      /* A thrown SDK becomes an ordinary failed result. The message is kept because a swallowed platform error is
         undebuggable, but it never reaches the game as an exception. */
      return { ok: false, reason: error instanceof Error ? error.message : 'platform-error' }
    }
  }
  return {
    available: platform.available,
    init: () => guard(() => platform.init()),
    cloudSave: (payload) => guard(() => platform.cloudSave(payload)),
    cloudLoad: () => guard(() => platform.cloudLoad()),
    submitScore: (board, value) => guard(() => platform.submitScore(board, value)),
    trackEvent: (name, payload) => {
      try {
        platform.trackEvent(name, payload)
      } catch {
        /* Analytics may never affect gameplay, so a throwing adapter is swallowed here and nowhere else. */
      }
    },
  }
}
