import type { Ship, Vec3, Input, DefenceState } from '../model';
import type { CruiseState } from '../cruise';

/** Capabilities of live spatial entities; crew culture and job purpose remain in their domain owners. */
export type SpatialComponents = {
  transform: { position: Vec3; heading: number };
  motion: { velocity: Vec3 };
  hull: { kind: Ship['kind']; health: number };
  ownership: Pick<Ship, 'owner' | 'factionId' | 'role'>;
  propulsion: { condition: number };
  broadside: { reload: [number, number] };
  pointDefence: DefenceState;
  cruise: CruiseState;
  control: { input: Input };
  cargo: { goods: Record<string, number> };
  crew: { count: number };
  appearance: Pick<Ship, 'name' | 'designId' | 'livery'>;
  /** Bridge identity only: the record's properties access the components, never a second state copy. */
  ship: { record: Ship };
};
/** Combat algorithms need a physical projection, not an inventory, captain or NPC policy. */
export type CombatBody = Pick<
  Ship,
  | 'id'
  | 'kind'
  | 'owner'
  | 'factionId'
  | 'role'
  | 'position'
  | 'velocity'
  | 'heading'
  | 'hull'
  | 'engines'
  | 'reload'
>;
/** Create independent drive timers; activation is transient and never inferred from a saved course. */
export function freshCruise(): CruiseState {
  return { phase: 'off', charge: 0, lockout: 0, reason: null };
}
