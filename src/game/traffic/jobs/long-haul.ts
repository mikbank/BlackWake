import type { ContentCatalog } from '../../../content/catalog';
import type { JobPolicy, JobStep, Port, Destination } from '../model';
import { record, integer, number, port, portName } from '../validation';
import {
  chooseDestination,
  marketPorts,
  readDestinationMemory,
  type DestinationMemory
} from '../destinations';
import { freightMarket, freightGoods, loadFreight, freightManifest } from './freight-cargo';
export type LongHaulConfig = {
  home: Port;
  quantity: number;
  loadingSeconds: number;
  unloadingSeconds: number;
  minHops: number;
};
export type LongHaulState = DestinationMemory & {
  origin: Port;
  destination: Port | null;
  next: 'load' | 'depart' | 'dock' | 'finish';
};
/** Validate a port used by a commercial roaming job. */
function commercialPort(raw: unknown, catalog: ContentCatalog) {
  const p = port(raw, catalog);
  freightMarket(catalog, p);
  return p;
}
export const longHaulPolicy: JobPolicy<LongHaulConfig, LongHaulState> = {
  kind: 'long-haul',
  /** Validate a home loading port and bounded commercial settings without fixing future destinations. */
  readConfig(raw, catalog) {
    const r = record(raw);
    return {
      home: commercialPort(r.home, catalog),
      quantity: integer(r.quantity ?? 12, 1, 60),
      loadingSeconds: number(r.loadingSeconds ?? 5, 0.1, 120),
      unloadingSeconds: number(r.unloadingSeconds ?? 6, 0.1, 120),
      minHops: integer(r.minHops ?? 2, 1, 32)
    };
  },
  /** Restore committed delivery endpoints and decision memory without drawing a new destination. */
  readState(raw, _config, catalog) {
    const r = record(raw);
    if (!['load', 'depart', 'dock', 'finish'].includes(String(r.next)))
      throw Error('Invalid long-haul phase.');
    const origin = commercialPort(r.origin, catalog),
      destination = r.destination === null ? null : commercialPort(r.destination, catalog);
    if (
      (r.next !== 'load' && !destination) ||
      (destination && origin.systemId === destination.systemId)
    )
      throw Error('Invalid long-haul endpoints.');
    return {
      ...readDestinationMemory(r, catalog),
      origin,
      destination,
      next: r.next as LongHaulState['next']
    };
  },
  /** Start a persistent hauler at its home port, ready to plan its first outbound shipment. */
  create(ctx, c) {
    if (c.home.systemId !== ctx.homeSystemId)
      throw Error('Long-haul home must match spawn system.');
    return {
      origin: { ...c.home },
      destination: null,
      next: 'load',
      decision: 0,
      recentSystems: [ctx.homeSystemId]
    };
  },
  /** Choose only between deliveries; retain the selected destination and cargo through every intervening system. */
  next(ctx, c, s): JobStep<LongHaulState> {
    if (s.next === 'finish') {
      ctx.ship.cargo = {};
      const result = this.next(ctx, c, {
        ...s,
        origin: s.destination!,
        destination: null,
        next: 'load'
      });
      return {
        ...result,
        completedJourney: true,
        announcement: { topic: 'freight.complete', values: {} }
      };
    }
    if (s.next === 'load') {
      let next = s;
      if (!s.destination) {
        const candidates = marketPorts(ctx.catalog).filter(
          /** Roaming freight always crosses to another system. */ (p) =>
            p.systemId !== ctx.systemId
        );
        const trade = candidates.filter(
          /** Prefer a destination that can actually accept this origin's exports. */ (p) =>
            freightGoods(ctx.catalog, s.origin, p).length > 0
        );
        /** Convert real markets into the navigation contract shared by every traffic job. */
        const destinations = (ports: Port[]): Destination[] =>
          ports.map(
            /** Preserve each market's exact station identity. */ (p) => ({ kind: 'station', ...p })
          );
        // A compatible market may be inaccessible. Reposition to another open port rather
        // than waiting forever for a trade that cannot currently be reached.
        const choice =
          chooseDestination(ctx, s, destinations(trade), c.minHops) ??
          chooseDestination(ctx, s, destinations(candidates), c.minHops);
        if (!choice)
          return {
            state: s,
            action: { kind: 'wait', duration: 5, activity: 'Waiting for an open delivery route' }
          };
        const target = choice.destination as Extract<Destination, { kind: 'station' }>;
        next = {
          ...s,
          decision: choice.decision,
          recentSystems: choice.recentSystems,
          destination: { systemId: target.systemId, stationId: target.stationId }
        };
      }
      return {
        state: { ...next, next: 'depart' },
        action: { kind: 'wait', duration: c.loadingSeconds, activity: 'Loading long-haul cargo' }
      };
    }
    const target = s.destination!,
      name = portName(target, ctx.catalog);
    if (s.next === 'dock')
      return {
        state: { ...s, next: 'finish' },
        action: {
          kind: 'wait',
          duration: c.unloadingSeconds,
          activity: 'Unloading long-haul cargo'
        },
        announcement: { topic: 'freight.dock', values: { destination: name } }
      };
    loadFreight(ctx.ship, ctx.catalog, s.origin, target, c.quantity);
    return {
      state: { ...s, next: 'dock' },
      action: {
        kind: 'travel',
        destination: { kind: 'station', ...target },
        activity: `Long-haul delivery to ${name}`
      },
      announcement: {
        topic: 'freight.depart',
        values: { destination: name, cargo: freightManifest(ctx.ship, ctx.catalog, 'empty hold') }
      }
    };
  },
  /** Expose the committed delivery goal and actual inventory rather than a decorative route description. */
  describe(ctx, _c, s) {
    return {
      title: 'Long-haul freighter',
      purpose: s.destination
        ? `Long-haul delivery to ${portName(s.destination, ctx.catalog)}`
        : 'Planning the next long-haul delivery',
      manifest: freightManifest(ctx.ship, ctx.catalog)
    };
  }
};
