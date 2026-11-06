import { cruiseApproachRange } from './core/cruise';
import { distance, type Input, type Vec3, type World } from './simulation';
import { waypointOrder } from './core/pilot';

/**
 * Convert player destination orders into the shared simulation input; keep automatic fire
 * and cruise requests separate from physics.
 */
export class Navigation {
  destination: Vec3 | null = null;
  autoFire = true;
  cruiseRequested = false;
  radius = 1600;
  targetId: string | undefined;
  /**
   * Set a destination clamped inside the active system's soft boundary without teleporting
   * the ship.
   */
  moveTo(point: Vec3) {
    // Keep orders inside the sector's soft boundary.
    const scale = Math.min(1, (this.radius - 30) / Math.max(1, Math.hypot(point.x, point.y)));
    this.destination = { x: point.x * scale, y: point.y * scale, z: 0 };
  }
  /** Cancel the destination and cruise request so the next generated input brakes the hull. */
  stop() {
    this.destination = null;
    this.cruiseRequested = false;
  }
  /**
   * Toggle the player's cruise request only when a destination exists, returning whether the
   * request was accepted.
   */
  toggleCruise() {
    if (!this.destination) return false;
    this.cruiseRequested = !this.cruiseRequested;
    return true;
  }
  /**
   * Build this step's steering, braking, cruise and automatic-fire inputs, clearing a
   * destination after a slow arrival.
   */
  input(world: World): Input {
    const p = world.player;
    const input = waypointOrder(p, this.destination);
    input.cruise =
      this.cruiseRequested &&
      !!this.destination &&
      distance(p.position, this.destination) > cruiseApproachRange(p);
    input.fire = this.autoFire && !!this.targetId;
    input.targetId = this.targetId;
    if (
      this.destination &&
      distance(p.position, this.destination) < 8 &&
      Math.hypot(p.velocity.x, p.velocity.y) < 7
    )
      this.stop();
    return input;
  }
}
