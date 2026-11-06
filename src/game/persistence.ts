import { upgradeStockJourneys } from './traffic/journey-upgrades';
import { migrateSpatialSave } from './spatial-migration';
import { assignShipDesign, validateShipDesign, getCulture } from '../content/identity';
import { isRetired } from './traffic';
import { readTraffic, migrateTrafficV3 } from './traffic/persistence';
import { createTrafficJobs } from './traffic/jobs';
import type { TrafficJobs } from './traffic/registry';
import { GameSession, type SystemSnapshot } from './session';
import { World, definitions, freshDefence, type Ship, type DefenceState } from '../simulation';
import type { ContentCatalog } from '../content/catalog';
import type { ServiceRegistry } from './services';
import type { ActivityRegistry } from './activities';
import { startRaid } from './start';
/** Recognize a non-array JSON object before decoding fields from an untrusted save. */
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
/**
 * Check finite coordinates, accepting a missing Z only for backward-compatible planar
 * saves.
 */
function point(x: any) {
  return object(x) && [x.x, x.y, x.z ?? 0].every(Number.isFinite);
}
/**
 * Validate a saved hull, inventory and design references, supplying only the explicit
 * defaults allowed by legacy schemas.
 */
function ship(raw: any, catalog: ContentCatalog, legacy = false, requireIdentity = false): Ship {
  if (
    !object(raw) ||
    !String(raw.id).match(/^[a-z][a-z0-9-]*$/) ||
    typeof raw.name !== 'string' ||
    raw.name.length > 80 ||
    !definitions[raw.kind as keyof typeof definitions] ||
    !point(raw.position) ||
    !point(raw.velocity) ||
    ![raw.heading, raw.hull, raw.engines, raw.crew].every(Number.isFinite) ||
    raw.hull < 0 ||
    raw.hull > 100 ||
    raw.engines < 0 ||
    raw.engines > 100 ||
    !Number.isInteger(raw.crew) ||
    raw.crew < 0 ||
    !Array.isArray(raw.reload) ||
    raw.reload.length !== 2 ||
    raw.reload.some(
      /** Reject invalid saved reload timers before rebuilding the hull. */
      (n: any) => !Number.isFinite(n) || n < 0
    )
  )
    throw Error('Invalid ship in save.');
  if (requireIdentity && raw.designId === undefined) throw Error('Missing ship design.');
  if (raw.designId !== undefined)
    validateShipDesign({ kind: raw.kind, designId: raw.designId }, catalog.shipDesigns);
  const cargo = raw.cargo ?? (legacy ? {} : null);
  if (
    !object(cargo) ||
    Object.entries(cargo).some(
      /** Reject unknown goods or unsafe, negative cargo quantities. */
      ([id, q]) => !catalog.commodities[id] || !Number.isSafeInteger(q) || q < 0
    )
  )
    throw Error('Invalid cargo.');
  if (
    raw.livery !== undefined &&
    (typeof raw.livery !== 'string' || !raw.livery.match(/^[a-z][a-z0-9-]*$/))
  )
    throw Error('Invalid livery.');
  if (
    typeof raw.owner !== 'string' ||
    (!legacy &&
      (typeof raw.factionId !== 'string' || !['idle', 'trader', 'hostile'].includes(raw.role)))
  )
    throw Error('Invalid ship ownership.');
  return {
    ...raw,
    position: { ...raw.position, z: raw.position.z ?? 0 },
    velocity: { ...raw.velocity, z: raw.velocity.z ?? 0 },
    cargo: { ...cargo },
    factionId: raw.factionId ?? (raw.owner === 'player' ? 'independent' : 'guild'),
    role: raw.role ?? (raw.owner === 'guild' ? 'hostile' : 'idle')
  } as Ship;
}
/**
 * Validate saved PDC timers and counters and rebuild independent state records keyed by
 * ship ID.
 */
function defences(raw: any): Record<string, DefenceState> {
  if (!object(raw)) throw Error('Invalid defence state.');
  const out: Record<string, DefenceState> = {};
  for (const [id, d] of Object.entries(raw)) {
    if (!object(d)) throw Error('Invalid defence state.');
    const merged = { ...freshDefence(), ...d };
    if (
      ![merged.cooldown, merged.cadence].every(
        /** Require saved PDC cooldown and cadence timers to be finite and nonnegative. */
        (n) => Number.isFinite(n) && n >= 0
      ) ||
      ![0, 1].includes(merged.mount) ||
      ![merged.interceptions, merged.roundsFired, merged.burstRemaining].every(
        /** Require saved PDC counters to be nonnegative safe integers. */
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      merged.burstRemaining > 3
    )
      throw Error('Invalid defence state.');
    out[id] = merged;
  }
  return out;
}
/**
 * Decode and migrate supported saves, restore their authoritative state and reconcile new
 * content without reseeding retired actors.
 */
export function loadSession(
  raw: string,
  catalog: ContentCatalog,
  services: ServiceRegistry,
  activities: ActivityRegistry,
  jobs: TrafficJobs = createTrafficJobs()
): GameSession {
  const d = JSON.parse(raw);
  if (!object(d)) throw Error('Invalid save.');
  const scaledLegacyCoordinates = migrateSpatialSave(d, catalog.spatialVersion);
  if (d.version === 1) {
    if (
      !Array.isArray(d.ships) ||
      d.ships.length !== 2 ||
      !['raid', 'captured', 'won', 'lost'].includes(d.stage)
    )
      throw Error('Invalid legacy raid.');
    const ships = d.ships.map(
        /** Decode legacy raid hulls and resolve their original default designs. */
        (s: any) => assignShipDesign(catalog, ship(s, catalog, true), catalog.defaultCultureId, 0)
      ),
      players = ships.filter(
        /** Locate the single player-owned hull when migrating the original raid format. */
        (s: Ship) => s.owner === 'player'
      );
    if (players.length !== 1) throw Error('Invalid legacy captain.');
    const session = startRaid(catalog, services, activities);
    session.world = new World(ships, players[0].id, session.definition.radius);
    session.captain.controlledShipId = players[0].id;
    session.world.elapsed = Number.isFinite(d.elapsed) ? d.elapsed : 0;
    session.world.disable = d.disable !== false;
    session.world.combat.defences = defences(
      d.defences ?? (d.pointDefence ? { wayward: d.pointDefence } : {})
    );
    const target = ships.find(
      /** Identify the legacy raid's other ship as its encounter target. */
      (s: Ship) => s.id !== 'wayward'
    )!;
    session.world.relations.declareHostile('wayward', target.id);
    session.activity!.config.target = target.id;
    session.activity!.state = {
      captured: ['captured', 'won'].includes(d.stage),
      complete: d.stage === 'won',
      failed: d.stage === 'lost' && players[0].hull > 0
    };
    session.selection = session.activity!.state.captured
      ? { kind: 'station', id: 'haven' }
      : { kind: 'ship', id: target.id };
    return session;
  }
  if (
    ![2, 3, 4, 5, 6].includes(d.version) ||
    !catalog.systems[d.systemId] ||
    !object(d.captain) ||
    !Number.isSafeInteger(d.captain.credits) ||
    d.captain.credits < 0 ||
    !object(d.systems) ||
    !object(d.markets) ||
    !object(d.visits)
  )
    throw Error('Unsupported or invalid voyage save.');
  const captainCultureId =
    d.version >= 5 ? d.captain.cultureId : (d.captain.cultureId ?? catalog.defaultCultureId);
  getCulture(catalog, captainCultureId);
  const player = assignShipDesign(
    catalog,
    ship(d.player, catalog, false, d.version >= 5),
    captainCultureId,
    0
  );
  if (player.id !== d.captain.controlledShipId || player.owner !== 'player')
    throw Error('Invalid captain.');
  const session = new GameSession(catalog, services, activities, d.systemId, player, jobs);
  session.captain = {
    cultureId: captainCultureId,
    credits: d.captain.credits,
    controlledShipId: player.id
  };
  for (const [id, value] of Object.entries(d.systems)) {
    if (
      !catalog.systems[id] ||
      !object(value) ||
      !Array.isArray(value.ships) ||
      !Array.isArray(value.hostilePairs) ||
      !value.hostilePairs.every(
        /** Require serialized hostility-pair entries to be strings before restoring relations. */
        (s: any) => typeof s === 'string'
      ) ||
      !Number.isFinite(value.elapsed) ||
      value.elapsed < 0
    )
      throw Error('Invalid saved system.');
    const ships = value.ships.map(
      /**
       * Decode an unmanaged saved hull and resolve only identity defaults permitted by its
       * schema.
       */
      (s: any) => {
        const vessel = ship(s, catalog, false, d.version >= 5);
        const cultureId =
          catalog.systems[id].traffic.find(
            /**
             * Resolve an authored spawn override before falling back to the saved hull's local system
             * culture.
             */
            (t) => t.ship.id === vessel.id
          )?.cultureId ?? catalog.systems[id].cultureId;
        return assignShipDesign(catalog, vessel, cultureId, catalog.systems[id].seed);
      }
    );
    const ids = new Set(
      ships.map(
        /** Collect hull IDs to detect duplicates and accidental duplication of the controlled ship. */
        (s: Ship) => s.id
      )
    );
    if (ids.size !== ships.length || ids.has(player.id)) throw Error('Duplicate ship in save.');
    session.systems[id] = {
      ships,
      defences: defences(value.defences),
      hostilePairs: [...value.hostilePairs],
      elapsed: value.elapsed
    };
  }
  for (const [id, value] of Object.entries(d.markets)) {
    const station = Object.values(catalog.systems)
      .flatMap(
        /** Collect authored stations across systems before restoring station-specific market stock. */
        (s) => s.stations
      )
      .find(
        /** Find the station owning this saved stock record. */
        (s) => s.id === id
      );
    if (
      !station ||
      !object(value) ||
      !object(value.stock) ||
      Object.entries(value.stock).some(
        /** Reject unknown commodities or unsafe stock quantities in saved market state. */
        ([good, q]) => !catalog.commodities[good] || !Number.isSafeInteger(q) || q < 0
      )
    )
      throw Error('Invalid market stock.');
    session.markets[id] = { stock: { ...value.stock } };
  }
  if (d.version >= 6) {
    if (
      d.routeDestinationId !== null &&
      (typeof d.routeDestinationId !== 'string' ||
        !Object.hasOwn(catalog.systems, d.routeDestinationId) ||
        d.routeDestinationId === d.systemId)
    )
      throw Error('Invalid plotted route destination.');
    session.routeDestinationId = d.routeDestinationId;
  }
  const current = session.systems[d.systemId];
  if (!current) throw Error('Current system is missing.');
  session.world = new World(
    [player, ...structuredClone(current.ships)],
    player.id,
    session.definition.radius
  );
  session.world.combat.defences = structuredClone(current.defences);
  session.world.relations.hostilePairs = [...current.hostilePairs];
  session.world.elapsed = current.elapsed;
  session.world.disable = d.weaponMode !== false;
  if (d.dockedAt !== null && (!session.stationById(d.dockedAt) || typeof d.dockedAt !== 'string'))
    throw Error('Unknown dock.');
  session.dockedAt = d.dockedAt;
  if (d.version >= 3) {
    if (!Number.isFinite(d.clock) || d.clock < 0 || d.clock > 1e12)
      throw Error('Invalid simulation clock.');
    session.clock = d.clock;
    const readers = {
      /**
       * Validate a saved hull, inventory and design references, supplying only the explicit
       * defaults allowed by legacy schemas.
       */
      ship: (raw: unknown) => ship(raw, catalog, false, d.version >= 5),
      /** Decode one actor's PDC state through the shared defence-state validator. */
      defence: (raw: unknown) => defences({ actor: raw }).actor
    };
    session.traffic.actors =
      d.version === 3
        ? migrateTrafficV3(d.traffic, catalog, jobs, readers, player.id, d.clock)
        : readTraffic(d.traffic, catalog, jobs, readers, player.id, d.version < 5, d.version < 6);
    if (scaledLegacyCoordinates) {
      for (const actor of session.traffic.actors) {
        const motion =
          actor.motion.kind === 'disabled' || actor.motion.kind === 'interrupted'
            ? actor.motion.resume
            : actor.motion;
        if (motion.kind !== 'flight') continue;
        const target =
          motion.stage === 'destination'
            ? session.traffic.navigation.resolve(
                motion.action.destination,
                actor.ship.id,
                actor.ship.kind
              )
            : motion.leg.to;
        motion.leg = session.traffic.navigation.leg(actor, session.clock, target);
      }
    }
    // Content v2 replaces three stock Frontier role models. This one-time art upgrade
    // leaves custom/foreign designs, captured hulls, identities and simulation state intact.
    if (d.contentVersion === undefined || d.contentVersion === 1) {
      const upgrades: Record<string, { role: string; livery: string; design: string }> = {
        'reach-transit': { role: 'passenger', livery: 'transit', design: 'frontier-transit' },
        'ashen-liner': { role: 'liner', livery: 'liner', design: 'frontier-liner' },
        'kepler-patrol': { role: 'patrol', livery: 'police', design: 'frontier-patrol' }
      };
      for (const actor of session.traffic.actors) {
        const upgrade = upgrades[actor.ship.id];
        if (
          upgrade &&
          actor.cultureId === 'frontier' &&
          !isRetired(actor) &&
          actor.job.kind === upgrade.role &&
          actor.ship.livery === upgrade.livery &&
          actor.ship.designId === `industrial-${actor.ship.kind}` &&
          catalog.shipDesigns[upgrade.design]?.kind === actor.ship.kind
        )
          actor.ship.designId = upgrade.design;
      }
    }
    // Correct only the six stock freighters from the pre-region generator. Visitors,
    // custom hulls, captured ships and all unrelated actors retain their saved identity.
    if ((d.contentVersion ?? 1) < 3) {
      for (let i = 1; i <= 6; i++) {
        const homeId = `drift-${String(i).padStart(3, '0')}`;
        const actor = session.traffic.get(`${homeId}-freight-1`);
        const home = catalog.systems[homeId];
        const spawn = home?.traffic.find(
          /**
           * Locate the exact original stock freighter eligible for the one-time regional content
           * correction.
           */
          (s) => s.ship.id === actor?.ship.id
        );
        if (
          !actor ||
          !home ||
          !spawn ||
          isRetired(actor) ||
          actor.homeSystemId !== homeId ||
          actor.job.kind !== 'freight' ||
          actor.cultureId !== 'frontier' ||
          actor.ship.owner !== 'guild' ||
          actor.ship.designId !== 'industrial-merchant' ||
          home.regionId !== 'lantern-marches' ||
          home.cultureId !== 'aster'
        )
          continue;
        actor.cultureId = spawn.cultureId ?? home.cultureId;
        actor.ship.designId = undefined;
        assignShipDesign(catalog, actor.ship, actor.cultureId, home.seed, actor.job.kind);
        if (actor.ship.name === `Drift ${i} Runner 1`) actor.ship.name = spawn.ship.name;
      }
    }
    // Add initial luxury provisions once to the two established, previously empty liners.
    // Current-revision depleted holds and captured/custom cargo are never replenished on load.
    if ((d.contentVersion ?? 1) < 4) {
      for (const id of ['ashen-liner', 'aster-commonlight']) {
        const actor = session.traffic.get(id);
        const spawn = Object.values(catalog.systems)
          .flatMap(
            /** Find the authored initial supplies without tying cargo ownership to the current system. */
            (system) => system.traffic
          )
          .find(
            /** Limit the migration to the two original stable liner identities. */
            (entry) => entry.ship.id === id
          );
        if (
          actor &&
          spawn &&
          actor.job.kind === 'liner' &&
          !isRetired(actor) &&
          !Object.values(actor.ship.cargo).some(
            /** Preserve any existing manifest instead of replacing player or authored cargo. */
            (quantity) => quantity > 0
          )
        )
          actor.ship.cargo = structuredClone(spawn.ship.cargo);
      }
    }
    if ((d.contentVersion ?? 1) < 5) upgradeStockJourneys(session.traffic.actors, catalog, jobs);
    const ids = new Set(
      session.traffic.actors.map(
        /** Collect managed actor IDs so system snapshots cannot own those same hulls twice. */
        (a) => a.ship.id
      )
    );
    for (const snapshot of Object.values(session.systems))
      if (
        snapshot.ships.some(
          /** Reject a snapshot containing a hull already owned by the traffic ledger. */
          (s) => ids.has(s.id)
        )
      )
        throw Error('Traffic actor duplicated in system snapshot.');
    if (
      d.followedActorId !== null &&
      (typeof d.followedActorId !== 'string' ||
        !session.traffic.get(d.followedActorId) ||
        isRetired(session.traffic.get(d.followedActorId)!))
    )
      throw Error('Invalid followed ship.');
    session.followedActorId = d.followedActorId;
    if (d.version >= 4 && typeof d.trafficEnabled !== 'boolean')
      throw Error('Invalid traffic setting.');
    session.trafficEnabled = d.version >= 4 ? d.trafficEnabled : session.traffic.actors.length > 0;
    if (!session.trafficEnabled && session.traffic.actors.length)
      throw Error('Traffic ledger present while disabled.');
    session.bindTraffic();
  }
  if (d.selection !== null) {
    if (
      !object(d.selection) ||
      !session.contacts().some(
        /** Require the saved selection to resolve to an actual current contact. */
        (c) => c.kind === d.selection.kind && c.id === d.selection.id
      )
    )
      throw Error('Invalid selection.');
    session.selection = { kind: d.selection.kind, id: d.selection.id };
  } else session.selection = null;
  if (d.activity !== null) {
    if (
      !object(d.activity) ||
      typeof d.activity.type !== 'string' ||
      !object(d.activity.config) ||
      !Object.values(d.activity.config).every(
        /** Require optional activity configuration values to remain serializable strings. */
        (s) => typeof s === 'string'
      ) ||
      !object(d.activity.state) ||
      !Object.values(d.activity.state).every(
        /** Allow only finite primitive values in saved optional-activity progress. */
        (s) =>
          typeof s === 'string' ||
          typeof s === 'boolean' ||
          (typeof s === 'number' && Number.isFinite(s))
      )
    )
      throw Error('Invalid activity.');
    session.activity = {
      type: d.activity.type,
      config: { ...d.activity.config },
      state: { ...d.activity.state }
    };
  }
  for (const [id, n] of Object.entries(d.visits)) {
    if (!catalog.systems[id] || !Number.isSafeInteger(n) || n < 0)
      throw Error('Invalid visit count.');
    session.visits[id] = n;
  }
  if (d.version === 2 && session.activity?.type !== 'raid') {
    session.clock = Math.max(
      0,
      ...Object.values(session.systems).map(
        /**
         * Find the latest old system clock when initializing a legacy voyage's shared traffic
         * clock.
         */
        (s) => s.elapsed
      )
    );
    session.enableTraffic(true);
  } else if (session.trafficEnabled) session.enableTraffic();
  session.snapshot();
  return session;
}
