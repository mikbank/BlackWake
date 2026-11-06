import { RouteResolver } from '../../content/routes';
import type { ContentCatalog } from '../../content/catalog';
import type { Destination, Port } from './model';
/** Require a non-array object before decoding an unknown policy or motion record. */
export function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Expected a record.');
  return raw as Record<string, unknown>;
}
/** Require a nonempty bounded string for a policy field or saved identifier. */
export function text(raw: unknown, max = 120): string {
  if (typeof raw !== 'string' || !raw.length || raw.length > max)
    throw Error('Invalid traffic text.');
  return raw;
}
/** Require a safe whole number within the supplied inclusive bounds. */
export function integer(raw: unknown, min = 0, max = 1_000_000) {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)
    throw Error('Invalid traffic count.');
  return raw;
}
/** Require a finite number within the supplied bounds for times, distances and coordinates. */
export function number(raw: unknown, min = 0, max = 1e12) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max)
    throw Error('Invalid traffic number.');
  return raw;
}
/** Validate that a saved or authored system ID exists in the current catalog. */
export function systemId(raw: unknown, catalog: ContentCatalog) {
  const id = text(raw);
  if (!Object.hasOwn(catalog.systems, id)) throw Error('Unknown traffic system.');
  return id;
}
/** Decode a system/station pair and verify that the station belongs to that system. */
export function port(raw: unknown, catalog: ContentCatalog): Port {
  const r = record(raw),
    id = systemId(r.systemId, catalog),
    stationId = text(r.stationId);
  if (
    !catalog.systems[id].stations.some(
      /** Confirm this station ID belongs to the specified system. */
      (s) => s.id === stationId
    )
  )
    throw Error('Unknown traffic station.');
  return { systemId: id, stationId };
}
/**
 * Decode finite coordinates and require the point to lie within its declared system
 * boundary.
 */
export function point(raw: unknown, catalog: ContentCatalog, id: string) {
  const p = record(raw),
    x = number(p.x, -1e6, 1e6),
    y = number(p.y, -1e6, 1e6),
    z = number(p.z, -1e6, 1e6);
  if (Math.hypot(x, y) > catalog.systems[id].radius)
    throw Error('Traffic waypoint outside system.');
  return { x, y, z };
}
/**
 * Decode a station or labeled waypoint using the kind discriminator to select the
 * appropriate validation path.
 */
export function destination(raw: unknown, catalog: ContentCatalog): Destination {
  const r = record(raw);
  if (r.kind === 'station') return { kind: 'station', ...port(r, catalog) };
  if (r.kind === 'point') {
    const id = systemId(r.systemId, catalog);
    return {
      kind: 'point',
      systemId: id,
      position: point(r.position, catalog, id),
      label: text(r.label)
    };
  }
  throw Error('Unknown traffic destination.');
}
/** Require exactly two valid station endpoints for a commercial service. */
export function ports(raw: unknown, catalog: ContentCatalog): [Port, Port] {
  if (!Array.isArray(raw) || raw.length !== 2) throw Error('A route needs two ports.');
  const route = raw.map(
    /** Decode each commercial endpoint through the shared port validator. */
    (p) => port(p, catalog)
  ) as [Port, Port];
  if (route[0].systemId === route[1].systemId && route[0].stationId === route[1].stationId)
    throw Error('Route endpoints must differ.');
  for (const [a, b] of [
    [route[0], route[1]],
    [route[1], route[0]]
  ])
    if (a.systemId !== b.systemId && !new RouteResolver(catalog).find(a.systemId, b.systemId))
      throw Error('Route needs reachable ports in both directions.');
  return route;
}
/** Decode a bounded multi-stop sightseeing or patrol circuit. */
export function waypoints(raw: unknown, catalog: ContentCatalog): Destination[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 32)
    throw Error('A circuit needs 2–32 waypoints.');
  return raw.map(
    /** Decode each circuit stop through the station-or-waypoint destination validator. */
    (p) => destination(p, catalog)
  );
}
/**
 * Resolve a validated station endpoint to its current display name rather than storing a
 * stale copy in the job.
 */
export function portName(p: Port, catalog: ContentCatalog) {
  return catalog.systems[p.systemId].stations.find(
    /** Resolve a validated port's station to its current authored display name. */
    (s) => s.id === p.stationId
  )!.name;
}
/**
 * Return a station's current name or a waypoint's authored label for announcements and
 * inspection.
 */
export function destinationName(p: Destination, catalog: ContentCatalog) {
  return p.kind === 'station' ? portName(p, catalog) : p.label;
}
