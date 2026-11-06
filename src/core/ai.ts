import { distance, type Ship, type Input } from './model';
import type { Relations } from './relations';
import type { CombatBody } from './ecs/components';
export type CombatPosture = 'broadside' | 'evade';
const idle: Input = { turn: 0, thrust: 0, brake: true, fire: false };
/**
 * Translate an NPC's planned job and nearby hostiles into flight inputs, choosing
 * broadside combat or civilian evasion.
 */
export function chooseShipOrder(
  ship: CombatBody,
  ships: CombatBody[],
  relations: Relations,
  planned?: Input,
  posture: CombatPosture = 'broadside'
): { input: Input; target?: CombatBody } {
  const hostile = ships
    .filter(
      /** Consider only explicitly hostile living ships as combat targets. */
      (s) => relations.isHostile(ship, s)
    )
    .sort(
      /** Prefer the nearest hostile before choosing interception or broadside steering. */
      (a, b) => distance(a.position, ship.position) - distance(b.position, ship.position)
    )[0];
  if (
    hostile &&
    ship.engines > 0 &&
    (!planned || distance(hostile.position, ship.position) < 750)
  ) {
    const range = distance(ship.position, hostile.position),
      bearing = Math.atan2(
        hostile.position.y - ship.position.y,
        hostile.position.x - ship.position.x
      );
    if (posture === 'evade')
      return { input: { ...idle, heading: bearing + Math.PI, thrust: 1, brake: false } };
    return {
      input: {
        ...idle,
        heading: bearing + (range > 420 ? 0 : Math.PI / 2),
        thrust: 0.6,
        brake: false
      },
      target: hostile
    };
  }
  if (planned) return { input: planned };
  if (ship.role === 'trader' && ship.engines > 0)
    return {
      input: {
        ...idle,
        heading: Math.atan2(-ship.position.y, -ship.position.x) + Math.PI / 2,
        thrust: 0.25,
        brake: false
      }
    };
  return { input: idle };
}
