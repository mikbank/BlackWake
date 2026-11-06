import { RouteResolver } from '../../../content/routes';
import type { JobStep, Destination, JobPolicy, Port } from '../model';
import {
  record,
  integer,
  number,
  waypoints,
  destination,
  destinationName,
  port
} from '../validation';
import {
  chooseDestination,
  tourDestinations,
  readDestinationMemory,
  type DestinationMemory
} from '../destinations';
type Common = { passengers: number; stopSeconds: number };
export type LinerConfig = Common &
  (
    | { routing: 'circuit'; stops: Destination[] }
    | { routing: 'roaming'; home: Port; tourLength: number; minHops: number }
  );
export type CircuitLinerState = { index: number; next: 'depart' | 'visit' };
export type RoamingLinerState = CircuitLinerState &
  DestinationMemory & { destination: Destination | null };
type State = CircuitLinerState | RoamingLinerState;
export const linerPolicy: JobPolicy<LinerConfig, State> = {
  kind: 'liner',
  combatPosture: 'evade',
  /** Validate either an authored multi-system circuit or a roaming tour with a real home port. */
  readConfig(raw, catalog) {
    const r = record(raw),
      common = {
        passengers: integer(r.passengers ?? 80, 1, 1000),
        stopSeconds: number(r.stopSeconds ?? 9, 0.1, 120)
      };
    if (r.routing === 'roaming')
      return {
        ...common,
        routing: 'roaming',
        home: port(r.home, catalog),
        tourLength: integer(r.tourLength ?? 4, 3, 12),
        minHops: integer(r.minHops ?? 1, 1, 32)
      };
    if (r.routing !== undefined && r.routing !== 'circuit')
      throw Error('Unknown liner routing mode.');
    const stops = waypoints(r.stops, catalog),
      routes = new RouteResolver(catalog);
    for (let i = 0; i < stops.length; i++)
      if (!routes.find(stops[i].systemId, stops[(i + 1) % stops.length].systemId))
        throw Error('Liner circuit needs reachable stops and a return route.');
    return { ...common, routing: 'circuit', stops };
  },
  /** Restore an already planned sightseeing destination; loading a save never performs a random draw. */
  readState(raw, c, catalog) {
    const r = record(raw);
    if (r.next !== 'depart' && r.next !== 'visit') throw Error('Invalid liner stage.');
    if (c.routing === 'circuit')
      return { index: integer(r.index, 0, c.stops.length - 1), next: r.next };
    const target = r.destination === null ? null : destination(r.destination, catalog);
    if ((r.next === 'visit') !== !!target) throw Error('Invalid planned liner destination.');
    return {
      ...readDestinationMemory(r, catalog),
      index: integer(r.index, 0, c.tourLength),
      next: r.next,
      destination: target
    };
  },
  /** Start at home with an explicit itinerary mode and empty planning history beyond the home system. */
  create(ctx, c) {
    const home = c.routing === 'circuit' ? c.stops[0].systemId : c.home.systemId;
    if (home !== ctx.homeSystemId) throw Error('Liner spawn must belong to its home system.');
    return c.routing === 'circuit'
      ? { index: 0, next: 'depart' }
      : { index: 0, next: 'depart', decision: 0, recentSystems: [home], destination: null };
  },
  /** Commit each next stop only when its predecessor completes, retaining the goal through all intermediate jumps. */
  next(ctx, c, state): JobStep<State> {
    if (c.routing === 'circuit') {
      const stop = c.stops[state.index],
        name = destinationName(stop, ctx.catalog);
      if (state.next === 'depart')
        return {
          state: { ...state, next: 'visit' },
          action: { kind: 'travel', destination: stop, activity: `Sightseeing: ${name}` },
          announcement: {
            topic: 'liner.depart',
            values: { destination: name, passengers: c.passengers }
          }
        };
      return {
        state: { index: (state.index + 1) % c.stops.length, next: 'depart' },
        action: { kind: 'wait', duration: c.stopSeconds, activity: `Viewing ${name}` },
        completedJourney: state.index === c.stops.length - 1,
        announcement: { topic: 'liner.view', values: { destination: name } }
      };
    }
    // Registration validates config/state together; only roaming jobs own decision memory.
    const s = state as RoamingLinerState;
    if (s.next === 'visit') {
      const stop = s.destination!,
        name = destinationName(stop, ctx.catalog);
      const home =
        stop.kind === 'station' &&
        stop.systemId === c.home.systemId &&
        stop.stationId === c.home.stationId;
      return {
        state: {
          ...s,
          index: home ? 0 : Math.min(c.tourLength, s.index + 1),
          next: 'depart',
          destination: null
        },
        action: {
          kind: 'wait',
          duration: c.stopSeconds,
          activity: home ? 'Guests changing at home port' : `Viewing ${name}`
        },
        completedJourney: home,
        announcement: { topic: 'liner.view', values: { destination: name } }
      };
    }
    let target: Destination,
      decision = s.decision,
      recentSystems = s.recentSystems;
    if (s.index >= c.tourLength) target = { kind: 'station', ...c.home };
    else {
      const choice = chooseDestination(ctx, s, tourDestinations(ctx.catalog), c.minHops, [
        c.home.systemId
      ]);
      if (!choice)
        return {
          state: s,
          action: { kind: 'wait', duration: 5, activity: 'Waiting for an open tour route' }
        };
      target = choice.destination;
      decision = choice.decision;
      recentSystems = choice.recentSystems;
    }
    const name = destinationName(target, ctx.catalog);
    return {
      state: { ...s, next: 'visit', destination: target, decision, recentSystems },
      action: { kind: 'travel', destination: target, activity: `Cruise tour to ${name}` },
      announcement: {
        topic: 'liner.depart',
        values: { destination: name, passengers: c.passengers }
      }
    };
  },
  /** Describe the real committed stop and actual remaining luxury inventory independently of the destination culture. */
  describe(ctx, c, state) {
    const supplies = Object.entries(ctx.ship.cargo)
      .filter(
        /** Report only provisions still aboard after any raid. */ ([, quantity]) => quantity > 0
      )
      .map(
        /** Keep displayed supplies factual and use shared commodity naming. */ ([id, quantity]) =>
          `${quantity} ${ctx.catalog.commodities[id].name.toLowerCase()}`
      )
      .join(' · ');
    const target =
      c.routing === 'roaming' ? (state as RoamingLinerState).destination : c.stops[state.index];
    return {
      title: 'Leisure liner',
      purpose:
        c.routing === 'roaming'
          ? target
            ? `Multi-system cruise to ${destinationName(target, ctx.catalog)}`
            : 'Multi-system cruise · choosing the next stop'
          : `Sightseeing circuit: ${destinationName(target!, ctx.catalog)}`,
      manifest: `${c.passengers} guests aboard${supplies ? ' · ' + supplies : ' · Supplies depleted'}`
    };
  }
};
