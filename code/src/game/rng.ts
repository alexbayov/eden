export interface RngState { state: number }

export const DEFAULT_RNG_STATE = 0x6d2b79f5

export function nextRandom(state: number): { state: number; value: number } {
 const next = (Math.imul(state >>> 0, 1664525) + 1013904223) >>> 0
 return { state: next, value: next % 100 + 1 }
}

export function createRng(state = DEFAULT_RNG_STATE): RngState { return { state: state >>> 0 } }
