/**
 * Per-run seed derivation for the balance simulator (W3-01).
 *
 * The whole point of the simulator is that a report can be reproduced byte for byte, so every
 * battle must get a seed that is a pure function of `(baseSeed, label, runIndex)` and nothing
 * else — no clock, no counter that depends on how many runs happened before, no `Math.random`.
 * `label` carries the arena/policy/mode identity so the same run index on two different arenas
 * does not replay the same dice.
 *
 * The mixing step is a plain FNV-1a hash of the label followed by three advances of the *game*
 * LCG (`nextRandom` from `game/rng.ts`). Using the shipped generator for whitening rather than
 * introducing a second PRNG keeps the simulator inside the save/RNG contract described in
 * docs/23 §8: the simulator never invents randomness, it only picks starting states for the
 * generator the game already uses.
 *
 * Known limitation, stated because it affects how much the numbers are worth: an LCG with
 * `% 100` is biased and two derived seeds are not independent streams in any cryptographic
 * sense. This is the generator the game ships (docs/23 records the same caveat), and the
 * simulator deliberately measures the shipped generator instead of a better one.
 */
import { nextRandom } from '../game/rng'

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
/** Advances through the game LCG applied to a mixed seed before it is handed to a battle. */
export const SEED_WHITENING_ROUNDS = 3

/** FNV-1a over UTF-16 code units. Deterministic across platforms and Node versions. */
export function hashLabel(label: string): number {
  let hash = FNV_OFFSET_BASIS >>> 0
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash ^ label.charCodeAt(index)) >>> 0
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** The seed used as `rngState` for one simulated battle. */
export function deriveSeed(baseSeed: number, label: string, runIndex: number): number {
  let state = ((baseSeed >>> 0) ^ hashLabel(`${label}#${runIndex}`)) >>> 0
  for (let round = 0; round < SEED_WHITENING_ROUNDS; round += 1) state = nextRandom(state).state
  return state >>> 0
}
