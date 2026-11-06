import { hyperspaceExitFraction } from '../game/jump-travel';
export type HyperspacePhase = 'departure' | 'wormhole' | 'arrival';
export type HyperspaceVisualState = {
  phase: HyperspacePhase;
  speed: number;
  tunnel: number;
  streak: number;
};
/** Ease a bounded presentation interval without coupling it to world time or browser frame rate. */
function smooth(from: number, to: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}
/** Choreograph acceleration, tunnel passage and a complete return to stationary point stars. */
export function hyperspaceVisualState(progress: number): HyperspaceVisualState {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const exit = smooth(hyperspaceExitFraction, 1, p);
  const speed = (0.12 + 0.88 * smooth(0, 0.23, p)) * (1 - exit);
  return {
    phase: p < 0.25 ? 'departure' : p < hyperspaceExitFraction ? 'wormhole' : 'arrival',
    speed,
    tunnel: smooth(0.18, 0.36, p) * (1 - smooth(0.69, 0.88, p)),
    streak: speed * (1 - smooth(0.82, 1, p))
  };
}
/** Project a visual star toward the viewer as its depth decreases; the vanishing point sits above the arrival text. */
export function projectHyperspaceStar(
  x: number,
  y: number,
  depth: number,
  width: number,
  height: number
) {
  const z = Math.max(0.04, depth);
  return { x: width * 0.5 + (x * width * 0.55) / z, y: height * 0.43 + (y * height * 0.65) / z };
}
