import { freightMarket, loadFreight, freightManifest } from './freight-cargo';
import type { JobStep, JobPolicy, Port } from '../model';
import { record, integer, number, ports, portName } from '../validation';
type Config = {
  route: [Port, Port];
  quantity: number;
  loadingSeconds: number;
  unloadingSeconds: number;
};
type State = { origin: 0 | 1; next: 'load' | 'depart' | 'dock' | 'finish' };
export const freightPolicy: JobPolicy<Config, State> = {
  kind: 'freight',
  /**
   * Validate a two-port commercial route, load quantity and handling times, requiring a
   * market at each endpoint.
   */
  readConfig(raw, catalog) {
    const r = record(raw),
      route = ports(r.route, catalog);
    for (const p of route) freightMarket(catalog, p);
    return {
      route,
      quantity: integer(r.quantity ?? 12, 1, 60),
      loadingSeconds: number(r.loadingSeconds ?? 5, 0.1, 120),
      unloadingSeconds: number(r.unloadingSeconds ?? 6, 0.1, 120)
    };
  },
  /** Validate the saved route direction and next freight phase before restoring the policy. */
  readState(raw) {
    const r = record(raw);
    if (!['load', 'depart', 'dock', 'finish'].includes(String(r.next)))
      throw Error('Invalid freight stage.');
    return { origin: integer(r.origin, 0, 1) as 0 | 1, next: r.next as State['next'] };
  },
  /** Start the freighter at its first port with loading as its next decision. */
  create() {
    return { origin: 0, next: 'load' };
  },
  /**
   * Advance loading, delivery and unloading decisions, choosing cargo from price differences
   * while returning shared travel/wait tasks.
   */
  next(ctx, c, s): JobStep<State> {
    if (s.next === 'finish') {
      ctx.ship.cargo = {};
      const next = this.next(ctx, c, { origin: s.origin === 0 ? 1 : 0, next: 'load' });
      return {
        ...next,
        completedJourney: true,
        announcement: { topic: 'freight.complete', values: {} }
      };
    }
    if (s.next === 'load')
      return {
        state: { ...s, next: 'depart' },
        action: { kind: 'wait', duration: c.loadingSeconds, activity: 'Loading cargo' }
      };
    const to = c.route[s.origin === 0 ? 1 : 0],
      name = portName(to, ctx.catalog);
    if (s.next === 'dock')
      return {
        state: { ...s, next: 'finish' },
        action: { kind: 'wait', duration: c.unloadingSeconds, activity: 'Unloading cargo' },
        announcement: { topic: 'freight.dock', values: { destination: name } }
      };
    loadFreight(ctx.ship, ctx.catalog, c.route[s.origin], to, c.quantity);
    const cargo = freightManifest(ctx.ship, ctx.catalog, 'empty hold');
    return {
      state: { ...s, next: 'dock' },
      action: {
        kind: 'travel',
        destination: { kind: 'station', ...to },
        activity: `Delivering cargo to ${name}`
      },
      announcement: { topic: 'freight.depart', values: { destination: name, cargo } }
    };
  },
  /** Describe the freighter's real destination and current cargo for contact inspection. */
  describe(ctx, c, s) {
    return {
      title: 'Cargo freighter',
      purpose: `Delivery to ${portName(c.route[s.origin === 0 ? 1 : 0], ctx.catalog)}`,
      manifest: freightManifest(ctx.ship, ctx.catalog)
    };
  }
};
