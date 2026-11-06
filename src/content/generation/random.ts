/**
 * Create a repeatable random-number function keyed by seed and purpose, keeping unrelated
 * generated features independent.
 */
export function randomStream(seed: number, key: string) {
  let state = seed >>> 0;
  for (const char of key) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  /**
   * Advance this private random stream and return the next repeatable value between zero and
   * one.
   */
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
/**
 * Choose an integer from both ends of an inclusive range using the supplied deterministic
 * random stream.
 */
export function whole(random: () => number, range: readonly [number, number]) {
  return Math.floor(range[0] + random() * (range[1] - range[0] + 1));
}
/** Round generated coordinates to three decimals so content files stay stable and readable. */
export const round = (n: number) => Math.round(n * 1000) / 1000;
