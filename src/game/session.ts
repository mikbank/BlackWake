import { jumpTravelSeconds, type PlayerTransit } from './jump-travel';
import { RouteResolver } from '../content/routes';
import { assignShipDesign, getCulture } from '../content/identity';
import { TrafficDirector, isRetired } from './traffic';
import { createTrafficJobs } from './traffic/jobs';
import type { TrafficJobs } from './traffic/registry';
import { RadioDirector } from './radio';
import { World, definitions, type Ship, type Input, type Vec3 } from '../simulation';
import type { ContentCatalog } from '../content/catalog';
import type { SystemDefinition, StationDefinition, JumpGate, Landmark } from '../content/schema';
import { canBoard, canDock, canJump } from './interactions';
import { cargoTransferPlan, transferCargo } from './boarding';
import { ServiceRegistry, type Captain, type MarketState, type ServiceResult } from './services';
import { ActivityRegistry, type Activity, type GameEvent } from './activities';
export type Selection = { kind: 'station' | 'gate' | 'landmark' | 'ship'; id: string };
export type Contact = { kind: Selection['kind']; id: string; name: string; position: Vec3 };
export type SystemSnapshot = {
  ships: Ship[];
  defences: World['defences'];
  hostilePairs: string[];
  elapsed: number;
};
export type SessionCommand =
  | { type: 'plot-route'; systemId: string }
  | { type: 'select'; target: Selection }
  | { type: 'dock'; stationId: string }
  | { type: 'undock' }
  | { type: 'jump'; connectionId: string }
  | { type: 'service'; kind: string; payload: Record<string, unknown> }
  | {
      type: 'board';
      shipId: string;
      outcome?: 'cargo' | 'capture';
      tactic?: 'assault' | 'intimidate';
    }
  | { type: 'attack'; shipId: string };
export type Result = ServiceResult;
/**
 * Orchestrate the captain, active physics world, traffic ledger, services and persistence
 * without embedding those systems' internal rules.
 */
export class GameSession {
  transit: PlayerTransit | null = null;
  private transitCheckpoint: string | null = null;
  trafficEnabled = false;
  clock = 0;
  readonly routes: RouteResolver;
  traffic: TrafficDirector;
  radio: RadioDirector;
  followedActorId: string | null = null;
  routeDestinationId: string | null = null;
  world: World;
  captain: Captain;
  dockedAt: string | null = null;
  selection: Selection | null = null;
  systems: Record<string, SystemSnapshot> = {};
  markets: Record<string, MarketState> = {};
  activity: Activity | null = null;
  visits: Record<string, number> = {};
  /**
   * Create a captain and initial system world from registered content, then resolve the
   * starting hull's cultural design.
   */
  constructor(
    readonly catalog: ContentCatalog,
    readonly services: ServiceRegistry,
    readonly activities: ActivityRegistry,
    public systemId: string,
    player: Ship,
    jobs: TrafficJobs = createTrafficJobs()
  ) {
    this.routes = new RouteResolver(catalog);
    this.traffic = new TrafficDirector(catalog, jobs, this.routes);
    this.radio = new RadioDirector(catalog);
    getCulture(catalog, catalog.systems[systemId].cultureId);
    this.captain = {
      cultureId: catalog.systems[systemId].cultureId,
      credits: 500,
      controlledShipId: player.id
    };
    assignShipDesign(catalog, player, this.captain.cultureId, catalog.systems[systemId].seed);
    this.world = this.makeWorld(systemId, player);
    this.visits[systemId] = 1;
  }
  /**
   * Read the current system's authored definition; this getter changes naturally when the
   * player jumps.
   */
  get definition() {
    return this.catalog.systems[this.systemId];
  }
  /**
   * Resolve the station currently docked at, or return undefined while the player is in
   * flight.
   */
  get station() {
    return this.definition.stations.find(
      /** Find the current docking station in this system's authored definitions. */
      (s) => s.id === this.dockedAt
    );
  }
  /**
   * Report whether the controlled hull has been destroyed, independently of optional mission
   * progress.
   */
  get failed() {
    return this.world.player.hull <= 0;
  }
  /**
   * Build selectable local stations, exits, landmarks and living NPCs, excluding the
   * player's hull and salvage.
   */
  contacts(): Contact[] {
    return [
      ...this.definition.stations.map(
        /**
         * Expose a station definition as a selectable contact with a literal station
         * discriminator.
         */
        (s) => ({ ...s, kind: 'station' as const })
      ),
      ...this.definition.gates.map(
        /** Expose a physical exit as a selectable gate contact. */
        (g) => ({ ...g, kind: 'gate' as const })
      ),
      ...this.definition.landmarks.map(
        /** Expose a central body or other point of interest as a selectable landmark contact. */
        (l) => ({ ...l, kind: 'landmark' as const })
      ),
      ...this.world.ships
        .filter(
          /** Keep only living, non-salvage hulls other than the controlled ship in contact selection. */
          (s) => s.id !== this.world.controlledShipId && s.owner !== 'salvage' && s.hull > 0
        )
        .map(
          /**
           * Expose each eligible hull as a ship contact without transferring state ownership to the
           * UI.
           */
          (s) => ({ ...s, kind: 'ship' as const })
        )
    ];
  }
  /**
   * Resolve the stored selection against current contacts, allowing a vanished or destroyed
   * target to become undefined.
   */
  get selected() {
    return this.contacts().find(
      /** Resolve both selection kind and stable ID against current contacts. */
      (c) => c.kind === this.selection?.kind && c.id === this.selection.id
    );
  }
  /** Look up a station only within the player's active system. */
  stationById(id: string) {
    return this.definition.stations.find(
      /** Find the requested local station definition. */
      (s) => s.id === id
    );
  }
  /** Look up a physical jump gate only within the player's active system. */
  gateById(id: string) {
    return this.definition.gates.find(
      /** Find the requested local physical exit. */
      (g) => g.id === id
    );
  }
  /** Combine session docking state with the selected station's physical docking envelope. */
  canDock(station: StationDefinition) {
    return (
      !this.dockedAt && canDock(this.world.player, station, this.catalog.stationSizes[station.size])
    );
  }
  /**
   * Require physical jump eligibility and at least one allowed outgoing connection from this
   * gate.
   */
  canJump(gate: JumpGate) {
    return (
      !this.dockedAt &&
      canJump(this.world.player, gate) &&
      gate.connections.some(
        /** Require at least one outgoing connection to pass the current route access policy. */
        (c) => this.routes.access(this.routes.connection(this.systemId, c.id)!).allowed
      )
    );
  }
  /**
   * Validate one directed hop against its exact gate, current physical position and access
   * policy.
   */
  canJumpConnection(connectionId: string) {
    const hop = this.routes.connection(this.systemId, connectionId),
      gate = hop && this.gateById(hop.gateId);
    return !!gate && this.canJump(gate) && this.routes.access(hop!).allowed;
  }
  /**
   * Resolve a local target and apply shared boarding prerequisites while ensuring the player
   * is undocked.
   */
  canBoard(shipId: string) {
    const target = this.world.ships.find(
      /** Resolve the local hull before applying shared boarding conditions. */
      (s) => s.id === shipId
    );
    return !this.dockedAt && !!target && canBoard(this.world.player, target);
  }
  /**
   * Expose the same attack eligibility to the flight UI and command dispatcher; culture does
   * not restrict targets.
   */
  canAttack(shipId: string) {
    const target = this.world.ships.find(
      /** Resolve the local hull before offering an explicit attack. */
      (s) => s.id === shipId
    );
    return (
      !this.dockedAt &&
      !this.failed &&
      !!target &&
      target.id !== this.world.controlledShipId &&
      target.owner !== 'salvage' &&
      target.owner !== 'player' &&
      target.hull > 0
    );
  }
  /** Publish a completed gameplay fact to the optional activity observer. */
  private observe(event: GameEvent) {
    this.activities.observe(this.activity, event);
  }
  /**
   * Declare hostility and notify nearby traffic policies, allowing police intervention
   * without faction-specific logic here.
   */
  private reportAggression(target: Ship) {
    this.world.relations.declareHostile(this.world.controlledShipId, target.id);
    this.traffic.reportAggression(
      { attacker: this.world.player, victim: target, systemId: this.systemId },
      this.world,
      this.clock
    );
  }
  /**
   * Materialize ledger-owned NPC references and attach policy callbacks to the active
   * physics world.
   */
  bindTraffic(world = this.world, systemId = this.systemId) {
    this.traffic.materialize(world, systemId);
    /** Ask the traffic controller for this NPC's current movement input during a physics step. */
    world.npcOrder = (ship) => this.traffic.order(ship);
    /** Ask the traffic controller whether this NPC fights broadsides or evades nearby hostiles. */
    world.npcCombatPosture = (ship) => this.traffic.combatPosture(ship);
  }
  /**
   * Build active-system physics from content or a saved snapshot, then attach managed
   * traffic and saved combat state.
   */
  private makeWorld(id: string, player: Ship) {
    const definition = this.catalog.systems[id];
    if (!definition) throw Error(`Unknown system ${id}`);
    const saved = this.systems[id],
      ships = structuredClone(
        saved?.ships ??
          definition.traffic.map(
            /** Read initial hull records from authored traffic when no system snapshot exists. */
            (t) => t.ship
          )
      ).filter(
        /** Exclude the separately owned controlled hull from local-system restoration. */
        (s) => s.id !== player.id
      );
    for (const ship of ships) {
      const spawn = definition.traffic.find(
        /** Find the authored spawn supplying any culture override for this local hull. */
        (t) => t.ship.id === ship.id
      );
      assignShipDesign(
        this.catalog,
        ship,
        spawn?.cultureId ?? definition.cultureId,
        definition.seed
      );
    }
    const world = new World([player, ...ships], player.id, definition.radius);
    if (saved) {
      world.combat.defences = structuredClone(saved.defences);
      world.relations.hostilePairs = [...saved.hostilePairs];
      world.elapsed = saved.elapsed;
    }
    this.bindTraffic(world, id);
    return world;
  }
  /**
   * Capture unmanaged system state after syncing live NPCs into their ledger; exclude
   * managed actors to avoid duplicated ownership.
   */
  snapshot() {
    this.traffic.sync(this.world);
    const managed = new Set(
      this.traffic.actors.map(
        /** Collect managed identities before deciding which hulls belong in a system snapshot. */
        (a) => a.ship.id
      )
    );
    const snapshot: SystemSnapshot = {
      ships: structuredClone(
        this.world.ships.filter(
          /** Snapshot only unmanaged local hulls, excluding both the player and ledger-owned NPCs. */
          (s) => s.id !== this.world.controlledShipId && !managed.has(s.id)
        )
      ),
      defences: structuredClone(this.world.defences),
      hostilePairs: [...this.world.relations.hostilePairs],
      elapsed: this.world.elapsed
    };
    this.systems[this.systemId] = snapshot;
    return snapshot;
  }
  /**
   * Reconcile authored NPC IDs once, optionally adopting legacy local hulls, and bind their
   * authoritative ledger records.
   */
  enableTraffic(adopt = false) {
    this.trafficEnabled = true;
    const existing = adopt
      ? [
          ...Object.values(this.systems).flatMap(
            /** Collect hulls from old system snapshots when adopting legacy traffic into the ledger. */
            (s) => s.ships
          ),
          ...this.world.ships
        ]
      : [];
    this.traffic.seed(this.clock, existing);
    const managed = new Set(
      this.traffic.actors.map(
        /** Collect all managed actor IDs after content reconciliation. */
        (a) => a.ship.id
      )
    );
    for (const saved of Object.values(this.systems))
      saved.ships = saved.ships.filter(
        /** Remove managed hulls from old snapshots once the ledger has adopted ownership. */
        (s) => !managed.has(s.id)
      );
    this.bindTraffic();
  }
  /**
   * Advance fixed-step physics, traffic schedules, activity facts and chatter while the
   * session is undocked and the hull survives.
   */
  step(dt: number, input: Input) {
    if (this.transit) {
      this.advanceTransit(dt);
      this.world.combat.events = [];
      return;
    }
    if (this.dockedAt || this.failed) {
      this.world.combat.events = [];
      return;
    }
    this.clock += dt;
    const alive = this.world.ships
      .filter(
        /** Record which local hulls were alive before this physics step. */
        (s) => s.hull > 0
      )
      .map(
        /** Keep their identities so newly destroyed ships can produce activity facts. */
        (s) => s.id
      );
    this.world.step(dt, input);
    for (const id of alive)
      if (
        this.world.ships.find(
          /** Check the previously living hull for a destruction event after physics resolves. */
          (s) => s.id === id
        )?.hull === 0
      )
        this.observe({ type: 'ship-destroyed', shipId: id });
    this.traffic.advance(this.clock, dt, this.world, this.systemId);
    if (
      this.followedActorId &&
      this.traffic.get(this.followedActorId) &&
      isRetired(this.traffic.get(this.followedActorId)!)
    )
      this.followedActorId = null;
    this.radio.update(
      this.clock,
      this.traffic.events,
      this.traffic,
      this.systemId,
      this.world.player.position,
      this.followedActorId ?? this.selection?.id
    );
  }
  /**
   * Validate player intent and coordinate the appropriate domain operation; return a result
   * the browser can display and save.
   */
  dispatch(command: SessionCommand): Result {
    if (this.transit)
      return { ok: false, message: 'Complete or cancel the current journey first.' };
    const /** Create a rejected command result before any operation's state changes are committed. */
      fail = (message: string): Result => ({ ok: false, message }),
      /** Create a successful command result for the UI and autosave path. */
      ok = (message: string): Result => ({ ok: true, message });
    if (this.failed) return fail('Your ship has been lost.');
    if (command.type === 'plot-route') {
      const route = this.routes.find(this.systemId, command.systemId);
      if (!route) return fail('No available route to that system.');
      this.routeDestinationId = route.hops.length ? command.systemId : null;
      this.followedActorId = null;
      if (route.hops[0]) this.selection = { kind: 'gate', id: route.hops[0].gateId };
      return ok(
        route.hops.length
          ? `Route plotted to ${this.catalog.systems[command.systemId].name}.`
          : 'You are already in this system.'
      );
    }
    if (command.type === 'select') {
      if (
        !this.contacts().some(
          /** Require a selected contact to exist with the requested kind and ID. */
          (c) => c.id === command.target.id && c.kind === command.target.kind
        )
      )
        return fail('Contact no longer available.');
      this.selection = { ...command.target };
      return ok('Contact selected.');
    }
    if (command.type === 'dock') {
      const station = this.stationById(command.stationId);
      if (!station || !this.canDock(station))
        return fail('Approach the station and slow down to dock.');
      this.dockedAt = station.id;
      this.world.player.velocity = { x: 0, y: 0, z: 0 };
      this.world.player.position = { ...station.position };
      this.observe({ type: 'docked', stationId: station.id });
      return ok(`Docked at ${station.name}.`);
    }
    if (command.type === 'undock') {
      if (!this.station) return fail('You are already in flight.');
      const station = this.station,
        size = this.catalog.stationSizes[station.size];
      this.world.player.position = {
        x: station.position.x,
        y: station.position.y - size.dockRadius - 35,
        z: 0
      };
      this.world.player.velocity = { x: 0, y: 0, z: 0 };
      this.dockedAt = null;
      return ok('Undocked. Clear skies, Captain.');
    }
    if (command.type === 'jump') {
      const gate = this.definition.gates.find(
          /** Locate the exact departure gate owning this jump command's connection. */
          (g) =>
            g.connections.some(
              /** Recognize the requested connection within a candidate departure gate. */
              (c) => c.id === command.connectionId
            )
        ),
        connection = gate?.connections.find(
          /** Resolve the chosen connection after its departure gate is known. */
          (c) => c.id === command.connectionId
        );
      const access =
        connection && this.routes.access(this.routes.connection(this.systemId, connection.id)!);
      if (access && !access.allowed) return fail(access.reason);
      if (!gate || !connection || !this.canJumpConnection(command.connectionId))
        return fail('Reach a connected outer gateway and slow down first.');
      const destination = this.catalog.systems[connection.systemId],
        arrival = destination?.gates.find(
          /** Resolve the destination's physical arrival gate. */
          (g) => g.id === connection.gateId
        );
      if (!arrival) return fail('This route is unavailable.');
      this.transitCheckpoint = this.save();
      this.transit = {
        connectionId: connection.id,
        fromSystemId: this.systemId,
        systemId: destination.id,
        arrivalGateId: arrival.id,
        duration: jumpTravelSeconds,
        elapsed: 0
      };
      return ok(`Entering hyperspace for ${destination.name}.`);
    }
    if (command.type === 'service') {
      const station = this.station,
        spec = station?.services.find(
          /** Find the current station's configuration for the requested service capability. */
          (s) => s.kind === command.kind
        ),
        handler = this.services.handlers.get(command.kind);
      if (!station || !spec || !handler) return fail('Dock at a station offering this service.');
      const result = handler.execute(
        {
          captain: this.captain,
          ship: this.world.player,
          station,
          spec,
          catalog: this.catalog,
          markets: this.markets,
          /**
           * Expose the session's validated hull-exchange operation to a station service without
           * granting it unrestricted session access.
           */
          replaceControlledShip: (replacement) => this.replaceControlledShip(replacement)
        },
        command.payload
      );
      if (result.ok && result.trade) this.observe({ type: 'trade', ...result.trade });
      return result;
    }
    if (command.type === 'attack') {
      const target = this.world.ships.find(
        /** Resolve the selected local attack target. */
        (s) => s.id === command.shipId
      );
      if (!target || !this.canAttack(target.id)) return fail('That contact cannot be attacked.');
      this.reportAggression(target);
      this.selection = { kind: 'ship', id: target.id };
      return ok(`Engaging ${target.name}.`);
    }
    if (command.type === 'board') {
      const target = this.world.ships.find(
        /** Resolve the selected local boarding target. */
        (s) => s.id === command.shipId
      );
      if (!target || !this.canBoard(target.id))
        return fail('Disable the ship, approach within 155 m and match speed.');
      const old = this.world.player;
      const outcome = command.outcome ?? 'capture';
      if (outcome !== 'cargo' && outcome !== 'capture')
        return fail('Choose cargo or ship capture.');
      if (outcome === 'cargo') {
        const plan = cargoTransferPlan(target, old, this.catalog);
        if (!plan.units)
          return fail(
            Object.values(target.cargo).some(
              /**
               * Distinguish an empty target hold from cargo that exists but cannot fit aboard the
               * player.
               */
              (q) => q > 0
            )
              ? 'No room for this cargo in your hold.'
              : 'There is no cargo to raid.'
          );
        this.reportAggression(target);
        transferCargo(target, old, plan.cargo);
        this.traffic.sync(this.world);
        this.observe({ type: 'cargo-raided', shipId: target.id });
        return ok(`Raided ${plan.units} cargo units. You remain aboard ${old.name}.`);
      }
      const crewCost = command.tactic === 'assault' ? 4 : 2;
      if (old.crew <= crewCost)
        return fail(`You need at least ${crewCost + 1} crew to take another ship.`);
      this.reportAggression(target);
      const pursuers = this.world.ships.filter(
        /**
         * Carry hostility from existing pursuers to the captured hull, excluding the defeated
         * prize itself.
         */
        (s) => s.id !== target.id && this.world.relations.isHostile(old, s)
      );
      old.owner = 'salvage';
      old.role = 'idle';
      target.owner = 'player';
      target.factionId = 'independent';
      target.role = 'idle';
      target.crew = old.crew - crewCost;
      target.engines = 55;
      target.velocity = { x: 0, y: 0, z: 0 };
      target.reload = [0, 0];
      // Target cargo stays aboard; only fitting cargo from the previous hull moves.
      transferCargo(old, target, cargoTransferPlan(old, target, this.catalog).cargo);
      this.world.controlledShipId = target.id;
      this.captain.controlledShipId = target.id;
      // Changing hulls must not make witnesses/pursuers forget the captain's attack.
      for (const pursuer of pursuers) this.world.relations.declareHostile(target.id, pursuer.id);
      this.world.combat.clear();
      this.selection = this.definition.stations[0]
        ? { kind: 'station', id: this.definition.stations[0].id }
        : null;
      this.traffic.sync(this.world);
      if (this.followedActorId === target.id) this.followedActorId = null;
      this.observe({ type: 'boarded', shipId: target.id });
      return ok(`You now command ${target.name}.`);
    }
    return fail('Unknown command.');
  }
  /**
   * Replace the docked controlled hull through a service, preserving captain identity,
   * fitting cargo and consistent world ownership.
   */
  private replaceControlledShip(replacement: Ship): Result {
    const station = this.station,
      old = this.world.player;
    if (
      !station ||
      !definitions[replacement.kind] ||
      this.world.ships.some(
        /** Reject a replacement hull whose ID already belongs to another local ship. */
        (s) => s.id === replacement.id
      )
    )
      return { ok: false, message: 'Replacement ship is unavailable.' };
    const used = Object.entries(old.cargo).reduce(
      /** Calculate cargo space aboard a service-supplied replacement hull before accepting it. */
      (n, [id, q]) => n + q * (this.catalog.commodities[id]?.unitSize ?? 1),
      0
    );
    if (used > definitions[replacement.kind].cargoCapacity)
      return { ok: false, message: 'Unload cargo before changing vessels.' };
    try {
      assignShipDesign(this.catalog, replacement, this.definition.cultureId, this.definition.seed);
    } catch {
      return { ok: false, message: 'Replacement ship design is unavailable.' };
    }
    replacement.cargo = structuredClone(old.cargo);
    replacement.crew = old.crew;
    replacement.owner = 'player';
    replacement.factionId = old.factionId;
    replacement.role = 'idle';
    replacement.position = { ...station.position };
    replacement.velocity = { x: 0, y: 0, z: 0 };
    this.world.ships = this.world.ships.filter(
      /** Remove the former controlled hull before installing its service replacement. */
      (s) => s.id !== old.id
    );
    this.world.addShip(replacement);
    this.world.controlledShipId = replacement.id;
    this.captain.controlledShipId = replacement.id;
    delete this.world.combat.defences[old.id];
    this.world.combat.clear();
    return { ok: true, message: `Now commanding ${replacement.name}.` };
  }
  /** Advance presentation travel seconds while keeping departure physics and persistent time frozen. */
  advanceTransit(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw Error('Invalid transit step');
    if (this.transit)
      this.transit.elapsed = Math.min(this.transit.duration, this.transit.elapsed + dt);
  }
  /** Abort a failed preparation without consuming journey time or modifying NPC schedules. */
  cancelTransit() {
    this.transit = null;
    this.transitCheckpoint = null;
  }
  /** Commit a fully prepared arrival once its minimum journey animation completes; callers own asset readiness. */
  completeJump(): Result {
    /** Return an arrival validation failure without releasing departure ownership. */
    const fail = (message: string) => ({ ok: false, message });
    /** Report a successfully committed arrival. */
    const ok = (message: string) => ({ ok: true, message });
    const transit = this.transit;
    if (!transit || transit.elapsed < transit.duration) return fail('The journey is not ready.');
    if (transit.fromSystemId !== this.systemId) return fail('Departure changed.');
    const hop = this.routes.connection(this.systemId, transit.connectionId);
    const gate = hop && this.gateById(hop.gateId);
    if (
      !hop ||
      !gate ||
      this.dockedAt ||
      !canJump(this.world.player, gate) ||
      !this.routes.access(hop).allowed
    )
      return fail('The departure route is no longer available.');
    const destination = this.catalog.systems[transit.systemId];
    const arrival = destination?.gates.find(
      /** Validate the original arrival anchor again before releasing departure resources. */
      (candidate) => candidate.id === transit.arrivalGateId
    );
    if (!arrival || hop.toSystemId !== destination.id || hop.arrivalGateId !== arrival.id)
      return fail('The arrival route changed.');
    const ship = this.world.player,
      defence = structuredClone(this.world.defenceFor(ship)),
      weaponMode = this.world.disable;
    this.traffic.leave(this.world, this.clock);
    this.snapshot();
    this.world.release();
    this.traffic.advanceBackground(this.clock, transit.duration);
    this.clock += transit.duration;
    ship.position = { ...arrival.position };
    ship.velocity = { x: 0, y: 0, z: 0 };
    ship.reload = [0, 0];
    this.systemId = destination.id;
    this.world = this.makeWorld(destination.id, ship);
    this.radio.clear();
    this.world.restoreDefence(ship.id, defence);
    this.world.disable = weaponMode;
    this.visits[destination.id] = (this.visits[destination.id] ?? 0) + 1;
    this.selection = destination.stations[0]
      ? { kind: 'station', id: destination.stations[0].id }
      : null;
    if (this.routeDestinationId === destination.id) this.routeDestinationId = null;
    if (this.routeDestinationId) {
      const next = this.routes.find(destination.id, this.routeDestinationId)?.hops[0];
      if (next) this.selection = { kind: 'gate', id: next.gateId };
    }
    this.transit = null;
    this.transitCheckpoint = null;
    this.observe({ type: 'jumped', systemId: destination.id });
    return ok(`Entered ${destination.name}.`);
  }
  /**
   * Synchronize the current world and serialize persistent session state; transient
   * rendering, projectiles and drive activation are omitted.
   */
  save() {
    if (this.transit && this.transitCheckpoint) return this.transitCheckpoint;
    this.snapshot();
    return JSON.stringify({
      version: 6,
      spatialVersion: this.catalog.spatialVersion,
      routeDestinationId: this.routeDestinationId,
      trafficEnabled: this.trafficEnabled,
      clock: this.clock,
      traffic: this.traffic.actors,
      followedActorId: this.followedActorId,
      contentVersion: 5,
      systemId: this.systemId,
      captain: this.captain,
      player: this.world.player,
      weaponMode: this.world.disable,
      dockedAt: this.dockedAt,
      selection: this.selected ? this.selection : null,
      systems: this.systems,
      markets: this.markets,
      activity: this.activity,
      visits: this.visits
    });
  }
}
