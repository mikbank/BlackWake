import { angleDelta, definitions, distance, type Input, type Ship, type Vec3 } from './model';
/**
 * Steer toward a destination with braking-aware thrust, returning the same input format
 * used by players and NPCs.
 */
export function waypointOrder(ship: Ship, destination: Vec3 | null): Input {
  const input: Input = { turn: 0, thrust: 0, brake: true, fire: false };
  if (!destination) return input;
  const remaining = distance(ship.position, destination);
  if (remaining < 8) return input;
  const heading = Math.atan2(destination.y - ship.position.y, destination.x - ship.position.x),
    alignment = Math.max(0, Math.cos(angleDelta(heading, ship.heading)));
  input.heading = heading;
  input.thrust = Math.min(1, (remaining * 1.2) / definitions[ship.kind].speed) * alignment ** 4;
  return input;
}
