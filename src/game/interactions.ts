import { distance, type Ship } from '../core/model';
import type { StationDefinition, JumpGate, StationSize } from '../content/schema';
/**
 * Check a living ship's engines, distance and speed against a station size's docking
 * envelope.
 */
export function canDock(ship: Ship, station: StationDefinition, size: StationSize) {
  return (
    ship.hull > 0 &&
    ship.engines > 0 &&
    distance(ship.position, station.position) < size.dockRadius &&
    Math.hypot(ship.velocity.x, ship.velocity.y) < 75
  );
}
/**
 * Check the physical prerequisites for a jump; connection access rules are enforced
 * separately by the session.
 */
export function canJump(ship: Ship, gate: JumpGate) {
  return (
    ship.hull > 0 &&
    ship.engines > 0 &&
    distance(ship.position, gate.position) < gate.radius &&
    Math.hypot(ship.velocity.x, ship.velocity.y) < 75
  );
}
/**
 * Allow boarding of another disabled, living, non-owned hull only at close range and low
 * relative speed.
 */
export function canBoard(player: Ship, target: Ship) {
  return (
    target.owner !== 'salvage' &&
    target.owner !== 'player' &&
    player.id !== target.id &&
    player.hull > 0 &&
    target.hull > 0 &&
    target.engines === 0 &&
    distance(player.position, target.position) < 155 &&
    Math.hypot(player.velocity.x - target.velocity.x, player.velocity.y - target.velocity.y) < 75
  );
}
