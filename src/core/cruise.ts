import { angleDelta, definitions, distance, type Ship, type Input, type Shot } from './model';
import type { Relations } from './relations';
import type { MovementModifiers } from './movement';
import type { CombatBody } from './ecs/components';
export type CruiseState = {
  phase: 'off' | 'charging' | 'active' | 'blocked';
  charge: number;
  lockout: number;
  reason: string | null;
};
const normal: MovementModifiers = { speedMultiplier: 1, turnMultiplier: 1 };
/**
 * Calculate the distance at which navigation must request normal speed to brake safely
 * near its destination.
 */
export function cruiseApproachRange(ship: CombatBody) {
  const d = definitions[ship.kind];
  return Math.max(
    d.cruise.minApproachRange,
    d.speed * d.cruise.multiplier * d.cruise.approachSeconds
  );
}
/**
 * Track transient cruise phases per hull and produce movement modifiers without
 * accelerating the world clock.
 */
export class CruiseSystem {
  private states = new Map<string, CruiseState>();
  /** Use component storage in a World; the fallback supports isolated algorithm tests. */
  constructor(private stateFor?: (id: string) => CruiseState | undefined) {}
  /**
   * Return or initialize this ship's cruise state; drive activation is deliberately absent
   * from persistent saves.
   */
  forShip(ship: CombatBody) {
    if (this.stateFor)
      return (
        this.stateFor(ship.id) ?? {
          phase: 'off',
          charge: 0,
          lockout: 0,
          reason: 'Cruise unavailable'
        }
      );
    let state = this.states.get(ship.id);
    if (!state) {
      state = { phase: 'off', charge: 0, lockout: 0, reason: null };
      this.states.set(ship.id, state);
    }
    return state;
  }
  /**
   * Turn off a cruise request and clear spool progress while retaining any existing damage
   * lockout.
   */
  cancel(ship: CombatBody) {
    const state = this.forShip(ship);
    state.phase = 'off';
    state.charge = 0;
    state.reason = null;
  }
  /**
   * Interrupt cruise after damage and start the hull class's combat cooldown before
   * re-engagement is allowed.
   */
  disrupt(ship: CombatBody) {
    const state = this.forShip(ship);
    state.phase = 'blocked';
    state.charge = 0;
    state.lockout = definitions[ship.kind].cruise.hitLockSeconds;
    state.reason = 'Taking fire';
  }
  /**
   * Hold offensive broadsides during spool-up and active cruise; independent PDC defence
   * remains available.
   */
  suppressesBroadsides(ship: CombatBody) {
    const phase = this.forShip(ship).phase;
    return phase === 'charging' || phase === 'active';
  }
  /**
   * Advance the drive state from input, alignment, damage cooldown and nearby threats,
   * returning this frame's movement modifiers.
   */
  update(
    ship: CombatBody,
    dt: number,
    input: Input,
    ships: CombatBody[],
    relations: Relations,
    shots: Shot[]
  ): MovementModifiers {
    const state = this.forShip(ship),
      tuning = definitions[ship.kind].cruise;
    state.lockout = Math.max(0, state.lockout - dt);
    if (!input.cruise) {
      this.cancel(ship);
      return normal;
    }
    let reason: string | null = null;
    if (ship.hull <= 0 || ship.engines <= 0 || ship.owner === 'salvage')
      reason = 'Engines unavailable';
    else if (state.lockout > 0) reason = 'Taking fire';
    else if (
      ships.some(
        /** Detect a nearby hostile that blocks cruise engagement. */
        (other) =>
          relations.isHostile(ship, other) &&
          distance(ship.position, other.position) < tuning.combatRange
      )
    )
      reason = 'Hostiles nearby';
    else if (
      shots.some(
        /** Detect a nearby incoming hostile shell that should prevent or interrupt cruise. */
        (shot) => {
          if (shot.life <= 0 || distance(ship.position, shot.position) > tuning.projectileRange)
            return false;
          const source = ships.find(
            /** Resolve the projectile owner before checking hostility to the cruising ship. */
            (s) => s.id === shot.owner
          );
          if (!source || !relations.isHostile(source, ship)) return false;
          const dx = shot.position.x - ship.position.x,
            dy = shot.position.y - ship.position.y;
          return (
            dx * (shot.velocity.x - ship.velocity.x) + dy * (shot.velocity.y - ship.velocity.y) < 0
          );
        }
      )
    )
      reason = 'Incoming fire';
    else if (
      input.thrust < 0.65 ||
      Math.abs(input.turn) > 0.1 ||
      (input.heading !== undefined && Math.abs(angleDelta(input.heading, ship.heading)) > 0.2)
    )
      reason = 'Aligning with course';
    if (reason) {
      state.phase = 'blocked';
      state.reason = reason;
      state.charge = 0;
      return normal;
    }
    state.reason = null;
    state.charge = Math.min(tuning.spoolSeconds, state.charge + dt);
    state.phase = state.charge >= tuning.spoolSeconds - 1e-8 ? 'active' : 'charging';
    return state.phase === 'active'
      ? { speedMultiplier: tuning.multiplier, turnMultiplier: tuning.turnMultiplier }
      : normal;
  }
}
