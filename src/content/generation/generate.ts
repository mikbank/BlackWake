import {
  catalogFromData,
  contentId,
  isRecord,
  universeDefinition,
  type UniverseBundle
} from '../data';
import type { StationService, SystemDefinition, MarketProfile } from '../schema';
import type { TrafficTemplate } from './traffic';
import { generateTraffic } from './traffic';
import { connectSystems } from './connections';
import { randomStream, whole, round } from './random';
import { distance } from '../../core/model';
export const GENERATOR_VERSION = 2;
type Range = [number, number];
/** Authoring conveniences resolve to one numeric radius; runtime systems never carry a second size authority. */
export const systemSizeRanges = {
  small: [6000, 9000],
  medium: [10000, 16000],
  large: [20000, 30000]
} as const;
export type SystemPreset = {
  id: string;
  cultureId: string;
  themeId: string;
  environmentIds?: string[];
  radius: Range;
  landmark: { kind: string; radius: Range };
  stations: {
    count: Range;
    sizes: string[];
    services: StationService[];
    goods: Record<
      string,
      {
        price: Range;
        stock: Range;
        bidPrice?: Range;
        availability?: number;
        buys?: boolean;
        sells?: boolean;
      }
    >;
  };
  traffic: TrafficTemplate[];
};
export type SystemSpec = {
  environmentId?: string;
  size?: keyof typeof systemSizeRanges;
  radius?: number;
  regionId?: string;
  cultureId?: string;
  id: string;
  name: string;
  seed: number;
  preset: string;
  chart: { x: number; y: number };
};
export type Blueprint = {
  schemaVersion: 1;
  systems: SystemSpec[];
  connections: { from: string; to: string }[];
};
/** Decode an inclusive integer range and reject out-of-bounds authoring settings. */
function range(raw: unknown, min: number, max: number): Range {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    raw.some(
      /** Reject non-integer or out-of-range ends of a generation interval. */
      (n) => !Number.isSafeInteger(n) || n < min || n > max
    ) ||
    raw[0] > raw[1]
  )
    throw Error('Invalid preset range.');
  return raw as Range;
}
/**
 * Validate reusable layout, station, market and traffic settings before generating any
 * systems.
 */
export function readPresets(raw: unknown): Record<string, SystemPreset> {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.presets))
    throw Error('Invalid presets file.');
  const result: Record<string, SystemPreset> = {};
  for (const [id, value] of Object.entries(raw.presets)) {
    contentId(id);
    if (
      !isRecord(value) ||
      value.id !== id ||
      !isRecord(value.landmark) ||
      !isRecord(value.stations) ||
      !Array.isArray(value.traffic)
    )
      throw Error('Invalid system preset.');
    const r = value as unknown as SystemPreset;
    contentId(r.cultureId);
    contentId(r.themeId);
    if (r.environmentIds !== undefined) {
      if (
        !Array.isArray(r.environmentIds) ||
        !r.environmentIds.length ||
        r.environmentIds.length > 64 ||
        new Set(r.environmentIds).size !== r.environmentIds.length
      )
        throw Error('Invalid environment profile pool.');
      for (const environmentId of r.environmentIds) contentId(environmentId);
    }
    range(r.radius, 1200, 40000);
    range(r.landmark.radius, 50, 2250);
    range(r.stations.count, 1, 8);
    if (
      !Array.isArray(r.stations.sizes) ||
      !r.stations.sizes.length ||
      !Array.isArray(r.stations.services) ||
      !isRecord(r.stations.goods) ||
      typeof r.landmark.kind !== 'string'
    )
      throw Error('Invalid station preset.');
    for (const g of Object.values(r.stations.goods)) {
      range(g.price, 1, 100000);
      range(g.stock, 0, 10000);
      if (g.bidPrice !== undefined) range(g.bidPrice, 1, 100000);
      if (
        g.availability !== undefined &&
        (!Number.isFinite(g.availability) || g.availability < 0 || g.availability > 1)
      )
        throw Error('Invalid market availability.');
      if (
        (g.buys !== undefined && typeof g.buys !== 'boolean') ||
        (g.sells !== undefined && typeof g.sells !== 'boolean')
      )
        throw Error('Invalid market trade direction.');
    }
    for (const t of r.traffic)
      if (
        !isRecord(t) ||
        !Number.isInteger(t.count) ||
        t.count < 0 ||
        t.count > 12 ||
        !['cutter', 'merchant'].includes(t.shipKind)
      )
        throw Error('Invalid traffic template.');
    result[id] = structuredClone(r);
  }
  return result;
}
/** Validate named system specifications and graph links without changing source content. */
export function readBlueprint(raw: unknown): Blueprint {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.systems) ||
    !Array.isArray(raw.connections) ||
    raw.systems.length > 1000
  )
    throw Error('Invalid expansion blueprint.');
  const ids = new Set<string>();
  for (const value of raw.systems) {
    if (
      !isRecord(value) ||
      !isRecord(value.chart) ||
      typeof value.name !== 'string' ||
      !value.name.length ||
      value.name.length > 60 ||
      !Number.isSafeInteger(value.seed) ||
      Number(value.seed) < 0 ||
      Number(value.seed) > 0xffffffff ||
      ![value.chart.x, value.chart.y].every(Number.isFinite)
    )
      throw Error('Invalid generated system specification.');
    const id = contentId(value.id);
    if (value.regionId !== undefined) contentId(value.regionId);
    if (value.cultureId !== undefined) contentId(value.cultureId);
    if (value.environmentId !== undefined) contentId(value.environmentId);
    if (
      value.size !== undefined &&
      (typeof value.size !== 'string' || !Object.hasOwn(systemSizeRanges, value.size))
    )
      throw Error('Unknown system size.');
    if (
      value.radius !== undefined &&
      (!Number.isSafeInteger(value.radius) ||
        Number(value.radius) < 1200 ||
        Number(value.radius) > 40000)
    )
      throw Error('System radius must be an integer from 1200 to 40000.');
    if (value.radius !== undefined && value.size !== undefined)
      throw Error('Choose a size preset or a numeric radius, not both.');
    contentId(value.preset);
    if (ids.has(id)) throw Error('Duplicate blueprint system.');
    ids.add(id);
  }
  for (const link of raw.connections) {
    if (!isRecord(link)) throw Error('Invalid blueprint connection.');
    contentId(link.from);
    contentId(link.to);
  }
  return structuredClone(raw) as Blueprint;
}
/**
 * Create one seeded system and its markets, resolving culture from explicit, region or
 * preset defaults.
 */
function generateSystem(spec: SystemSpec, preset: SystemPreset, bundle: UniverseBundle) {
  for (const id of spec.environmentId
    ? [spec.environmentId]
    : (preset.environmentIds ?? [bundle.definition.defaultEnvironmentId]))
    if (!Object.hasOwn(bundle.definition.environmentProfiles, id))
      throw Error(`Unknown environment profile: ${id}`);
  const random = randomStream(spec.seed, 'layout'),
    defaultRadius = whole(random, preset.radius),
    radius =
      spec.radius ??
      (spec.size
        ? whole(randomStream(spec.seed, 'system-size'), systemSizeRanges[spec.size])
        : defaultRadius),
    profiles = spec.environmentId
      ? [spec.environmentId]
      : (preset.environmentIds ?? [bundle.definition.defaultEnvironmentId]),
    environmentId =
      profiles[whole(randomStream(spec.seed, 'environment-profile'), [0, profiles.length - 1])],
    system: SystemDefinition = {
      id: spec.id,
      name: spec.name,
      cultureId:
        spec.cultureId ??
        (spec.regionId ? bundle.definition.regions[spec.regionId].cultureId : preset.cultureId),
      ...(spec.regionId ? { regionId: spec.regionId } : {}),
      themeId: preset.themeId,
      environmentId,
      seed: spec.seed,
      radius,
      chart: { ...spec.chart },
      generation: { generatorVersion: GENERATOR_VERSION, seed: spec.seed, presetId: preset.id },
      stations: [],
      landmarks: [],
      gates: [],
      traffic: []
    };
  const bodyRandom = randomStream(spec.seed, 'landmark:primary'),
    body = {
      id: `${spec.id}-primary`,
      name: spec.name,
      kind: preset.landmark.kind,
      position: { x: whole(bodyRandom, [-300, 300]), y: whole(bodyRandom, [-300, 300]), z: 0 },
      radius: Math.min(whole(bodyRandom, preset.landmark.radius), radius * 0.12)
    };
  system.landmarks.push(body);
  const count = whole(randomStream(spec.seed, 'station-count'), preset.stations.count);
  for (let i = 0; i < count; i++) {
    const id = `${spec.id}-station-${i + 1}`,
      r = randomStream(spec.seed, id),
      size = preset.stations.sizes[whole(r, [0, preset.stations.sizes.length - 1])];
    if (!bundle.definition.stationSizes[size]) throw Error(`Unknown station size: ${size}`);
    let position: { x: number; y: number; z: number } | undefined;
    for (let n = 0; n < 128; n++) {
      const angle = r() * Math.PI * 2,
        orbit = body.radius + Math.min(1100, radius * 0.25) + r() * radius * 0.18,
        p = {
          x: round(body.position.x + Math.cos(angle) * orbit),
          y: round(body.position.y + Math.sin(angle) * orbit),
          z: 0
        };
      if (
        Math.hypot(p.x, p.y) > radius * 0.65 ||
        system.stations.some(
          /** Require a candidate station position to remain separated from existing stations. */
          (s) => distance(s.position, p) < 1500
        )
      )
        continue;
      position = p;
      break;
    }
    if (!position) throw Error('Unable to place separated stations.');
    const marketId = `${id}-market`,
      goods: MarketProfile['goods'] = {};
    for (const [good, bands] of Object.entries(preset.stations.goods)) {
      if (randomStream(spec.seed, `${id}:market:${good}:available`)() >= (bands.availability ?? 1))
        continue;
      const quote = randomStream(spec.seed, `${id}:market:${good}`);
      const price = whole(quote, bands.price);
      goods[good] = {
        price,
        stock: whole(quote, bands.stock),
        ...(bands.bidPrice ? { bidPrice: Math.min(price, whole(quote, bands.bidPrice)) } : {}),
        ...(bands.buys !== undefined ? { buys: bands.buys } : {}),
        ...(bands.sells !== undefined ? { sells: bands.sells } : {})
      };
    }
    if (bundle.definition.markets[marketId]) throw Error('Generated market ID already exists.');
    bundle.definition.markets[marketId] = { id: marketId, goods };
    const services = structuredClone(preset.stations.services);
    for (const service of services)
      if (service.kind === 'market' && service.config.profileId === '$market')
        service.config.profileId = marketId;
    system.stations.push({
      id,
      name: count === 1 ? `${spec.name} Anchorage` : `${spec.name} Port ${i + 1}`,
      position,
      size,
      services
    });
  }
  return system;
}
/**
 * Expand a cloned content bundle, preserve existing systems, connect the graph and
 * validate generated traffic before writes.
 */
export function expandUniverse(
  source: UniverseBundle,
  input: unknown,
  presetData: unknown,
  { rejectExisting = false } = {}
) {
  const blueprint = readBlueprint(input),
    presets = readPresets(presetData),
    bundle = { ...structuredClone(source), definition: universeDefinition(source.definition) },
    created: string[] = [],
    retained: string[] = [],
    linked: string[] = [];
  for (const spec of blueprint.systems) {
    if (spec.regionId && !bundle.definition.regions[spec.regionId])
      throw Error(`Unknown region: ${spec.regionId}`);
    if (spec.cultureId && !bundle.definition.cultures[spec.cultureId])
      throw Error(`Unknown culture: ${spec.cultureId}`);
    if (
      bundle.systems.some(
        /** Detect an existing system so replay can preserve its authored content. */
        (s) => s.id === spec.id
      )
    ) {
      if (rejectExisting)
        throw Error(`System ${spec.id} already exists; existing systems are never regenerated.`);
      retained.push(spec.id);
      continue;
    }
    const preset = presets[spec.preset];
    if (!preset) throw Error(`Unknown preset: ${spec.preset}`);
    const system = generateSystem(spec, preset, bundle);
    bundle.systems.push(system);
    bundle.definition.systemIds.push(system.id);
    created.push(system.id);
  }
  for (const pair of blueprint.connections) {
    const a = bundle.systems.find(
        /** Resolve the first endpoint of the requested graph connection. */
        (s) => s.id === pair.from
      ),
      b = bundle.systems.find(
        /** Resolve the second endpoint of the requested graph connection. */
        (s) => s.id === pair.to
      );
    if (!a || !b) throw Error('Connection references a missing system.');
    if (connectSystems(a, b)) linked.push(`${a.id} ↔ ${b.id}`);
  }
  let catalog = catalogFromData(bundle.definition, bundle.systems);
  for (const spec of blueprint.systems)
    if (created.includes(spec.id)) {
      const system = bundle.systems.find(
        /** Locate the newly created system before generating its job-based traffic. */
        (s) => s.id === spec.id
      )!;
      system.traffic = generateTraffic(system, catalog, presets[spec.preset].traffic);
    }
  catalog = catalogFromData(bundle.definition, bundle.systems);
  return { bundle, created, retained, linked };
}
