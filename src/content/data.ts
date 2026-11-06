import { defaultEnvironmentProfile } from './environments';
import { ContentCatalog } from './catalog';
import type { SystemDefinition } from './schema';
import { createServices } from '../game/services';
import { createTrafficJobs } from '../game/traffic/jobs';
export type UniverseDefinition = { schemaVersion: 1; systemIds: string[] } & Pick<
  ContentCatalog,
  | 'spatialVersion'
  | 'defaultEnvironmentId'
  | 'environmentProfiles'
  | 'defaultCultureId'
  | 'regions'
  | 'cultures'
  | 'shipDesigns'
  | 'radioProfiles'
  | 'themes'
  | 'stationSizes'
  | 'markets'
  | 'commodities'
>;
export type UniverseBundle = { definition: UniverseDefinition; systems: SystemDefinition[] };
/**
 * Narrow untrusted input to a non-array object before reading its fields; TypeScript types
 * alone do not validate JSON.
 */
export function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
/**
 * Validate an external content key and return it as a string, or throw before any file
 * access.
 */
export function contentId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]*$/.test(raw))
    throw Error(`Invalid content ID: ${String(raw)}`);
  return raw;
}
/**
 * Validate and clone the shared manifest, supplying an empty region registry for older
 * content.
 */
export function universeDefinition(raw: unknown): UniverseDefinition {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.systemIds) ||
    !raw.systemIds.length ||
    raw.systemIds.length > 4096
  )
    throw Error('Invalid universe manifest.');
  if (raw.spatialVersion !== undefined && ![0, 1].includes(Number(raw.spatialVersion)))
    throw Error('Invalid spatial version.');
  const ids = raw.systemIds.map(contentId);
  if (new Set(ids).size !== ids.length) throw Error('Duplicate system manifest entry.');
  for (const key of [
    'cultures',
    'shipDesigns',
    'radioProfiles',
    'themes',
    'stationSizes',
    'markets',
    'commodities'
  ])
    if (!isRecord(raw[key])) throw Error(`Missing content table: ${key}`);
  contentId(raw.defaultCultureId);
  if (raw.regions !== undefined && !isRecord(raw.regions)) throw Error('Invalid regions table.');
  if (raw.environmentProfiles !== undefined && !isRecord(raw.environmentProfiles))
    throw Error('Invalid environment table.');
  if (raw.defaultEnvironmentId !== undefined) contentId(raw.defaultEnvironmentId);
  return structuredClone({
    ...raw,
    regions: raw.regions ?? {},
    spatialVersion: raw.spatialVersion ?? 0,
    defaultEnvironmentId: raw.defaultEnvironmentId ?? defaultEnvironmentProfile.id,
    environmentProfiles: raw.environmentProfiles ?? {
      [defaultEnvironmentProfile.id]: defaultEnvironmentProfile
    }
  }) as UniverseDefinition;
}
/**
 * Build the runtime catalog from JSON and validate content, services, NPC policies and
 * population limits together.
 */
export function catalogFromData(raw: unknown, systems: unknown[]): ContentCatalog {
  const data = universeDefinition(raw);
  if (systems.length !== data.systemIds.length)
    throw Error('System manifest and import index differ. Run universe:sync.');
  const catalog = new ContentCatalog();
  for (const key of [
    'spatialVersion',
    'defaultEnvironmentId',
    'environmentProfiles',
    'defaultCultureId',
    'regions',
    'cultures',
    'shipDesigns',
    'radioProfiles',
    'themes',
    'stationSizes',
    'markets',
    'commodities'
  ] as const)
    Object.assign(catalog, { [key]: structuredClone(data[key]) });
  for (let i = 0; i < systems.length; i++) {
    const system = systems[i];
    if (
      !isRecord(system) ||
      system.id !== data.systemIds[i] ||
      typeof system.name !== 'string' ||
      !system.name.length ||
      !isRecord(system.chart) ||
      ![system.chart.x, system.chart.y].every(Number.isFinite) ||
      !['stations', 'landmarks', 'gates', 'traffic'].every(
        /** Require each system's object collections to be arrays before decoding them. */
        (k) => Array.isArray(system[k])
      )
    )
      throw Error(`Invalid system file: ${data.systemIds[i]}`);
    catalog.addSystem(system as unknown as SystemDefinition);
  }
  catalog.validate();
  createServices().validate(catalog);
  createTrafficJobs().validateCatalog(catalog);
  const population = Object.values(catalog.systems).reduce(
    /** Count authored spawns against the current persistent-NPC budget. */
    (n, s) => n + s.traffic.length,
    0
  );
  if (population > 256)
    throw Error('Authored traffic exceeds the current 256-actor budget. Use fewer NPC spawns.');
  return catalog;
}
