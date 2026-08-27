/**
 * W7-05 — onboarding tests.
 *
 * Criterion 1 («новичок доходит до первой победы без внешней документации») cannot be *proved* by a unit test —
 * it is ultimately a claim about a person, and the ticket says so by asking for manual QA. What a test can do is
 * check the property the claim rests on: **at every state a first session passes through, some hint is due, and it
 * is the one about the most basic thing not yet done.** A gap in that chain is a moment where a new player is on
 * their own, and that is checkable.
 *
 * So the central test walks a first session end to end and asserts no state is left unexplained. The rest pin the
 * two properties that make the tutorial safe: it never blocks, and it never re-teaches.
 */
import { describe, expect, it } from 'vitest'
import {
  TUTORIAL_STEPS,
  TUTORIAL_STORAGE_KEY,
  advanceTutorial,
  buildTutorialView,
  currentTutorialStep,
  dismissTutorial,
  initialTutorialState,
  isTutorialState,
  resumeTutorial,
  stepById,
  type TutorialContext,
  type TutorialState,
} from './tutorial'
import { AP_PER_TURN, type Unit } from './combat'

const hero = (overrides: Partial<Unit> = {}): Unit => ({
  id: 'hero',
  name: 'Оперативник',
  hp: 24,
  maxHp: 24,
  team: 'player',
  aim: 72,
  color: '#ffffff',
  ap: AP_PER_TURN,
  x: 0,
  y: 0,
  ...overrides,
})

const context = (overrides: Partial<TutorialContext> = {}): TutorialContext => ({
  state: initialTutorialState(),
  screen: 'home',
  phase: 'player',
  hero: hero(),
  enemiesAlive: 1,
  hasTarget: false,
  heroHasActed: false,
  completedEncounters: 0,
  ...overrides,
})

describe('W7-05 a first session is never left unexplained (criterion 1)', () => {
  it('has a hint due at every state a first playthrough passes through', () => {
    /*
     * The property criterion 1 actually rests on. A gap here is a moment where a brand-new player has no guidance,
     * which is precisely what "without external documentation" forbids. Each entry is a real state the shell
     * produces, in the order a first session reaches them.
     */
    const journey: [string, TutorialContext][] = [
      ['base, nothing done', context({ screen: 'home' })],
      ['mission select', context({ screen: 'mission-select' })],
      ['mission, not yet acted', context({ screen: 'mission', heroHasActed: false })],
      ['mission, moved, no target', context({ screen: 'mission', heroHasActed: true, hasTarget: false })],
      ['mission, target chosen', context({ screen: 'mission', heroHasActed: true, hasTarget: true })],
      [
        'mission, out of AP',
        context({ screen: 'mission', heroHasActed: true, hasTarget: true, hero: hero({ ap: 1 }) }),
      ],
      ['reward screen', context({ screen: 'reward' })],
      ['back at base after a win', context({ screen: 'home', completedEncounters: 1 })],
    ]
    for (const [label, built] of journey) {
      const step = currentTutorialStep(built)
      expect(step, `${label}: no hint due`).not.toBeNull()
      expect(step!.body.length, label).toBeGreaterThan(0)
    }
  })

  it('teaches the most basic missing action first, not the most recent one', () => {
    /* The ordering is the design: at any moment there is exactly one most-basic thing not yet done, and that is the
       hint worth showing. Movement precedes targeting, targeting precedes the body part. */
    expect(currentTutorialStep(context({ screen: 'mission' }))!.id).toBe('move')
    expect(currentTutorialStep(context({ screen: 'mission', heroHasActed: true }))!.id).toBe('select-target')
    expect(
      currentTutorialStep(context({ screen: 'mission', heroHasActed: true, hasTarget: true }))!.id,
    ).toBe('body-part')
  })

  it('follows a target selected before moving, since selecting costs no AP', () => {
    /*
     * Found by the browser spec. Selecting a target is free, so a player who picks an enemy first — the natural
     * instinct, and what the shell's control order invites — has still "not acted". Checking movement first pinned
     * the hint on «Перемещение» while a target was selected and the breakdown was already on screen, teaching a step
     * the player had visibly moved past.
     */
    const targeted = context({ screen: 'mission', heroHasActed: false, hasTarget: true })
    expect(currentTutorialStep(targeted)!.id).toBe('body-part')
    /* And with the AP spent, the lesson becomes ending the turn rather than another shot. */
    expect(currentTutorialStep({ ...targeted, hero: hero({ ap: 1 }) })!.id).toBe('end-turn')
  })

  it('covers every step the ticket lists, and each names the control it is about', () => {
    /* The ticket's own list: movement, body part, cover, ending a turn, returning to base, crafting. */
    const ids = TUTORIAL_STEPS.map((step) => step.id)
    for (const required of ['move', 'body-part', 'cover', 'end-turn', 'claim-reward', 'craft'] as const)
      expect(ids, `missing required step ${required}`).toContain(required)
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length, step.id).toBeGreaterThan(0)
      expect(step.body.length, step.id).toBeGreaterThan(20)
    }
    /* Unique ids, or `stepById` would silently return the wrong entry. */
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('numbers the hints so a player can see how much is left', () => {
    const view = buildTutorialView(context({ screen: 'mission-select' }))!
    expect(view.position).toBeGreaterThan(0)
    expect(view.total).toBe(TUTORIAL_STEPS.length)
    expect(view.ariaLabel).toContain(String(view.total))
    /* The last step's control says it finishes rather than continues. */
    const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1]
    expect(buildTutorialView(context({ screen: 'home', completedEncounters: 1 }))!.step.id).toBe(last.id)
    expect(buildTutorialView(context({ screen: 'home', completedEncounters: 1 }))!.advanceLabel).toContain(
      'ЗАВЕРШИТЬ',
    )
  })
})

describe('W7-05 hints are skippable and never re-teach (criteria 2 and 3)', () => {
  it('shows nothing at all once dismissed', () => {
    /* Criterion 2's real requirement: switching hints off must actually switch them off, everywhere, not just on
       the screen where the button was pressed. */
    const dismissed = dismissTutorial(initialTutorialState())
    for (const screen of ['home', 'mission-select', 'mission', 'reward'] as const)
      expect(currentTutorialStep(context({ state: dismissed, screen })), screen).toBeNull()
  })

  it('shows nothing once completed', () => {
    const completed: TutorialState = { completed: true, dismissed: false }
    expect(currentTutorialStep(context({ state: completed, screen: 'home' }))).toBeNull()
    expect(buildTutorialView(context({ state: completed, screen: 'mission' }))).toBeNull()
  })

  it('completes only on the final step, and stores nothing in between', () => {
    /*
     * The position is derived, so advancing past an intermediate step has nothing to persist — asserted by
     * *reference*, so a rebuilt-but-equal object would fail. That is what keeps the stored state to two booleans.
     */
    const start = initialTutorialState()
    const midway = advanceTutorial(start, 'move')
    expect(midway).toBe(start)

    const last = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1].id
    const finished = advanceTutorial(start, last)
    expect(finished.completed).toBe(true)
    expect(finished).not.toBe(start)
  })

  it('is idempotent on dismissal and on advancing after the end', () => {
    /* A double-press must not produce a different state than a single one. */
    const once = dismissTutorial(initialTutorialState())
    expect(dismissTutorial(once)).toBe(once)
    const done: TutorialState = { completed: true, dismissed: false }
    expect(advanceTutorial(done, 'move')).toBe(done)
  })

  it('can be switched back on, so dismissing is a preference rather than a trap', () => {
    const resumed = resumeTutorial()
    expect(resumed).toEqual(initialTutorialState())
    expect(currentTutorialStep(context({ state: resumed, screen: 'home' }))).not.toBeNull()
  })

  it('stops teaching combat basics to a player who has already won an encounter', () => {
    /*
     * Criterion 3 read strictly. A returning player who restarts a campaign should not be walked through movement
     * again — and because the tutorial lives outside the save, a campaign reset does not reset it either.
     */
    const veteran = context({ screen: 'mission', completedEncounters: 1, heroHasActed: false })
    expect(currentTutorialStep(veteran)).toBeNull()
    /* The base hint does change though: with a win banked there are resources to spend. */
    expect(currentTutorialStep(context({ screen: 'home', completedEncounters: 1 }))!.id).toBe('craft')
    expect(currentTutorialStep(context({ screen: 'home', completedEncounters: 0 }))!.id).toBe('welcome')
  })
})

describe('W7-05 hints stay out of the way', () => {
  it('shows nothing during the enemy phase', () => {
    /* Nothing the player can act on, so a hint would be noise at the moment they are watching the board. */
    expect(currentTutorialStep(context({ screen: 'mission', phase: 'enemy' }))).toBeNull()
  })

  it('shows nothing once the board is clear, leaving the outcome to speak for itself', () => {
    expect(currentTutorialStep(context({ screen: 'mission', enemiesAlive: 0, heroHasActed: true }))).toBeNull()
  })

  it('shows nothing on the return screen, which explains itself', () => {
    /* A defeat is not a teaching moment: the return screen already states the penalty and what was lost. */
    expect(currentTutorialStep(context({ screen: 'return' }))).toBeNull()
  })

  it('shows nothing without a hero', () => {
    expect(currentTutorialStep(context({ screen: 'mission', hero: undefined }))).toBeNull()
  })
})

describe('W7-05 stored state is defensive (criterion 5)', () => {
  it('lives under its own key, so a save reset does not re-teach the player', () => {
    /*
     * The reason this is not a save field: it is a preference, not campaign state. It has no catalog references,
     * no cross-field invariants, and wiping a campaign does not unlearn the controls — so it costs no schema
     * migration either.
     */
    expect(TUTORIAL_STORAGE_KEY).toBe('eden.tutorial.v1')
    expect(TUTORIAL_STORAGE_KEY.startsWith('eden.save')).toBe(false)
  })

  it('accepts only a well-formed pair of booleans', () => {
    /* A malformed preference must fall back to "show the tutorial" rather than throw: a broken preference must
       never stop the game from booting. */
    expect(isTutorialState({ completed: false, dismissed: false })).toBe(true)
    expect(isTutorialState({ completed: true, dismissed: true })).toBe(true)
    expect(isTutorialState({ completed: 'yes', dismissed: false })).toBe(false)
    expect(isTutorialState({ completed: false })).toBe(false)
    expect(isTutorialState(null)).toBe(false)
    expect(isTutorialState('done')).toBe(false)
  })

  it('exposes every step by id, so a stale reference fails loudly', () => {
    for (const step of TUTORIAL_STEPS) expect(stepById(step.id)).toBe(step)
    expect(() => stepById('nope' as never)).toThrow()
  })
})
