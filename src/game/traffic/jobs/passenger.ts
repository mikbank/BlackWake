import type { JobStep, JobPolicy, Port } from '../model';
import { record, integer, number, ports, portName } from '../validation';
type Config = {
  route: [Port, Port];
  passengers: number;
  boardingSeconds: number;
  layoverSeconds: number;
};
type State = { origin: 0 | 1; next: 'board' | 'depart' | 'disembark' | 'finish'; aboard: number };
export const passengerPolicy: JobPolicy<Config, State> = {
  kind: 'passenger',
  combatPosture: 'evade',
  /** Validate a two-port passenger service, passenger count and boarding duration. */
  readConfig(raw, catalog) {
    const r = record(raw);
    return {
      route: ports(r.route, catalog),
      passengers: integer(r.passengers ?? 24, 1, 500),
      boardingSeconds: number(r.boardingSeconds ?? 8, 0.1, 120),
      layoverSeconds: number(r.layoverSeconds ?? 8, 0.1, 120)
    };
  },
  /** Validate the saved service direction, next stage and onboard passenger count. */
  readState(raw, c) {
    const r = record(raw);
    if (!['board', 'depart', 'disembark', 'finish'].includes(String(r.next)))
      throw Error('Invalid passenger stage.');
    return {
      origin: integer(r.origin, 0, 1) as 0 | 1,
      next: r.next as State['next'],
      aboard: integer(r.aboard, 0, c.passengers)
    };
  },
  /** Initialize a passenger service at its first stop with no passengers yet aboard. */
  create() {
    return { origin: 0, next: 'board', aboard: 0 };
  },
  /**
   * Advance boarding, departure and docking, updating passenger state and announcing facts
   * through shared travel/wait tasks.
   */
  next(ctx, c, s): JobStep<State> {
    if (s.next === 'finish') {
      const step = this.next(ctx, c, { origin: s.origin === 0 ? 1 : 0, next: 'board', aboard: 0 });
      return { ...step, completedJourney: true };
    }
    const to = c.route[s.origin === 0 ? 1 : 0],
      name = portName(to, ctx.catalog);
    if (s.next === 'board')
      return {
        state: { ...s, next: 'depart', aboard: 0 },
        action: { kind: 'wait', duration: c.boardingSeconds, activity: 'Boarding passengers' },
        announcement: { topic: 'passenger.board', values: { destination: name } }
      };
    if (s.next === 'depart')
      return {
        state: { ...s, next: 'disembark', aboard: c.passengers },
        action: {
          kind: 'travel',
          destination: { kind: 'station', ...to },
          activity: `Passenger service to ${name}`
        },
        announcement: {
          topic: 'passenger.depart',
          values: { destination: name, passengers: c.passengers }
        }
      };
    return {
      state: { ...s, next: 'finish', aboard: s.aboard },
      action: { kind: 'wait', duration: c.layoverSeconds, activity: 'Disembarking passengers' },
      announcement: { topic: 'passenger.dock', values: { destination: name } }
    };
  },
  /** Describe the scheduled passenger service and actual onboard count for the contact UI. */
  describe(ctx, c, s) {
    return {
      title: 'Public transport',
      purpose: `Scheduled service to ${portName(c.route[s.origin === 0 ? 1 : 0], ctx.catalog)}`,
      manifest: `${s.aboard} passengers aboard`
    };
  }
};
