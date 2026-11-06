import { RouteResolver } from '../../content/routes';
import { distance } from '../../core/model';
import { assignShipDesign, getCulture } from '../../content/identity';
import type { Ship, DefenceState } from '../../core/model';
import type { ContentCatalog } from '../../content/catalog';
import type { TrafficJobs } from './registry';
import { TrafficNavigation } from './navigation';
import {
  actorSystemId,
  type Destination,
  type RunningMotion,
  type TrafficAction,
  type TrafficActor,
  type TrafficMotion,
  type TravelAction
} from './model';
import { record, text, integer, number, systemId, point, destination, port } from './validation';
type Readers = { ship: (raw: unknown) => Ship; defence: (raw: unknown) => DefenceState };
/**
 * Decode a saved generic wait or travel task and reject unsupported actions or broken
 * destination references.
 */
function action(raw: unknown, catalog: ContentCatalog): TrafficAction {
  const r = record(raw),
    activity = text(r.activity);
  if (r.kind === 'wait') return { kind: 'wait', activity, duration: number(r.duration, 0.01, 600) };
  if (r.kind === 'travel')
    return { kind: 'travel', activity, destination: destination(r.destination, catalog) };
  throw Error('Unknown traffic action.');
}
/**
 * Validate an active motion record, including committed gate IDs and optional legacy hop
 * reconstruction.
 */
function running(raw: unknown, catalog: ContentCatalog, legacyHops = false): RunningMotion {
  const r = record(raw),
    a = action(r.action, catalog);
  if (r.kind === 'waiting') {
    if (a.kind !== 'wait') throw Error('Waiting requires a wait action.');
    return {
      kind: 'waiting',
      systemId: systemId(r.systemId, catalog),
      until: number(r.until),
      action: a
    };
  }
  if (a.kind !== 'travel') throw Error('Travel requires a destination.');
  if (r.kind === 'awaiting-route')
    return {
      kind: 'awaiting-route',
      systemId: systemId(r.systemId, catalog),
      retryAt: number(r.retryAt),
      action: a
    };
  if (r.kind === 'flight') {
    const id = systemId(r.systemId, catalog),
      l = record(r.leg),
      startedAt = number(l.startedAt),
      arriveAt = number(l.arriveAt);
    if (arriveAt <= startedAt || (r.stage !== 'egress' && r.stage !== 'destination'))
      throw Error('Invalid flight leg.');
    const leg = {
      from: point(l.from, catalog, id),
      to: point(l.to, catalog, id),
      startedAt,
      arriveAt
    };
    if (r.stage === 'destination') {
      if (a.destination.systemId !== id) throw Error('Invalid flight destination.');
      return { kind: 'flight', systemId: id, stage: 'destination', leg, action: a };
    }
    const routes = new RouteResolver(catalog);
    const legacy =
      legacyHops && r.gateId === undefined
        ? catalog.systems[id].gates.find(
            /**
             * Match an old exit leg's endpoint to a physical gate that reaches its recorded
             * destination.
             */
            (g) =>
              distance(g.position, leg.to) < 0.01 &&
              g.connections.some(
                /** Require a matching destination while reconstructing an old save's committed exit. */
                (c) => c.systemId === a.destination.systemId
              )
          )
        : undefined;
    const gateId = legacy?.id ?? text(r.gateId),
      connectionId =
        legacy?.connections.find(
          /** Recover the old flight's outgoing connection from its recorded destination. */
          (c) => c.systemId === a.destination.systemId
        )?.id ?? text(r.connectionId);
    const hop = routes.connection(id, connectionId),
      gate = catalog.systems[id].gates.find(
        /** Resolve the explicitly saved departure gate for exit-leg validation. */
        (g) => g.id === gateId
      );
    if (
      !hop ||
      !gate ||
      hop.gateId !== gateId ||
      a.destination.systemId === id ||
      distance(gate.position, leg.to) > 0.01 ||
      !routes.find(hop.toSystemId, a.destination.systemId)
    )
      throw Error('Invalid egress leg.');
    return { kind: 'flight', systemId: id, stage: 'egress', gateId, connectionId, leg, action: a };
  }
  if (r.kind === 'charging') {
    const id = systemId(r.systemId, catalog),
      gateId = text(r.gateId),
      connectionId = text(r.connectionId),
      gate = catalog.systems[id].gates.find(
        /** Resolve the departure gate for a saved charging state. */
        (g) => g.id === gateId
      );
    if (
      !gate?.connections.some(
        /**
         * Require the saved charging connection to permit a continued route to the final task
         * destination.
         */
        (c) =>
          c.id === connectionId &&
          !!new RouteResolver(catalog).find(c.systemId, a.destination.systemId)
      )
    )
      throw Error('Invalid charging connection.');
    return {
      kind: 'charging',
      systemId: id,
      gateId,
      connectionId,
      until: number(r.until),
      action: a
    };
  }
  if (r.kind === 'transit') {
    const fromSystemId = systemId(r.fromSystemId, catalog),
      arrivalSystemId = systemId(r.arrivalSystemId, catalog),
      arrivalGateId = text(r.arrivalGateId);
    if (
      r.systemId !== null ||
      !new RouteResolver(catalog).find(arrivalSystemId, a.destination.systemId) ||
      !catalog.systems[fromSystemId].gates.some(
        /** Verify that a saved transit arrival is linked from the recorded departure system. */
        (g) =>
          g.connections.some(
            /** Match both arrival system and exact arrival-gate ID against an outgoing connection. */
            (c) => c.systemId === arrivalSystemId && c.gateId === arrivalGateId
          )
      )
    )
      throw Error('Invalid transit destination.');
    return {
      kind: 'transit',
      systemId: null,
      fromSystemId,
      arrivalSystemId,
      arrivalGateId,
      until: number(r.until),
      action: a
    };
  }
  throw Error('Invalid running motion.');
}
/**
 * Decode running, suspended or retired motion while enforcing compatible locations and
 * resumable tasks.
 */
function motion(raw: unknown, catalog: ContentCatalog, legacyHops = false): TrafficMotion {
  const r = record(raw);
  if (r.kind === 'captured' || r.kind === 'destroyed')
    return { kind: r.kind, systemId: r.systemId === null ? null : systemId(r.systemId, catalog) };
  if (r.kind === 'interrupted' || r.kind === 'disabled') {
    const resume = running(r.resume, catalog, legacyHops),
      id = systemId(r.systemId, catalog);
    if (resume.kind === 'transit' || resume.systemId !== id)
      throw Error('Invalid interrupted motion.');
    return { kind: r.kind, systemId: id, since: number(r.since), resume };
  }
  return running(raw, catalog, legacyHops);
}
/**
 * Restore unique, validated NPC identities, jobs, hulls and motion records without
 * silently replacing unknown policies or cultures.
 */
export function readTraffic(
  raw: unknown,
  catalog: ContentCatalog,
  jobs: TrafficJobs,
  read: Readers,
  playerId: string,
  allowLegacyIdentity = false,
  legacyHops = false
): TrafficActor[] {
  if (!Array.isArray(raw) || raw.length > 256) throw Error('Invalid traffic ledger.');
  const ids = new Set<string>();
  return raw.map(
    /**
     * Decode one saved NPC through its policy, identity, ownership and motion validators
     * before returning a ledger actor.
     */
    (value) => {
      const r = record(value),
        ship = read.ship(r.ship),
        homeSystemId = systemId(r.homeSystemId, catalog),
        j = record(r.job),
        kind = text(j.kind),
        job = jobs.get(kind).read(j.config, j.state, catalog),
        m = motion(r.motion, catalog, legacyHops);
      const cultureId =
        r.cultureId === undefined && allowLegacyIdentity
          ? (catalog.systems[homeSystemId].traffic.find(
              /** Use an explicit authored culture override when an older schema omitted crew identity. */
              (t) => t.ship.id === ship.id
            )?.cultureId ?? catalog.systems[homeSystemId].cultureId)
          : r.cultureId;
      if (typeof cultureId !== 'string') throw Error('Missing NPC culture.');
      getCulture(catalog, cultureId);
      assignShipDesign(catalog, ship, cultureId, catalog.systems[homeSystemId].seed, kind);
      if (ids.has(ship.id)) throw Error('Duplicate traffic identity.');
      ids.add(ship.id);
      if (
        ((ship.id === playerId || ship.owner === 'player' || ship.owner === 'salvage') &&
          m.kind !== 'captured') ||
        (m.kind === 'destroyed' && ship.hull > 0) ||
        (m.kind === 'captured' && ship.owner !== 'player' && ship.owner !== 'salvage')
      )
        throw Error('Invalid traffic ownership.');
      if (
        !Array.isArray(r.hostileTo) ||
        r.hostileTo.length > 256 ||
        r.hostileTo.some(
          /** Reject malformed hostility targets and self-hostility in a saved actor record. */
          (id) => typeof id !== 'string' || !id.match(/^[a-z][a-z0-9-]*$/) || id === ship.id
        )
      )
        throw Error('Invalid traffic hostility.');
      return {
        cultureId,
        ship,
        homeSystemId,
        job,
        motion: m,
        hostileTo: [...new Set<string>(r.hostileTo)],
        sequence: integer(r.sequence, 0, Number.MAX_SAFE_INTEGER),
        journeys: integer(r.journeys, 0, Number.MAX_SAFE_INTEGER),
        defence: r.defence === undefined ? undefined : read.defence(r.defence)
      };
    }
  );
}
/**
 * Translate old freight-only phases into generic jobs and motion, preserving position,
 * progress, hostility and equipment state.
 */
export function migrateTrafficV3(
  raw: unknown,
  catalog: ContentCatalog,
  jobs: TrafficJobs,
  read: Readers,
  playerId: string,
  clock: number
): TrafficActor[] {
  if (!Array.isArray(raw) || raw.length > 256) throw Error('Invalid legacy traffic ledger.');
  const nav = new TrafficNavigation(
    catalog,
    /**
     * Suppress announcements while a legacy job is being translated; loading a save must not
     * produce fresh chatter.
     */
    () => {}
  );
  const converted = raw.map(
    /**
     * Translate one freight-only legacy actor into the generic policy and motion
     * representation.
     */
    (value) => {
      const r = record(value),
        ship = read.ship(r.ship),
        origin = port(r.origin, catalog),
        to = port(r.destination, catalog),
        phase = text(r.phase),
        until = number(r.until);
      if (
        ![
          'loading',
          'outbound',
          'charging',
          'transit',
          'inbound',
          'unloading',
          'interrupted',
          'disabled',
          'captured',
          'destroyed'
        ].includes(phase) ||
        (r.resume !== 'outbound' && r.resume !== 'inbound')
      )
        throw Error('Invalid legacy traffic phase.');
      const config = { route: [origin, to], quantity: 12, loadingSeconds: 5, unloadingSeconds: 6 };
      jobs.get('freight').validate(config, catalog);
      if (
        (phase === 'transit' && r.systemId !== null) ||
        (!['transit', 'captured', 'destroyed'].includes(phase) && r.systemId === null)
      )
        throw Error('Invalid legacy traffic location.');
      const id = r.systemId === null ? null : systemId(r.systemId, catalog),
        travel: TravelAction = {
          kind: 'travel',
          activity: 'Delivering cargo',
          destination: { kind: 'station', ...to }
        };
      const homeSystemId =
        Object.values(catalog.systems).find(
          /** Find the actor's authored home system before applying legacy identity defaults. */
          (s) =>
            s.traffic.some(
              /** Match the legacy hull to its original authored spawn. */
              (t) => t.ship.id === ship.id
            )
        )?.id ?? origin.systemId;
      const actor: TrafficActor = {
        cultureId:
          catalog.systems[homeSystemId].traffic.find(
            /** Retain an explicit spawn-culture override while constructing the migrated actor. */
            (t) => t.ship.id === ship.id
          )?.cultureId ?? catalog.systems[homeSystemId].cultureId,
        ship,
        homeSystemId,
        job: {
          kind: 'freight',
          config,
          state: {
            origin: 0,
            next: phase === 'loading' ? 'depart' : phase === 'unloading' ? 'finish' : 'dock'
          }
        },
        motion: { kind: 'captured', systemId: id },
        hostileTo: r.hostileTo as string[],
        sequence: r.sequence as number,
        journeys: r.journeys as number,
        defence: r.defence as DefenceState | undefined
      };
      const outbound =
        phase === 'outbound' ||
        phase === 'charging' ||
        phase === 'transit' ||
        ((phase === 'interrupted' || phase === 'disabled') && r.resume === 'outbound');
      const gate = catalog.systems[origin.systemId].gates.find(
          /** Locate the legacy route's departure gate for its recorded destination system. */
          (g) =>
            g.connections.some(
              /** Find an outgoing connection leading to the legacy freight destination. */
              (c) => c.systemId === to.systemId
            )
        )!,
        link = gate.connections.find(
          /** Select that gate's connection to preserve the old journey's arrival endpoint. */
          (c) => c.systemId === to.systemId
        )!;
      if (phase === 'captured' || phase === 'destroyed')
        actor.motion = { kind: phase, systemId: id };
      else if (phase === 'loading' || phase === 'unloading')
        actor.motion = {
          kind: 'waiting',
          systemId: id!,
          until,
          action: {
            kind: 'wait',
            duration: phase === 'loading' ? 5 : 6,
            activity: phase === 'loading' ? 'Loading cargo' : 'Unloading cargo'
          }
        };
      else if (phase === 'charging')
        actor.motion = {
          kind: 'charging',
          systemId: id!,
          gateId: gate.id,
          connectionId: link.id,
          until,
          action: travel
        };
      else if (phase === 'transit')
        actor.motion = {
          kind: 'transit',
          systemId: null,
          fromSystemId: origin.systemId,
          arrivalSystemId: to.systemId,
          arrivalGateId: link.gateId,
          until,
          action: travel
        };
      else {
        const target = outbound ? gate.position : nav.resolve(travel.destination, ship.id),
          leg =
            phase === 'interrupted' || phase === 'disabled' ? nav.leg(actor, clock, target) : r.leg;
        const base = {
          kind: 'flight' as const,
          systemId: id!,
          ...(outbound
            ? { stage: 'egress' as const, gateId: gate.id, connectionId: link.id }
            : { stage: 'destination' as const }),
          action: travel,
          leg: leg as Extract<RunningMotion, { kind: 'flight' }>['leg']
        };
        actor.motion =
          phase === 'interrupted' || phase === 'disabled'
            ? { kind: phase, systemId: id!, since: clock, resume: base }
            : base;
      }
      // Legacy phase/leg consistency is checked before dropping the old fields.
      if ((phase === 'outbound' || phase === 'inbound') !== (r.leg !== null))
        throw Error('Invalid legacy traffic leg.');
      return actor;
    }
  );
  return readTraffic(converted, catalog, jobs, read, playerId);
}
