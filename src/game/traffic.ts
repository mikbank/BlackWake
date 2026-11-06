import { RouteResolver } from '../content/routes';
import { assignShipDesign, getCulture } from '../content/identity';
import { distance, type Ship, type Input } from '../core/model';
import { waypointOrder } from '../core/pilot';
import type { ContentCatalog } from '../content/catalog';
import type { World } from '../simulation';
import {
  actorSystemId,
  isRetired,
  type Announcement,
  type Aggression,
  type JobContext,
  type TrafficActor,
  type TrafficEvent
} from './traffic/model';
import { TrafficJobs } from './traffic/registry';
import { createTrafficJobs } from './traffic/jobs';
import { TrafficNavigation } from './traffic/navigation';
export * from './traffic/model';

/**
 * Own persistent NPC actors and coordinate policies, travel, hostility and
 * physical/background handoffs without job-kind branches.
 */
export class TrafficDirector {
  actors: TrafficActor[] = [];
  events: TrafficEvent[] = [];
  private pendingEvents: TrafficEvent[] = [];
  readonly navigation: TrafficNavigation;
  private now = 0;
  private world: World | undefined;
  private activeSystem = '';
  /**
   * Connect the ledger to registered job policies, navigation and announcement delivery
   * using the shared route resolver.
   */
  constructor(
    readonly catalog: ContentCatalog,
    readonly jobs: TrafficJobs = createTrafficJobs(),
    readonly routes: RouteResolver = new RouteResolver(catalog)
  ) {
    this.navigation = new TrafficNavigation(
      catalog,
      /** Forward navigation announcements into the ledger's actor-scoped event queue. */
      (a, now, e) => this.emit(a, now, e),
      routes
    );
  }
  /**
   * Find a ledger actor by stable hull identity, including retired records retained to
   * prevent respawning.
   */
  get(id: string) {
    return this.actors.find(
      /** Locate an actor by stable hull ID, including historical retired entries. */
      (a) => a.ship.id === id
    );
  }
  /**
   * Resolve a policy port against the catalog, allowing missing references to be detected by
   * validation or callers.
   */
  station(port: { systemId: string; stationId: string }) {
    return this.catalog.systems[port.systemId]?.stations.find(
      /** Resolve a requested station within its specified system. */
      (s) => s.id === port.stationId
    );
  }
  /**
   * Provide a policy with its actor, content, simulation time and active-system view without
   * exposing controller internals.
   */
  private context(actor: TrafficActor): JobContext {
    return {
      catalog: this.catalog,
      routes: this.routes,
      ship: actor.ship,
      homeSystemId: actor.homeSystemId,
      systemId: actorSystemId(actor) ?? actor.homeSystemId,
      now: this.now,
      ships: this.world?.ships ?? [],
      active: actorSystemId(actor) === this.activeSystem
    };
  }
  /** Ask the actor's policy for a human-readable role, purpose and manifest. */
  describe(actor: TrafficActor) {
    return this.jobs.get(actor.job.kind).describe(this.context(actor), actor.job);
  }
  /**
   * Translate a motion state into the current activity text used by the HUD and contact
   * inspection.
   */
  activity(actor: TrafficActor) {
    const m = actor.motion;
    return m.kind === 'interrupted'
      ? 'Responding to nearby hostiles'
      : m.kind === 'disabled'
        ? 'Engines disabled'
        : m.kind === 'captured'
          ? 'Captured'
          : m.kind === 'destroyed'
            ? 'Destroyed'
            : m.kind === 'awaiting-route'
              ? 'Waiting for an available route'
              : m.kind === 'charging'
                ? 'Charging jump drive'
                : m.kind === 'transit'
                  ? 'In hyperspace'
                  : m.action.activity;
  }
  /**
   * Assign a monotonically increasing actor event ID and queue an announcement only when the
   * actor has a system location.
   */
  private emit(actor: TrafficActor, now: number, event: Announcement) {
    const systemId = actorSystemId(actor);
    if (systemId)
      this.events.push({
        ...event,
        id: `${actor.ship.id}:${++actor.sequence}`,
        actorId: actor.ship.id,
        systemId,
        at: now
      });
  }
  /**
   * Commit a policy's next state and task, update journey counts and queue any associated
   * announcement.
   */
  private next(actor: TrafficActor) {
    const step = this.jobs.get(actor.job.kind).next(this.context(actor), actor.job);
    actor.job.state = step.state;
    actor.motion = this.navigation.start(actor, step.action, this.now);
    if (step.completedJourney) actor.journeys++;
    if (step.announcement) this.emit(actor, this.now, step.announcement);
  }
  /**
   * Add newly authored identities exactly once, adopting supplied legacy hulls while
   * retaining captured or destroyed ledger entries.
   */
  seed(now: number, existing: Ship[] = []) {
    this.now = now;
    this.jobs.validateCatalog(this.catalog);
    const supplied = new Map(
      existing.map(
        /** Index supplied legacy hulls by ID before reconciling newly authored spawns. */
        (s) => [s.id, s]
      )
    );
    for (const system of Object.values(this.catalog.systems))
      for (const spawn of system.traffic) {
        if (this.get(spawn.ship.id)) continue;
        const cultureId = spawn.cultureId ?? system.cultureId;
        getCulture(this.catalog, cultureId);
        const ship = assignShipDesign(
            this.catalog,
            structuredClone(supplied.get(spawn.ship.id) ?? spawn.ship),
            cultureId,
            system.seed,
            spawn.job.kind
          ),
          actor: TrafficActor = {
            cultureId,
            ship,
            homeSystemId: system.id,
            job: { kind: spawn.job.kind, config: {}, state: {} },
            motion: {
              kind: 'waiting',
              systemId: system.id,
              until: now,
              action: { kind: 'wait', duration: 1, activity: 'Preparing orders' }
            },
            hostileTo: [],
            sequence: 0,
            journeys: 0
          };
        actor.job = this.jobs.get(spawn.job.kind).create(spawn.job.config, this.context(actor));
        this.next(actor);
        if (ship.owner === 'player' || ship.owner === 'salvage')
          actor.motion = { kind: 'captured', systemId: system.id };
        else if (ship.hull <= 0) actor.motion = { kind: 'destroyed', systemId: system.id };
        this.actors.push(actor);
      }
    this.events = [];
  }
  /**
   * Copy live physical state and hostility back into ledger records and mark newly captured
   * or destroyed actors as retired.
   */
  sync(world: World) {
    for (const actor of this.actors) {
      const live = world.ships.find(
        /** Find the physically simulated hull corresponding to this ledger actor. */
        (s) => s.id === actor.ship.id
      );
      if (!live || isRetired(actor)) continue;
      actor.ship = live;
      actor.defence = world.defences[live.id];
      for (const pair of world.relations.hostilePairs) {
        const ids = pair.split('|');
        if (ids.includes(live.id))
          for (const id of ids)
            if (id !== live.id && !actor.hostileTo.includes(id)) actor.hostileTo.push(id);
      }
      if (live.owner === 'player' || live.owner === 'salvage')
        actor.motion = { kind: 'captured', systemId: actorSystemId(actor) };
      else if (live.hull <= 0) actor.motion = { kind: 'destroyed', systemId: actorSystemId(actor) };
    }
  }
  /**
   * Place active local actor references into the world once and restore their saved
   * hostility and PDC state.
   */
  materialize(world: World, systemId: string) {
    this.world = world;
    this.activeSystem = systemId;
    const ids = new Set(
      this.actors.map(
        /** Collect managed IDs before replacing their local materializations. */
        (a) => a.ship.id
      )
    );
    const ships = world.ships.filter(
      /** Retain the controlled ship and unmanaged hulls while rebuilding the active NPC list. */
      (s) => s.id === world.controlledShipId || !ids.has(s.id)
    );
    for (const actor of this.actors)
      if (
        actorSystemId(actor) === systemId &&
        !isRetired(actor) &&
        actor.ship.id !== world.controlledShipId
      ) {
        ships.push(actor.ship);
        for (const id of actor.hostileTo) world.relations.declareHostile(actor.ship.id, id);
      }
    world.replaceShips(ships);
    for (const actor of this.actors)
      if (actorSystemId(actor) === systemId && !isRetired(actor) && actor.defence)
        world.restoreDefence(actor.ship.id, actor.defence);
  }
  /** Resolve the policy's defensive or offensive posture for the physical AI. */
  combatPosture(ship: Ship) {
    const actor = this.get(ship.id);
    return actor && !isRetired(actor) ? this.jobs.get(actor.job.kind).combatPosture : undefined;
  }
  /**
   * Translate active motion into physical inputs, allowing a policy override while
   * respecting disabled and retired states.
   */
  order(ship: Ship): Input | undefined {
    const actor = this.get(ship.id);
    if (!actor || isRetired(actor)) return;
    const m = actor.motion;
    if (m.kind === 'disabled') return waypointOrder(ship, null);
    return (
      this.jobs.get(actor.job.kind).order(this.context(actor), actor.job) ??
      waypointOrder(ship, m.kind === 'flight' ? m.leg.to : null)
    );
  }
  /**
   * Offer a witnessed attack to each relevant policy and queue its reactions for the next
   * simulation update.
   */
  reportAggression(event: Aggression, world: World, now: number) {
    this.now = now;
    this.world = world;
    this.activeSystem = event.systemId;
    const before = this.events;
    this.events = [];
    for (const actor of this.actors) {
      if (actorSystemId(actor) !== event.systemId || isRetired(actor) || actor.ship.engines <= 0)
        continue;
      const reaction = this.jobs.get(actor.job.kind).react(this.context(actor), actor.job, event);
      if (!reaction) continue;
      actor.job.state = reaction.state;
      for (const id of reaction.hostileTo ?? []) {
        world.relations.declareHostile(actor.ship.id, id);
        if (!actor.hostileTo.includes(id)) actor.hostileTo.push(id);
      }
      if (reaction.announcement) this.emit(actor, now, reaction.announcement);
    }
    this.pendingEvents.push(...this.events);
    this.events = before;
  }
  /**
   * Synchronize active actors, advance local or background motion and commit completed
   * policy tasks for this simulation time.
   */
  advance(now: number, _dt: number, world: World, systemId: string) {
    this.now = now;
    this.world = world;
    this.activeSystem = systemId;
    this.events = this.pendingEvents.splice(0);
    this.sync(world);
    this.advanceActors(now, world, systemId);
    this.materialize(world, systemId);
  }
  /** Advance a bounded journey interval as background schedules, with no local physics or graphics world. */
  advanceBackground(from: number, duration: number) {
    if (!Number.isFinite(from) || !Number.isFinite(duration) || duration < 0 || duration > 60)
      throw Error('Invalid background transit interval');
    this.world = undefined;
    this.activeSystem = '';
    const steps = Math.ceil(duration * 60);
    for (let i = 1; i <= steps; i++) {
      const now = from + (duration * i) / steps;
      this.now = now;
      this.events = [];
      this.advanceActors(now);
    }
    this.events = [];
    this.pendingEvents = [];
  }
  /** Share job, engine-loss and navigation rules between physical updates and bounded background catch-up. */
  private advanceActors(now: number, world?: World, systemId = '') {
    for (const actor of this.actors) {
      if (isRetired(actor)) continue;
      const active = !!world && actorSystemId(actor) === systemId;
      if (actor.motion.kind !== 'transit') {
        if (actor.ship.engines <= 0) {
          if (actor.motion.kind !== 'disabled')
            this.emit(actor, now, { topic: 'ship.disabled', values: {}, urgent: true });
          this.navigation.interrupt(actor, 'disabled', now);
          continue;
        }
        const override =
            active && this.jobs.get(actor.job.kind).order(this.context(actor), actor.job),
          threat =
            active &&
            world!.ships.some(
              /** Detect a nearby hostile requiring a local actor's task to pause for combat. */
              (s) =>
                world!.relations.isHostile(actor.ship, s) &&
                distance(s.position, actor.ship.position) < 750
            );
        if (threat || override) {
          if (threat && actor.motion.kind !== 'interrupted')
            this.emit(actor, now, { topic: 'ship.attacked', values: {}, urgent: true });
          this.navigation.interrupt(actor, 'interrupted', now);
          continue;
        }
        this.navigation.resume(actor, now);
      }
      if (this.navigation.advance(actor, now, active)) this.next(actor);
    }
  }
  /**
   * Synchronize actors and rebase local travel legs before the player unloads the current
   * physical system.
   */
  leave(world: World, now: number) {
    this.sync(world);
    for (const actor of this.actors)
      if (world.ships.includes(actor.ship)) this.navigation.leave(actor, now);
  }
}
