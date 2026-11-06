import { distance, type Vec3 } from './simulation';
/**
 * Choose a destination short of a contact so autopilot can brake at a useful interaction
 * distance.
 */
export function approachPoint(position: Vec3, target: Vec3, standOff = 85): Vec3 {
  const d = distance(position, target);
  if (d <= standOff) return { ...position };
  return {
    x: target.x + ((position.x - target.x) / d) * standOff,
    y: target.y + ((position.y - target.y) / d) * standOff,
    z: 0
  };
}
/**
 * Clamp an offscreen contact to HUD-safe screen edges and return its direction arrow, or
 * null if it is already visible.
 */
export function edgeGuide(
  point: { x: number; y: number },
  width: number,
  height: number,
  top: number,
  bottom: number
) {
  const left = 80,
    right = Math.max(left, width - 80),
    upper = Math.min(top, height / 2),
    lower = Math.max(upper, height - bottom);
  if (point.x >= left && point.x <= right && point.y >= upper && point.y <= lower) return null;
  const cx = width / 2,
    cy = (upper + lower) / 2,
    dx = point.x - cx,
    dy = point.y - cy;
  const tx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity,
    ty = dy > 0 ? (lower - cy) / dy : dy < 0 ? (upper - cy) / dy : Infinity,
    t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dy, dx) };
}
