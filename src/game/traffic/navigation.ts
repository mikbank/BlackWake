import { stationBerth } from '../station-approach';
import { jumpTravelSeconds } from '../jump-travel';
import { RouteResolver } from '../../content/routes';
import { definitions, distance, type Vec3, type Ship } from '../../core/model';
import type { ContentCatalog } from '../../content/catalog';
import {
  actorSystemId,
  type Announcement,
  type Destination,
  type JourneyLeg,
  type LocalMotion,
  type RunningMotion,
  type TrafficAction,
  type TrafficActor
} from './model';
import { destinationName } from './validation';

/**
 * Execute generic NPC travel and wait tasks across active physics and simplified
 * background simulation.
 */
export class TrafficNavigation {
  /**
   * Retain content, announcement delivery and the shared route resolver used by every job
   * family.
   */
  constructor(
    readonly catalog: ContentCatalog,
    private emit: (actor: TrafficActor, now: number, event: Announcement) => void,
    readonly routes: RouteResolver = new RouteResolver(catalog)
  ) {}
  /**
   * Resolve a station or waypoint into a world position, including the arrival offset used
   * for a specific actor.
   */
  resolve(destination: Destination, shipId: string, kind: Ship['kind'] = 'merchant'): Vec3 {
    if (destination.kind === 'point') return { ...destination.position };
    const station = this.catalog.systems[destination.systemId].stations.find(
      /** Resolve the station endpoint of the generic travel task. */
      (s) => s.id === destination.stationId
    )!;
    const system = this.catalog.systems[destination.systemId];
    const ship = { id: shipId, kind };
    return stationBerth(station, this.catalog.stationSizes[station.size], ship, system.radius);
  }
  /**
   * Describe a background flight segment from the actor's current position to a target with
   * its scheduled start and arrival times.
   */
  leg(actor: TrafficActor, now: number, to: Vec3): JourneyLeg {
    const from = { ...actor.ship.position };
    return {
      from,
      to: { ...to },
      startedAt: now,
      arriveAt: now + distance(from, to) / (definitions[actor.ship.kind].speed * 0.85) + 4
    };
  }
  /**
   * Turn a travel/wait task into a motion state, selecting the committed exit or waiting for
   * an unavailable route.
   */
  start(actor: TrafficActor, action: TrafficAction, now: number): RunningMotion {
    const systemId = actorSystemId(actor);
    if (!systemId) throw Error('Cannot start a task while in transit.');
    if (action.kind === 'wait')
      return { kind: 'waiting', systemId, until: now + action.duration, action };
    if (action.destination.systemId === systemId)
      return {
        kind: 'flight',
        systemId,
        stage: 'destination',
        leg: this.leg(actor, now, this.resolve(action.destination, actor.ship.id, actor.ship.kind)),
        action
      };
    const hop = this.routes.find(systemId, action.destination.systemId)?.hops[0];
    if (!hop) return { kind: 'awaiting-route', systemId, retryAt: now + 3, action };
    const gate = this.catalog.systems[systemId].gates.find(
      /** Resolve the graph hop's committed physical departure gate. */
      (g) => g.id === hop.gateId
    )!;
    return {
      kind: 'flight',
      systemId,
      stage: 'egress',
      gateId: hop.gateId,
      connectionId: hop.connectionId,
      leg: this.leg(actor, now, gate.position),
      action
    };
  }

  /**
   * Advance the actor's shared motion state and emit jump announcements, reporting task
   * completion back to its job policy.
   */
  advance(actor: TrafficActor, now: number, active: boolean): boolean {
    const m = actor.motion;
    switch (m.kind) {
      case 'awaiting-route':
        if (now >= m.retryAt) actor.motion = this.start(actor, m.action, now);
        return false;
      case 'waiting':
        return now >= m.until;
      case 'flight': {
        let arrived = false;
        if (active)
          arrived =
            distance(actor.ship.position, m.leg.to) < 12 &&
            Math.hypot(actor.ship.velocity.x, actor.ship.velocity.y) < 12;
        else {
          const l = m.leg,
            t = Math.min(1, Math.max(0, (now - l.startedAt) / (l.arriveAt - l.startedAt))),
            seconds = l.arriveAt - l.startedAt;
          actor.ship.position = {
            x: l.from.x + (l.to.x - l.from.x) * t,
            y: l.from.y + (l.to.y - l.from.y) * t,
            z: 0
          };
          actor.ship.velocity =
            t < 1
              ? { x: (l.to.x - l.from.x) / seconds, y: (l.to.y - l.from.y) / seconds, z: 0 }
              : { x: 0, y: 0, z: 0 };
          actor.ship.heading = Math.atan2(l.to.y - l.from.y, l.to.x - l.from.x);
          arrived = t >= 1;
        }
        if (!arrived) return false;
        actor.ship.velocity = { x: 0, y: 0, z: 0 };
        if (m.stage === 'destination') return true;
        const gate = this.catalog.systems[m.systemId].gates.find(
            /** Resolve the gate recorded in the actor's active exit leg. */
            (g) => g.id === m.gateId
          )!,
          link = gate.connections.find(
            /** Resolve the exact outgoing connection committed by that exit leg. */
            (c) => c.id === m.connectionId
          )!;
        const hop = this.routes.connection(m.systemId, link.id)!;
        if (!this.routes.access(hop).allowed) {
          actor.motion = this.start(actor, m.action, now);
          return false;
        }
        actor.motion = {
          kind: 'charging',
          systemId: m.systemId,
          gateId: gate.id,
          connectionId: link.id,
          until: now + 3,
          action: m.action
        };
        this.emit(actor, now, {
          topic: 'navigation.charging',
          values: {
            destination: this.catalog.systems[link.systemId].name,
            finalDestination: destinationName(m.action.destination, this.catalog)
          }
        });
        return false;
      }
      case 'charging': {
        if (now < m.until) return false;
        const gate = this.catalog.systems[m.systemId].gates.find(
            /** Resolve the departure gate while the drive is charging. */
            (g) => g.id === m.gateId
          )!,
          link = gate.connections.find(
            /** Resolve the charged connection before entering hyperspace. */
            (c) => c.id === m.connectionId
          )!;
        if (!this.routes.access(this.routes.connection(m.systemId, link.id)!).allowed) {
          actor.motion = this.start(actor, m.action, now);
          return false;
        }
        actor.motion = {
          kind: 'transit',
          systemId: null,
          fromSystemId: m.systemId,
          arrivalSystemId: link.systemId,
          arrivalGateId: link.gateId,
          until: now + jumpTravelSeconds,
          action: m.action
        };
        return false;
      }
      case 'transit': {
        if (now < m.until) return false;
        const gate = this.catalog.systems[m.arrivalSystemId].gates.find(
          /** Resolve the destination gate used to materialize the actor after transit. */
          (g) => g.id === m.arrivalGateId
        )!;
        actor.ship.position = { ...gate.position };
        actor.ship.velocity = { x: 0, y: 0, z: 0 };
        actor.motion = {
          kind: 'waiting',
          systemId: m.arrivalSystemId,
          until: now,
          action: { kind: 'wait', duration: 1, activity: 'Resolving onward route' }
        };
        actor.motion = this.start(actor, m.action, now);
        this.emit(actor, now, {
          topic:
            m.arrivalSystemId === m.action.destination.systemId
              ? 'navigation.arrival'
              : 'navigation.transfer',
          values: {
            destination: destinationName(m.action.destination, this.catalog),
            system: this.catalog.systems[m.arrivalSystemId].name
          }
        });
        return false;
      }
      default:
        return false;
    }
  }
  /**
   * Suspend local travel or waiting after combat or engine loss, preserving the task and its
   * remaining timing information.
   */
  interrupt(actor: TrafficActor, kind: 'interrupted' | 'disabled', now: number) {
    const m = actor.motion;
    if (m.kind === 'transit' || m.kind === 'captured' || m.kind === 'destroyed') return;
    if (m.kind === 'disabled' || m.kind === 'interrupted') {
      actor.motion = { ...m, kind };
      return;
    }
    actor.motion = { kind, systemId: m.systemId, resume: m, since: now };
  }
  /**
   * Restart an interrupted task from the actor's current physical state rather than teleport
   * it to its former schedule.
   */
  resume(actor: TrafficActor, now: number) {
    const m = actor.motion;
    if (m.kind !== 'interrupted' && m.kind !== 'disabled') return;
    const next: LocalMotion = m.resume;
    if (next.kind === 'flight') actor.motion = { ...next, leg: this.leg(actor, now, next.leg.to) };
    else if (next.kind === 'awaiting-route') actor.motion = { ...next, retryAt: now };
    else actor.motion = { ...next, until: next.until + now - m.since };
  }
  /**
   * Rebase a local flight leg when physical simulation ends so background travel starts at
   * the actual handoff position.
   */
  leave(actor: TrafficActor, now: number) {
    const m = actor.motion;
    if (m.kind === 'flight') actor.motion = { ...m, leg: this.leg(actor, now, m.leg.to) };
  }
}
