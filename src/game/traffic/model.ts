import type { RouteResolver } from '../../content/routes';
import type { CombatPosture } from '../../core/ai';
import type { DefenceState, Input, Ship, Vec3 } from '../../core/model';
import type { ContentCatalog } from '../../content/catalog';

export type Port = { systemId: string; stationId: string };
export type Destination =
  | ({ kind: 'station' } & Port)
  | { kind: 'point'; systemId: string; position: Vec3; label: string };
export type Announcement = {
  topic: string;
  values: Record<string, string | number>;
  urgent?: boolean;
};
export type TrafficEvent = Announcement & {
  id: string;
  actorId: string;
  systemId: string;
  at: number;
};
export type JourneyLeg = { from: Vec3; to: Vec3; startedAt: number; arriveAt: number };
/**
 * Policy intent expressed as travel or wait data, decoupled from how the active or
 * background system executes it.
 */
export type TrafficAction =
  | { kind: 'travel'; destination: Destination; activity: string }
  | { kind: 'wait'; duration: number; activity: string };
export type TravelAction = Extract<TrafficAction, { kind: 'travel' }>;
/** Each case contains exactly the data its executor requires. No nullable journey leg. */
export type RunningMotion =
  | {
      kind: 'waiting';
      systemId: string;
      until: number;
      action: Extract<TrafficAction, { kind: 'wait' }>;
    }
  | ({ kind: 'flight'; systemId: string; leg: JourneyLeg; action: TravelAction } & (
      | { stage: 'destination' }
      | { stage: 'egress'; gateId: string; connectionId: string }
    ))
  | { kind: 'awaiting-route'; systemId: string; retryAt: number; action: TravelAction }
  | {
      kind: 'charging';
      systemId: string;
      gateId: string;
      connectionId: string;
      until: number;
      action: TravelAction;
    }
  | {
      kind: 'transit';
      fromSystemId: string;
      systemId: null;
      arrivalSystemId: string;
      arrivalGateId: string;
      until: number;
      action: TravelAction;
    };
export type LocalMotion = Exclude<RunningMotion, { kind: 'transit' }>;
type SuspendedMotion = {
  [K in 'interrupted' | 'disabled']: {
    kind: K;
    systemId: string;
    resume: LocalMotion;
    since: number;
  };
}['interrupted' | 'disabled'];
type RetiredMotion = { [K in 'captured' | 'destroyed']: { kind: K; systemId: string | null } }[
  | 'captured'
  | 'destroyed'];
/**
 * Serializable lifecycle alternatives distinguished by kind; each case carries only the
 * fields valid for that motion state.
 */
export type TrafficMotion = RunningMotion | SuspendedMotion | RetiredMotion;
/**
 * Serialized policy identity plus its config and progress; concrete generic types are
 * recovered inside the registered policy closure.
 */
export type JobRecord<C = unknown, S = unknown> = { kind: string; config: C; state: S };
/**
 * Authoritative persistent NPC record. Its ship is shared with the active physics world
 * rather than copied into another competing owner.
 */
export type TrafficActor = {
  cultureId: string;
  ship: Ship;
  homeSystemId: string;
  job: JobRecord;
  motion: TrafficMotion;
  hostileTo: string[];
  sequence: number;
  journeys: number;
  defence?: DefenceState;
};
/**
 * Identify captured or destroyed actors that remain in history but must never respawn as
 * active NPCs.
 */
export const isRetired = (actor: TrafficActor) =>
  actor.motion.kind === 'captured' || actor.motion.kind === 'destroyed';
/**
 * Read an actor's current system, returning null during hyperspace or for a retired record
 * without a location.
 */
export const actorSystemId = (actor: TrafficActor) => actor.motion.systemId;
export type JobContext = {
  /** Share current connection-access policy with destination selection; older custom contexts may omit it. */
  routes?: RouteResolver;
  catalog: ContentCatalog;
  ship: Ship;
  homeSystemId: string;
  systemId: string;
  now: number;
  ships: readonly Ship[];
  active: boolean;
};
export type JobStep<S> = {
  state: S;
  action: TrafficAction;
  announcement?: Announcement;
  completedJourney?: boolean;
};
export type JobDescription = { title: string; purpose: string; manifest: string };
export type Aggression = { attacker: Ship; victim: Ship; systemId: string };
export type JobReaction<S> = { state: S; hostileTo?: string[]; announcement?: Announcement };
/**
 * Generic NPC-purpose contract: C is validated configuration and S is serializable
 * progress. Policies choose intent; shared navigation owns travel.
 */
export interface JobPolicy<C, S> {
  kind: string;
  combatPosture?: CombatPosture;
  /**
   * Validate unknown authored or saved configuration and return this policy's concrete
   * config type.
   */
  readConfig(raw: unknown, catalog: ContentCatalog): C;
  /** Validate unknown saved progress against the already validated policy configuration. */
  readState(raw: unknown, config: C, catalog: ContentCatalog): S;
  /**
   * Build initial serializable progress for a new actor without taking ownership of shared
   * navigation.
   */
  create(ctx: JobContext, config: C): S;
  /**
   * Return the next policy state and generic travel/wait action; the shared executor
   * performs it.
   */
  next(ctx: JobContext, config: C, state: S): JobStep<S>;
  /**
   * Return role, purpose and manifest text derived from real policy state for the generic
   * contact UI.
   */
  describe(ctx: JobContext, config: C, state: S): JobDescription;
  /**
   * Optionally override physical movement for a policy-specific response such as a temporary
   * police pursuit.
   */
  order?(ctx: JobContext, config: C, state: S): Input | undefined;
  /**
   * Optionally react to a witnessed attack with new state, hostility targets and a semantic
   * announcement.
   */
  onAggression?(
    ctx: JobContext,
    config: C,
    state: S,
    event: Aggression
  ): JobReaction<S> | undefined;
}
