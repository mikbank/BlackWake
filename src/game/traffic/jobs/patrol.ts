import { distance } from '../../../core/model';
import { waypointOrder } from '../../../core/pilot';
import type { JobStep, Destination, JobPolicy } from '../model';
import { record, integer, number, waypoints, text, destinationName } from '../validation';
type Config = { waypoints: Destination[]; holdSeconds: number; responseRange: number };
type State = {
  index: number;
  next: 'depart' | 'survey';
  respondingTo: string | null;
  responseUntil: number;
};
export const patrolPolicy: JobPolicy<Config, State> = {
  kind: 'patrol',
  /** Validate a same-system patrol circuit, survey dwell time and aggression response range. */
  readConfig(raw, catalog) {
    const r = record(raw),
      points = waypoints(r.waypoints, catalog);
    if (
      points.some(
        /** Reject patrol waypoints outside the patrol's assigned system. */
        (p) => p.systemId !== points[0].systemId
      )
    )
      throw Error('A patrol must stay in its assigned system.');
    return {
      waypoints: points,
      holdSeconds: number(r.holdSeconds ?? 5, 0.1, 120),
      responseRange: number(r.responseRange ?? 5500, 100, 15000)
    };
  },
  /**
   * Validate circuit progress and the current temporary response target before restoring a
   * patrol.
   */
  readState(raw, c) {
    const r = record(raw);
    if (r.next !== 'depart' && r.next !== 'survey') throw Error('Invalid patrol stage.');
    return {
      index: integer(r.index, 0, c.waypoints.length - 1),
      next: r.next,
      respondingTo: r.respondingTo === null ? null : text(r.respondingTo),
      responseUntil: number(r.responseUntil)
    };
  },
  /**
   * Initialize a local security circuit and reject a patrol authored in the wrong home
   * system.
   */
  create(ctx, c) {
    if (c.waypoints[0].systemId !== ctx.homeSystemId)
      throw Error('Patrol spawn must belong to its assigned system.');
    return { index: 0, next: 'depart', respondingTo: null, responseUntil: 0 };
  },
  /**
   * Alternate waypoint travel and sector surveys, wrapping the circuit and reporting
   * completed checks.
   */
  next(ctx, c, s): JobStep<State> {
    const target = c.waypoints[s.index],
      name = destinationName(target, ctx.catalog);
    if (s.next === 'depart')
      return {
        state: { ...s, next: 'survey' },
        action: { kind: 'travel', destination: target, activity: `Patrolling ${name}` }
      };
    return {
      state: { ...s, index: (s.index + 1) % c.waypoints.length, next: 'depart' },
      action: { kind: 'wait', duration: c.holdSeconds, activity: `Surveying ${name}` },
      completedJourney: s.index === c.waypoints.length - 1,
      announcement: { topic: 'patrol.clear', values: { sector: name } }
    };
  },
  /**
   * React to a nearby non-police offender, deduplicate repeated warnings and request
   * temporary hostility and a response announcement.
   */
  onAggression(ctx, c, s, event) {
    if (s.respondingTo === event.attacker.id && ctx.now < s.responseUntil) return;
    if (
      event.systemId !== ctx.systemId ||
      event.attacker.id === ctx.ship.id ||
      event.attacker.factionId === 'police' ||
      distance(ctx.ship.position, event.victim.position) > c.responseRange
    )
      return;
    return {
      state: { ...s, respondingTo: event.attacker.id, responseUntil: ctx.now + 45 },
      hostileTo: [event.attacker.id],
      announcement: {
        topic: 'patrol.respond',
        values: { target: event.attacker.name },
        urgent: true
      }
    };
  },
  /**
   * Override normal patrol travel while pursuing a live response target within the
   * configured range and time window.
   */
  order(ctx, c, s) {
    if (!ctx.active || !s.respondingTo || ctx.now > s.responseUntil) return;
    const target = ctx.ships.find(
      /**
       * Resolve a surviving, non-salvage offender before temporarily overriding normal patrol
       * travel.
       */
      (p) => p.id === s.respondingTo && p.hull > 0 && p.owner !== 'salvage'
    );
    if (target && distance(ctx.ship.position, target.position) < c.responseRange)
      return waypointOrder(ctx.ship, target.position);
  },
  /** Describe routine patrol or a current aggression response for the contact UI. */
  describe(ctx, _c, s) {
    return {
      title: 'Police patrol',
      purpose:
        s.respondingTo && ctx.now < s.responseUntil
          ? 'Responding to reported aggression'
          : 'System security circuit',
      manifest: 'Security crew · no commercial cargo'
    };
  }
};
