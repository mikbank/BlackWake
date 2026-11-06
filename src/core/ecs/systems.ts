import { definitions, type Input, type Vec3, type Ship } from '../model';
import { chooseShipOrder, type CombatPosture } from '../ai';
import { moveShip } from '../movement';
import type { CombatSystem } from '../combat';
import type { CruiseSystem } from '../cruise';
import type { Relations } from '../relations';
import { EntityCommands, EntityStore, SystemSchedule } from './store';
import type { SpatialComponents, CombatBody } from './components';

/** Tick-local resources are explicit; markets, DOM, storage and workers never enter the spatial scheduler. */
export type SpatialFrame = {
  entities: EntityStore<SpatialComponents>;
  commands: EntityCommands;
  dt: number;
  input: Input;
  controlledShipId: string;
  radius: number;
  disable: boolean;
  combat: CombatSystem;
  cruise: CruiseSystem;
  relations: Relations;
  ships: Ship[];
  bodies: CombatBody[];
  /** Resolve a stable physical projection for a component-selected entity. */
  body(id: string): CombatBody;
  /** Optional domain policy input for a materialized ship. */
  npcOrder?: (ship: Ship) => Input | undefined;
  /** Optional domain policy combat behavior for a materialized ship. */
  npcPosture?: (ship: Ship) => CombatPosture | undefined;
  before: Map<CombatBody, Vec3>;
  health: Map<string, { hull: number; engines: number }>;
};

/** Snapshot physical starts before any steering, preserving swept collision and damage detection. */
export function captureFrame(frame: SpatialFrame) {
  frame.combat.events = [];
  frame.combat.ships = frame.bodies;
  for (const body of frame.bodies) {
    frame.before.set(body, { ...body.position });
    frame.health.set(body.id, { hull: body.hull, engines: body.engines });
  }
}
/** Reload all weapon-bearing entities, including stationary platforms without propulsion or cargo. */
export function reloadSystem(frame: SpatialFrame) {
  for (const { components } of frame.entities.query('broadside')) {
    const reload = components.broadside.reload;
    components.broadside.reload = [
      Math.max(0, reload[0] - frame.dt),
      Math.max(0, reload[1] - frame.dt)
    ];
  }
}
/** Run capability-selected flight in stable entity order, preserving the original per-hull AI/fire/move sequence. */
export function flightSystem(frame: SpatialFrame) {
  const store = frame.entities;
  for (const { id, components } of store.query('transform', 'motion')) {
    const hull = store.get(id, 'hull'),
      owner = store.get(id, 'ownership');
    const control = store.get(id, 'control'),
      propulsion = store.get(id, 'propulsion');
    if (hull && owner && control && propulsion) {
      const body = frame.body(id),
        guns = store.get(id, 'broadside');
      const ship = store.get(id, 'ship')?.record;
      let input = control.input,
        target: CombatBody | undefined;
      if (id === frame.controlledShipId) input = frame.input;
      else if (ship) {
        const order = chooseShipOrder(
          body,
          frame.bodies,
          frame.relations,
          frame.npcOrder?.(ship),
          frame.npcPosture?.(ship)
        );
        input = order.input;
        target = order.target;
      }
      control.input = input;
      const modifiers = store.get(id, 'cruise')
        ? frame.cruise.update(
            body,
            frame.dt,
            input,
            frame.bodies,
            frame.relations,
            frame.combat.shots
          )
        : { speedMultiplier: 1, turnMultiplier: 1 };
      if (target && guns && !frame.cruise.suppressesBroadsides(body))
        frame.combat.fire(body, target, false);
      moveShip(body, frame.dt, input, frame.radius, modifiers);
    } else {
      // Motion without propulsion/control is passive drift; cargo and crew are not required.
      if (hull && hull.health <= 0) continue;
      const p = components.transform.position,
        v = components.motion.velocity;
      p.x += v.x * frame.dt;
      p.y += v.y * frame.dt;
      const distance = Math.hypot(p.x, p.y);
      if (distance > frame.radius) {
        p.x *= frame.radius / distance;
        p.y *= frame.radius / distance;
        v.x *= 0.5;
        v.y *= 0.5;
      }
    }
  }
}
/** Execute explicit weapon orders for component-only platforms independently of ship jobs or propulsion. */
export function entityGunnery(frame: SpatialFrame) {
  for (const { id, components } of frame.entities.query(
    'transform',
    'motion',
    'hull',
    'ownership',
    'broadside',
    'control'
  )) {
    if (frame.entities.get(id, 'ship') || !components.control.input.fire) continue;
    const target = frame.bodies.find(
      /** Resolve the commanded target among physical entities. */ (body) =>
        body.id === components.control.input.targetId
    );
    const source = frame.body(id);
    if (
      target &&
      frame.relations.isHostile(source, target) &&
      !frame.cruise.suppressesBroadsides(source)
    )
      frame.combat.fire(source, target, false);
  }
}
/** Apply only the controlled entity's broadside capability to the explicitly selected hostile target. */
export function playerGunnery(frame: SpatialFrame) {
  if (!frame.entities.get(frame.controlledShipId, 'broadside')) return;
  const player = frame.body(frame.controlledShipId);
  const target = frame.bodies.find(
    /** Resolve the player's selected physical target without involving presentation contacts. */ (
      body
    ) => body.id === frame.input.targetId
  );
  if (
    target &&
    target.engines > 0 &&
    frame.input.fire &&
    !frame.cruise.suppressesBroadsides(player) &&
    frame.relations.isHostile(player, target)
  )
    frame.combat.fire(player, target, frame.disable);
}
/** Fire PDCs only for entities carrying that capability, independently of cruise and cargo state. */
export function pointDefenceSystem(frame: SpatialFrame) {
  const bodies = frame.entities
    .query('transform', 'motion', 'hull', 'ownership', 'pointDefence')
    .map(
      /** Project only eligible physical defenders for the shared ballistic interception algorithm. */
      ({ id }) => frame.body(id)
    );
  frame.combat.defend(frame.dt, bodies);
}
/** Resolve broadside and PDC projectile buffers against the frame's component-selected physical bodies. */
export function projectileSystem(frame: SpatialFrame) {
  frame.combat.resolve(frame.dt, frame.before);
}
/** Translate actual damage into drive lockouts only for entities with a cruise capability. */
export function damageSystem(frame: SpatialFrame) {
  for (const { id, components } of frame.entities.query('hull', 'propulsion', 'cruise')) {
    const previous = frame.health.get(id);
    if (
      previous &&
      (components.hull.health < previous.hull || components.propulsion.condition < previous.engines)
    )
      frame.cruise.disrupt(frame.body(id));
  }
}
/** Compose explicit main-thread phases; extensions can insert a uniquely named system before a known phase. */
export function createSpatialSchedule() {
  const schedule = new SystemSchedule<SpatialFrame>();
  schedule.add({ name: 'capture', update: captureFrame });
  schedule.add({ name: 'reload', update: reloadSystem });
  schedule.add({ name: 'flight', update: flightSystem });
  schedule.add({ name: 'entity-gunnery', update: entityGunnery });
  schedule.add({ name: 'player-gunnery', update: playerGunnery });
  schedule.add({ name: 'point-defence', update: pointDefenceSystem });
  schedule.add({ name: 'projectiles', update: projectileSystem });
  schedule.add({ name: 'damage', update: damageSystem });
  return schedule;
}
