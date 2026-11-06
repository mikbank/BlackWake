import { definitions, angleDelta, type Input } from './model';
import type { CombatBody } from './ecs/components';
export type MovementModifiers = { speedMultiplier: number; turnMultiplier: number };
const normal: MovementModifiers = { speedMultiplier: 1, turnMultiplier: 1 };
/**
 * Integrate steering, thrust, braking and the sector boundary into one hull's velocity and
 * position for this time step.
 */
export function moveShip(
  ship: CombatBody,
  dt: number,
  input: Input,
  radius: number,
  modifiers: MovementModifiers = normal
) {
  if (ship.hull <= 0) return;
  const def = definitions[ship.kind];
  const turn =
    input.heading === undefined
      ? input.turn
      : Math.max(-1, Math.min(1, angleDelta(input.heading, ship.heading) * 2.5));
  const powered = ship.engines > 0 && ship.owner !== 'salvage';
  ship.heading += turn * def.turn * modifiers.turnMultiplier * dt * (powered ? 1 : 0.12);
  const wanted = powered ? input.thrust * def.speed * modifiers.speedMultiplier : 0,
    ease = Math.min(1, dt * (input.brake ? 4 : 1.2));
  ship.velocity.x += (Math.cos(ship.heading) * wanted - ship.velocity.x) * ease;
  ship.velocity.y += (Math.sin(ship.heading) * wanted - ship.velocity.y) * ease;
  ship.position.x += ship.velocity.x * dt;
  ship.position.y += ship.velocity.y * dt;
  const d = Math.hypot(ship.position.x, ship.position.y);
  if (d > radius) {
    ship.position.x *= radius / d;
    ship.position.y *= radius / d;
    ship.velocity.x *= 0.5;
    ship.velocity.y *= 0.5;
  }
}
