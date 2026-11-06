import { stationBerth } from '../../game/station-approach';
import type { ContentCatalog } from '../catalog';
import type { SystemDefinition, TrafficSpawn } from '../schema';
import { RouteResolver } from '../routes';
import { makeShip } from '../ship-factory';
import { definitions, type Ship } from '../../core/model';
import { randomStream, round } from './random';
export type TrafficTemplate = {
  kind: string;
  shipKind: Ship['kind'];
  owner: string;
  factionId: string;
  count: number;
  livery?: string;
  cultureId?: string;
  designId?: string;
};
export type TrafficGenerationContext = {
  system: SystemDefinition;
  catalog: ContentCatalog;
  template: TrafficTemplate;
  index: number;
};
/**
 * Authoring-time callback that turns one template instance into a stable hull and runtime
 * job configuration.
 */
type Factory = (ctx: TrafficGenerationContext) => TrafficSpawn;
/**
 * Create a stable NPC hull near a local station, applying authored faction, paint and
 * optional design overrides.
 */
function base(
  ctx: TrafficGenerationContext,
  station = ctx.system.stations[ctx.index % ctx.system.stations.length]
) {
  const { system, template, index } = ctx;
  if (!station) throw Error('Generated traffic needs a local station.');
  const ship = makeShip(
    `${system.id}-${template.kind}-${index + 1}`,
    `${system.name} ${template.kind === 'freight' ? 'Runner' : template.kind === 'long-haul' ? 'Hauler' : template.kind === 'passenger' ? 'Connector' : template.kind === 'patrol' ? 'Marshal' : 'Voyager'} ${index + 1}`,
    template.shipKind,
    template.owner,
    station.position.x,
    station.position.y
  );
  ship.position = stationBerth(
    station,
    ctx.catalog.stationSizes[station.size],
    ship,
    system.radius
  );
  ship.factionId = template.factionId;
  if (template.livery) ship.livery = template.livery;
  if (template.designId) ship.designId = template.designId;
  if (template.kind === 'liner') {
    let space = definitions[ship.kind].cargoCapacity;
    for (const good of Object.values(ctx.catalog.commodities)) {
      if (good.category !== 'Luxury') continue;
      const quantity = Math.min(3, Math.floor(space / good.unitSize));
      if (quantity > 0) {
        ship.cargo[good.id] = quantity;
        space -= quantity * good.unitSize;
      }
    }
  }
  return ship;
}
/**
 * Choose a reachable trading partner, preferring distant markets so generated freight
 * exercises multi-hop travel.
 */
function commercialRoute(ctx: TrafficGenerationContext) {
  const station = ctx.system.stations.find(
    /** Find a local station capable of loading or unloading commercial traffic. */
    (s) =>
      s.services.some(
        /** Recognize a commodity market among a station's service capabilities. */
        (v) => v.kind === 'market'
      )
  );
  if (!station) throw Error('Commercial traffic needs a local market.');
  const routes = new RouteResolver(ctx.catalog);
  const candidates = Object.values(ctx.catalog.systems)
    .flatMap(
      /**
       * Collect candidate market ports across systems, retaining their graph distance from the
       * origin.
       */
      (s) =>
        s.stations
          .filter(
            /** Include only stations with a commodity market. */
            (p) =>
              p.services.some(
                /** Recognize a market capability on this candidate station. */
                (v) => v.kind === 'market'
              )
          )
          .map(
            /** Describe a candidate endpoint with its owning system and outbound hop count. */
            (p) => ({
              systemId: s.id,
              stationId: p.id,
              hops: routes.find(ctx.system.id, s.id)?.hops.length
            })
          )
    )
    .filter(
      /**
       * Require another port with valid outbound and return routes for a repeatable commercial
       * service.
       */
      (p) =>
        p.stationId !== station.id && p.hops !== undefined && routes.find(p.systemId, ctx.system.id)
    );
  candidates.sort(
    /** Prefer the most distant reachable port, with a stable station-ID tie break. */
    (a, b) => b.hops! - a.hops! || a.stationId.localeCompare(b.stationId)
  );
  const target = candidates[0];
  if (!target)
    throw Error('Generated commercial traffic needs a reachable partner port. Add a connection.');
  return [
    { systemId: ctx.system.id, stationId: station.id },
    { systemId: target.systemId, stationId: target.stationId }
  ];
}
/** Describe a named local waypoint for generated sightseeing or patrol jobs. */
const point = (system: SystemDefinition, x: number, y: number, label: string) => ({
  kind: 'point',
  systemId: system.id,
  position: { x: round(x), y: round(y), z: 0 },
  label
});
/** Authoring-only extension registry. Runtime job policies remain independent of generation. */
export const trafficFactories = new Map<string, Factory>([
  [
    'freight',
    /** Generate a freight hull and its validated two-port delivery configuration. */
    (ctx) => ({
      ship: base(ctx),
      job: {
        kind: 'freight',
        config: {
          route: commercialRoute(ctx),
          quantity: 12,
          loadingSeconds: 5,
          unloadingSeconds: 6
        }
      }
    })
  ],
  [
    'passenger',
    /** Generate a commuter hull and its passenger-service route and timing configuration. */
    (ctx) => ({
      ship: base(ctx),
      job: {
        kind: 'passenger',
        config: {
          route: commercialRoute(ctx),
          passengers: 24,
          boardingSeconds: 8,
          layoverSeconds: 8
        }
      }
    })
  ],
  [
    'liner',
    /** Generate a roaming cruise with a real home port and destinations chosen at future stops. */
    (ctx) => ({
      ship: base(ctx),
      job: {
        kind: 'liner',
        config: {
          routing: 'roaming',
          home: { systemId: ctx.system.id, stationId: ctx.system.stations[0].id },
          passengers: 80,
          stopSeconds: 9,
          tourLength: 4,
          minHops: 1
        }
      }
    })
  ],
  [
    'long-haul',
    /** Generate one roaming freighter without fixing a random route during content generation. */
    (ctx) => {
      const station = ctx.system.stations.find(
        /** Require an actual loading market at the ship's initial port. */ (station) =>
          station.services.some(
            /** Identify a commercial service independently of infrastructure visuals. */ (
              service
            ) => service.kind === 'market'
          )
      );
      if (!station) throw Error('Long-haul traffic needs a local market.');
      return {
        ship: base(ctx, station),
        job: {
          kind: 'long-haul',
          config: {
            home: { systemId: ctx.system.id, stationId: station.id },
            quantity: 12,
            loadingSeconds: 5,
            unloadingSeconds: 6,
            minHops: 2
          }
        }
      };
    }
  ],
  [
    'patrol',
    /**
     * Generate a police hull and a local security circuit without coupling it to runtime job
     * execution.
     */
    (ctx) => ({
      ship: base(ctx),
      job: {
        kind: 'patrol',
        config: {
          holdSeconds: 5,
          responseRange: 5500,
          waypoints: [
            { kind: 'station', systemId: ctx.system.id, stationId: ctx.system.stations[0].id },
            point(
              ctx.system,
              ctx.system.gates[0]?.position.x ?? -ctx.system.radius * 0.3125,
              ctx.system.gates[0]?.position.y ?? -ctx.system.radius * 0.125,
              'Jump corridor'
            )
          ]
        }
      }
    })
  ]
]);
/**
 * Expand registered traffic templates into unique spawns and validate each job
 * configuration against the completed universe.
 */
export function generateTraffic(
  system: SystemDefinition,
  catalog: ContentCatalog,
  templates: TrafficTemplate[]
) {
  const spawns: TrafficSpawn[] = [],
    offsets = new Map<string, number>();
  for (const template of templates) {
    const factory = trafficFactories.get(template.kind);
    if (!factory) throw Error(`Missing traffic-generation factory: ${template.kind}`);
    for (let index = 0; index < template.count; index++) {
      const spawn = factory({
        system,
        catalog,
        template,
        index: index + (offsets.get(template.kind) ?? 0)
      });
      if (template.cultureId) spawn.cultureId = template.cultureId;
      spawns.push(spawn);
    }
    offsets.set(template.kind, (offsets.get(template.kind) ?? 0) + template.count);
  }
  return spawns;
}
