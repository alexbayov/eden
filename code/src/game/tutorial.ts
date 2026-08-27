/**
 * W7-05 — first-session onboarding: the hints that make the first ten minutes explicable.
 *
 * **Why this does not touch the save schema.** The obvious implementation is a `tutorial` field in `SaveData`
 * and a v6 → v7 migration. Criterion 5 rules that out in as many words — «не требует особого сохранения» — and
 * on reflection the criterion is right rather than merely convenient:
 *
 *   - a tutorial flag is a *preference*, like "hints off", not campaign state. It has no catalog references to
 *     validate, no cross-field invariants, and no bearing on whether a save is loadable;
 *   - it should survive a save reset. Wiping a campaign does not unlearn the game, and re-teaching a returning
 *     player the movement controls because they restarted would be a bug, not a feature;
 *   - a migration is a permanent maintenance cost, and every future version has to carry the field forward.
 *
 * So progress lives under its own storage key. That is a smaller change *and* the honest model of what the data
 * is.
 *
 * **Why the current step is derived, not stored.** The only persisted facts are "has the player finished the
 * tutorial" and "are hints switched off". Which hint is showing right now is computed from the board — the hero
 * has not moved yet, no target is selected, the mission is won and unclaimed. A stored step counter would be a
 * second source of truth about the same situation and would desync the moment a player did something out of
 * order, which in a tactical game is most of the time. Deriving it means a hint can never describe a state the
 * player has already left.
 *
 * **Hints never block.** They are advisory text with a dismiss control, not a modal, not a forced sequence, and
 * not a gate on input (criterion 2). A tutorial that has to be obeyed is a worse tutorial than none in a genre
 * whose players expect to poke at things.
 */
import type { CampaignScreen } from './campaign'
import type { Unit } from './combat'

/** One teachable moment, in the order a first session encounters them. */
export type TutorialStepId =
  /** The base screen, before anything has happened. */
  | 'welcome'
  /** Getting into a mission at all. */
  | 'start-mission'
  /** Movement: the first thing a player has to do on the board. */
  | 'move'
  /** Cover, explained while it is still free to learn. */
  | 'cover'
  /** Choosing a target. */
  | 'select-target'
  /** Choosing a body part, and why the hit chance changes. */
  | 'body-part'
  /** Firing. */
  | 'fire'
  /** Ending a turn, including what Overwatch reserves. */
  | 'end-turn'
  /** Claiming the reward and returning to base. */
  | 'claim-reward'
  /** Spending what the mission paid for. */
  | 'craft'

export interface TutorialStep {
  id: TutorialStepId
  title: string
  /** What to do, in one sentence a first-time player can act on. */
  body: string
  /** The control this step is about, so the UI can point at it. Empty when it is a general note. */
  target: string
}

/**
 * The full sequence. Content rather than logic: the order is the order of `TutorialStepId`, and each entry says
 * what to do rather than what the system is doing.
 *
 * Deliberately short. Ten steps across two screens is about the limit of what a player will read before wanting
 * to play, and the ticket's own list is six items — the extra four are the ones a first session cannot proceed
 * without (`welcome`, `start-mission`, `fire`, `claim-reward`).
 */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'welcome',
    title: 'База',
    body: 'Это база. Здесь вы лечитесь, ремонтируете снаряжение и крафтите. Начните с выбора миссии.',
    target: 'ВЫБРАТЬ МИССИЮ',
  },
  {
    id: 'start-mission',
    title: 'Выбор миссии',
    body: 'Выберите первую операцию и нажмите «НАЧАТЬ». Перед вылазкой проверьте предупреждения о снаряжении.',
    target: 'НАЧАТЬ',
  },
  {
    id: 'move',
    title: 'Перемещение',
    body: 'Каждое действие стоит ОЧ. Выберите клетку в списке «Перемещение», чтобы подойти к противнику.',
    target: 'Перемещение',
  },
  {
    id: 'cover',
    title: 'Укрытия',
    body: 'Полное укрытие блокирует линию огня, частичное снижает точность стрелка. Прячьтесь за ними и выбивайте противника из его укрытия.',
    target: 'Перемещение',
  },
  {
    id: 'select-target',
    title: 'Цель',
    body: 'Выберите противника в списке «Видимые цели». Стрелять можно только по тем, к кому есть линия огня.',
    target: 'Видимые цели',
  },
  {
    id: 'body-part',
    title: 'Часть тела',
    body: 'Выберите часть тела: голова дороже и точность ниже, но урон и шанс крита выше. Таблица под кнопками показывает, из чего сложился шанс попадания.',
    target: 'ДЕЙСТВИЯ / КЛАВИАТУРА',
  },
  {
    id: 'fire',
    title: 'Выстрел',
    body: 'Нажмите «ОГОНЬ». Патрон и прочность оружия расходуются даже при промахе и осечке.',
    target: 'ОГОНЬ',
  },
  {
    id: 'end-turn',
    title: 'Конец хода',
    body: 'Закончите ход, когда ОЧ израсходованы. Overwatch вместо этого резервирует ОЧ на выстрел по тому, кто войдёт в вашу линию огня.',
    target: 'ЗАКОНЧИТЬ ХОД',
  },
  {
    id: 'claim-reward',
    title: 'Награда',
    body: 'Заберите награду — ресурсы и предметы попадут в stash на базе. Награда за операцию выдаётся один раз.',
    target: 'ЗАБРАТЬ НАГРАДУ',
  },
  {
    id: 'craft',
    title: 'Крафт',
    body: 'На базе тратьте ресурсы: бинты для лечения, патроны для пополнения, ремонт снаряжения. Улучшения узлов открывают новые рецепты.',
    target: 'Крафт',
  },
]

export const stepById = (id: TutorialStepId): TutorialStep => {
  const found = TUTORIAL_STEPS.find((step) => step.id === id)
  if (!found) throw new Error(`unknown tutorial step: ${id}`)
  return found
}

/**
 * Persisted onboarding state. Two booleans and a marker; deliberately nothing about *where* the player is.
 */
export interface TutorialState {
  /** Set once the player has seen the final step or dismissed the tutorial. */
  completed: boolean
  /** Set when the player switches hints off. Independent of `completed`. */
  dismissed: boolean
}

export const initialTutorialState = (): TutorialState => ({ completed: false, dismissed: false })

/** Storage key. Separate from the save so a campaign reset does not re-teach a returning player. */
export const TUTORIAL_STORAGE_KEY = 'eden.tutorial.v1'

/** Whether a stored value is usable. Malformed state falls back to "show the tutorial" rather than throwing. */
export const isTutorialState = (value: unknown): value is TutorialState =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as TutorialState).completed === 'boolean' &&
  typeof (value as TutorialState).dismissed === 'boolean'

export interface TutorialContext {
  state: TutorialState
  screen: CampaignScreen
  phase: string
  hero: Unit | undefined
  /** Living enemies, to know whether the fight is still on. */
  enemiesAlive: number
  /** Whether a target is currently selected. */
  hasTarget: boolean
  /** Whether the hero has spent any AP this mission, i.e. has acted at all. */
  heroHasActed: boolean
  /** Encounters already completed, so a returning player is not taught movement again. */
  completedEncounters: number
}

/**
 * The step to show right now, or `null` when nothing should be shown.
 *
 * Derived entirely from the situation. The ordering below is a series of "what is the most basic thing this
 * player has not done yet", which is why it reads as a cascade rather than a state machine: at any moment there
 * is exactly one most-basic missing action, and that is the hint worth showing.
 */
export function currentTutorialStep(context: TutorialContext): TutorialStep | null {
  const { state, screen, phase, hero, enemiesAlive, hasTarget, heroHasActed, completedEncounters } = context
  if (state.completed || state.dismissed) return null
  /* A player who has already finished an encounter does not need to be told how to move. */
  if (completedEncounters > 0 && screen === 'mission') return null

  switch (screen) {
    case 'home':
      /* Once something has been won, the base hint becomes the crafting one: the player now has resources. */
      return completedEncounters > 0 ? stepById('craft') : stepById('welcome')
    case 'mission-select':
      return stepById('start-mission')
    case 'reward':
      return stepById('claim-reward')
    case 'return':
      /* A defeat is not a teaching moment for the tutorial: the return screen explains itself. */
      return null
    case 'mission': {
      if (!hero || phase !== 'player') return null
      if (enemiesAlive === 0) return null
      /*
       * Ordered by what the player is *able* to do next, and `hasTarget` is checked before `heroHasActed` on
       * purpose. Selecting a target costs no AP, so a player who picks an enemy first — which is the natural
       * instinct, and what the shell's own control order invites — has still "not acted". Checking movement first
       * left the hint stuck on «Перемещение» while a target was already selected and the breakdown was on screen,
       * i.e. teaching a step the player had visibly moved past. Found by the browser spec.
       */
      if (hasTarget) return stepById(hero.ap >= 4 ? 'body-part' : 'end-turn')
      /* No target yet: movement is the lesson until the hero has closed the distance, then target selection. */
      if (!heroHasActed) return stepById('move')
      return stepById('select-target')
    }
  }
}

/**
 * Progress after the player advances past `id`.
 *
 * Completing the *last* step completes the tutorial. Advancing past any other step changes nothing persisted —
 * the position is derived, so there is nothing to store — which is why this returns the same object rather than
 * a rebuilt one, making "nothing was persisted" checkable by reference.
 */
export function advanceTutorial(state: TutorialState, id: TutorialStepId): TutorialState {
  if (state.completed || state.dismissed) return state
  const isLast = TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1].id === id
  return isLast ? { ...state, completed: true } : state
}

/** Switches hints off. Idempotent, so a double-press cannot produce a different state. */
export const dismissTutorial = (state: TutorialState): TutorialState =>
  state.dismissed ? state : { ...state, dismissed: true }

/** Switches hints back on and restarts them, for a player who wants the explanation again. */
export const resumeTutorial = (): TutorialState => initialTutorialState()

export interface TutorialView {
  step: TutorialStep
  /** 1-based position, for «шаг 3 из 10». */
  position: number
  total: number
  /** True on the final step, where advancing finishes the tutorial. */
  last: boolean
  /** Label for the advance control, which differs on the last step. */
  advanceLabel: string
  ariaLabel: string
}

/** The hint as the shell renders it, or `null` when no hint is due. */
export function buildTutorialView(context: TutorialContext): TutorialView | null {
  const step = currentTutorialStep(context)
  if (!step) return null
  const position = TUTORIAL_STEPS.findIndex((entry) => entry.id === step.id) + 1
  const total = TUTORIAL_STEPS.length
  const last = position === total
  return {
    step,
    position,
    total,
    last,
    advanceLabel: last ? 'ЗАВЕРШИТЬ ОБУЧЕНИЕ' : 'ПОНЯТНО',
    ariaLabel: `Подсказка ${position} из ${total}: ${step.title}. ${step.body}`,
  }
}
