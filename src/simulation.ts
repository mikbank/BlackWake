import { CruiseSystem } from './core/cruise';
export * from './core/model';
import { type Ship, type Input, type DefenceState, freshDefence } from './core/model';
import { Relations } from './core/relations';
import { CombatSystem } from './core/combat';
import type { CombatPosture } from './core/ai';
import { EntityStore, EntityCommands } from './core/ecs/store';
import type { SpatialComponents, CombatBody } from './core/ecs/components';
import { attachShip, restoreShip, combatBody } from './core/ecs/ship-adapter';
import { createSpatialSchedule, type SpatialFrame } from './core/ecs/systems';

/** Main-thread ECS spatial world; domain-facing ship records are live adapters over component-owned state. */
export class World {
  readonly entities = new EntityStore<SpatialComponents>(
    /** Unbind domain references and indexes before an entity is structurally destroyed. */
    (id) => this.beforeDestroy(id)
  );
  readonly commands = new EntityCommands();
  readonly schedule = createSpatialSchedule();
  npcCombatPosture: ((ship: Ship) => CombatPosture | undefined) | undefined;
  npcOrder: ((ship: Ship) => Input | undefined) | undefined;
  elapsed = 0;
  readonly relations = new Relations();
  readonly cruise: CruiseSystem;
  readonly combat: CombatSystem;
  private bodyViews = new Map<string, CombatBody>();
  disable = true;

  /** Materialize incoming plain hulls and connect PDC/cruise algorithms directly to their component records. */
  constructor(
    ships: Ship[],
    public controlledShipId: string,
    public radius = 1600
  ) {
    const store = this.entities;
    this.cruise = new CruiseSystem(
      /** Resolve only an existing cruise capability, without silently granting one. */ (id) =>
        store.get(id, 'cruise')
    );
    this.combat = new CombatSystem(this.relations, {
      /** Read the entity's authoritative PDC state. */
      get(id) {
        return store.get(id, 'pointDefence');
      },
      /** Apply restored equipment state only to entities already carrying PDCs. */
      replace(states) {
        for (const { id } of store.query('pointDefence'))
          store.set(id, 'pointDefence', states[id] ?? freshDefence());
      },
      /** Provide a serialization index of live component references. */
      entries() {
        return store
          .query('pointDefence')
          .map(
            /** Preserve PDC record identity in the legacy save shape. */ ({ id, components }) => [
              id,
              components.pointDefence
            ]
          );
      }
    });
    this.replaceShips(ships);
  }
  /** Derive a list of live domain adapters; use addShip/removeShip/replaceShips for membership changes. */
  get ships() {
    return this.entities
      .query('ship')
      .map(
        /** Expose the stable domain object already bound to this entity. */ ({ components }) =>
          components.ship.record
      );
  }
  /** Retain assignment compatibility at existing load boundaries; returned arrays themselves are read models. */
  set ships(ships: Ship[]) {
    this.replaceShips(ships);
  }
  /** Register a hull once, restoring its indexed PDC equipment if it is rematerializing. */
  addShip(ship: Ship) {
    const existing = this.entities.get(ship.id, 'ship')?.record;
    if (existing === ship) return;
    if (existing) this.removeShip(ship.id);
    const defence = this.combat.defences[ship.id];
    attachShip(this.entities, ship);
    if (defence) this.entities.set(ship.id, 'pointDefence', defence);
    this.bodyViews.set(ship.id, ship);
  }
  /** Restore an actor's equipment after membership reconciliation, preserving optional capability removal. */
  restoreDefence(id: string, state: DefenceState) {
    if (this.entities.get(id, 'pointDefence')) this.entities.set(id, 'pointDefence', state);
    this.combat.defences[id] = state;
  }
  /** Detach a departing hull back to plain data and remove every component and cached physical projection. */
  removeShip(id: string) {
    this.entities.destroy(id);
  }
  /** Clean external adapters for both explicit removals and deferred ECS destruction. */
  private beforeDestroy(id: string) {
    const ship = this.entities.get(id, 'ship')?.record;
    if (ship) restoreShip(this.entities, ship);
    this.bodyViews.delete(id);
    delete this.combat.defences[id];
  }
  /** Reconcile complete domain membership in one operation, retaining live components for unchanged identities. */
  replaceShips(ships: readonly Ship[]) {
    const ids = new Set<string>();
    for (const ship of ships) {
      if (ids.has(ship.id)) throw Error(`Duplicate hull: ${ship.id}`);
      ids.add(ship.id);
    }
    for (const { id } of this.entities.query('ship')) if (!ids.has(id)) this.removeShip(id);
    for (const ship of ships) this.addShip(ship);
    this.entities.prioritize(
      ships.map(
        /** Preserve existing gameplay's explicit physical processing order. */ (ship) => ship.id
      )
    );
  }
  /** Release a discarded system's hull adapters so background actors do not retain its spatial storage. */
  release() {
    for (const { id } of this.entities.query()) this.entities.destroy(id);
    this.combat.clear();
  }
  /** Resolve the controlled domain hull and fail if application ownership has become inconsistent. */
  get player() {
    const ship = this.entities.get(this.controlledShipId, 'ship')?.record;
    if (!ship) throw Error('Controlled ship is missing');
    return ship;
  }
  /** Resolve a component-backed physical projection, including entities without cargo or crew. */
  body(id: string): CombatBody {
    const ship = this.entities.get(id, 'ship')?.record;
    if (ship) return ship;
    let view = this.bodyViews.get(id);
    if (!view) {
      view = combatBody(this.entities, id);
      this.bodyViews.set(id, view);
    }
    return view;
  }
  /** Expose the transient shell buffer owned by the projectile subsystem. */
  get shots() {
    return this.combat.shots;
  }
  /** Expose transient PDC rounds for rendering; equipment state lives in components. */
  get defenceRounds() {
    return this.combat.defenceRounds;
  }
  /** Expose only this tick's combat facts for sound and graphics. */
  get events() {
    return this.combat.events;
  }
  /** Present component-owned PDC records through the existing save/index adapter. */
  get defences() {
    return this.combat.defences;
  }
  /** Read a hull's live PDC record through the combat compatibility boundary. */
  defenceFor(ship: Ship) {
    return this.combat.defenceFor(ship);
  }
  /** Execute the explicit ECS schedule on the main thread, then commit deferred structural operations. */
  step(dt: number, input: Input) {
    if (this.player.hull <= 0) {
      this.cruise.cancel(this.player);
      this.combat.events = [];
      return;
    }
    this.elapsed += dt;
    this.combat.elapsed = this.elapsed;
    const bodies = this.entities.query('transform', 'motion', 'hull', 'ownership').map(
      /** Include every physical body, independently of optional ship-domain presentation. */
      ({ id }) => this.body(id)
    );
    const frame: SpatialFrame = {
      entities: this.entities,
      commands: this.commands,
      dt,
      input,
      controlledShipId: this.controlledShipId,
      radius: this.radius,
      disable: this.disable,
      combat: this.combat,
      cruise: this.cruise,
      relations: this.relations,
      ships: this.ships,
      bodies,
      /** Reuse the world's stable physical adapter for a queried entity. */
      body: (id) => this.body(id),
      npcOrder: this.npcOrder,
      npcPosture: this.npcCombatPosture,
      before: new Map(),
      health: new Map()
    };
    this.entities.beginUpdate();
    try {
      this.schedule.run(frame);
    } catch (error) {
      this.commands.clear();
      throw error;
    } finally {
      this.entities.endUpdate();
    }
    this.commands.flush();
  }
}
