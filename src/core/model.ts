// Renderer-independent simulation. XY is the flight plane; Z is reserved for elevation.
/**
 * Position/vector record retaining Z for visual geometry and future expansion; current
 * flight and distance calculations use the XY plane.
 */
export type Vec3 = { x: number; y: number; z: number };
/**
 * Mutable hull and inventory record shared by simulation and its owning session or actor.
 * Culture belongs to the captain/actor, not to this hull.
 */
export type Ship = {
  designId?: string;
  livery?: string;
  id: string;
  name: string;
  kind: 'cutter' | 'merchant';
  owner: string;
  factionId: string;
  role: 'idle' | 'trader' | 'hostile';
  position: Vec3;
  velocity: Vec3;
  heading: number;
  hull: number;
  engines: number;
  crew: number;
  cargo: Record<string, number>;
  reload: [number, number];
};
/**
 * Transient broadside projectile; lifetime and movement are simulated in seconds and
 * damage mode distinguishes disabling from hull fire.
 */
export type Shot = {
  position: Vec3;
  velocity: Vec3;
  life: number;
  owner: string;
  disable: boolean;
};
export type DefenceRound = {
  position: Vec3;
  velocity: Vec3;
  life: number;
  owner: string;
  mount: number;
};
/**
 * Persistent per-hull PDC equipment timers and counters; actual flying rounds remain
 * transient combat state.
 */
export type DefenceState = {
  cooldown: number;
  mount: number;
  interceptions: number;
  roundsFired: number;
  burstRemaining: number;
  cadence: number;
};
export type Event = {
  type: 'fire' | 'hit' | 'intercept' | 'pdc-fire';
  position: Vec3;
  player: boolean;
  origin?: Vec3;
  mount?: number;
  shipId?: string;
};
/**
 * One simulation-step control request shared by player navigation and NPC steering;
 * heading uses radians and thrust/brake are interpreted by movement.
 */
export type Input = {
  turn: number;
  thrust: number;
  brake: boolean;
  fire: boolean;
  heading?: number;
  targetId?: string;
  cruise?: boolean;
};
const pdc = { range: 150, cooldown: 0.8, burstSize: 3, interval: 0.06, speed: 900, hitRadius: 3.2 };
const cruise = {
  multiplier: 4,
  spoolSeconds: 1.5,
  turnMultiplier: 0.55,
  combatRange: 750,
  projectileRange: 260,
  hitLockSeconds: 3,
  approachSeconds: 1.25,
  minApproachRange: 360
};
export const definitions = {
  cutter: {
    speed: 115,
    turn: 1.8,
    reload: 2.3,
    length: 46,
    cargoCapacity: 20,
    cruise: { ...cruise },
    pointDefence: { ...pdc }
  },
  merchant: {
    speed: 65,
    turn: 0.7,
    reload: 3.8,
    length: 70,
    cargoCapacity: 60,
    cruise: { ...cruise },
    pointDefence: { ...pdc }
  }
};
/**
 * Measure planar separation in simulation units; Z is currently presentation data rather
 * than flight distance.
 */
export const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y);
/**
 * Return the shortest signed angular difference in radians, avoiding discontinuities
 * across a full turn.
 */
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const pointDefenceMounts = [
  { x: 0.16, y: 0.18, z: 0.18 },
  { x: -0.24, y: -0.18, z: 0.18 }
] as const;
/**
 * Rotate a normalized PDC hardpoint by ship heading and scale it to the hull's world-space
 * length.
 */
export function mountPosition(
  ship: Pick<Ship, 'kind' | 'heading' | 'position'>,
  index: number
): Vec3 {
  const m = pointDefenceMounts[index],
    l = definitions[ship.kind].length,
    c = Math.cos(ship.heading),
    s = Math.sin(ship.heading);
  return {
    x: ship.position.x + (m.x * c - m.y * s) * l,
    y: ship.position.y + (m.x * s + m.y * c) * l,
    z: m.z * l
  };
}
/** Create independent zeroed PDC timers and counters for a new hull. */
export const freshDefence = (): DefenceState => ({
  cooldown: 0,
  mount: 0,
  interceptions: 0,
  roundsFired: 0,
  burstRemaining: 0,
  cadence: 0
});
/** Build a relative XY vector for interception and collision calculations. */
export const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: 0 });
/**
 * Project a position along a velocity for a duration in seconds, preserving its current
 * elevation.
 */
export const advance = (p: Vec3, v: Vec3, t: number): Vec3 => ({
  x: p.x + v.x * t,
  y: p.y + v.y * t,
  z: p.z
});
/**
 * Solve swept-circle contact along a relative segment; return a frame fraction or null
 * when the objects miss.
 */
export function contactTime(start: Vec3, end: Vec3, radius: number): number | null {
  const dx = end.x - start.x,
    dy = end.y - start.y,
    c = start.x * start.x + start.y * start.y - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = 2 * (start.x * dx + start.y * dy),
    discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}
/**
 * Solve the constant-speed interception equation and return the earliest nonnegative
 * flight time, or null if interception is impossible.
 */
export function leadTime(origin: Vec3, target: Shot, speed: number) {
  const r = subtract(target.position, origin),
    v = target.velocity,
    a = v.x * v.x + v.y * v.y - speed * speed,
    b = 2 * (r.x * v.x + r.y * v.y),
    c = r.x * r.x + r.y * r.y;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  if (Math.abs(a) < 1e-6) return b < 0 ? -c / b : null;
  const roots = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter(
    /**
     * Retain only intercept solutions occurring in the future and before the target projectile
     * expires.
     */
    (t) => t > 0 && t < target.life
  );
  return roots.length ? Math.min(...roots) : null;
}
