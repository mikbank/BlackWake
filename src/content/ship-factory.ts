import type { Ship } from '../core/model';
/**
 * Create a position on the XY flight plane while retaining a Z coordinate for rendering
 * and future spatial expansion.
 */
export const position = (x: number, y: number) => ({ x, y, z: 0 });
/**
 * Create a plain mutable hull record with default equipment and ownership; session
 * creation resolves its presentation identity.
 */
export function makeShip(
  id: string,
  name: string,
  kind: Ship['kind'],
  owner: string,
  x: number,
  y: number
): Ship {
  return {
    id,
    name,
    kind,
    owner,
    factionId: owner === 'player' ? 'independent' : 'guild',
    role: owner === 'player' ? 'idle' : 'trader',
    position: position(x, y),
    velocity: position(0, 0),
    heading: Math.PI / 2,
    hull: 100,
    engines: 100,
    crew: kind === 'cutter' ? 18 : 12,
    cargo: {},
    reload: [0, 0]
  };
}
