import { RouteResolver } from '../../content/routes';
import { randomStream } from '../../content/generation/random';
import type { ContentCatalog } from '../../content/catalog';
import type { Destination, JobContext, Port } from './model';
import { integer, systemId } from './validation';
export type DestinationMemory = { decision: number; recentSystems: string[] };
export type DestinationChoice = DestinationMemory & { destination: Destination };
/** Validate persisted decision/history data without consuming randomness or choosing a new destination. */
export function readDestinationMemory(
  raw: Record<string, unknown>,
  catalog: ContentCatalog
): DestinationMemory {
  if (!Array.isArray(raw.recentSystems) || raw.recentSystems.length > 3)
    throw Error('Invalid destination history.');
  return {
    decision: integer(raw.decision, 0, Number.MAX_SAFE_INTEGER),
    recentSystems: raw.recentSystems.map(
      /** Keep remembered systems valid without treating them as a planned itinerary. */ (id) =>
        systemId(id, catalog)
    )
  };
}
/** Give candidate ordering a stable identity independent of catalog insertion order. */
function destinationKey(value: Destination) {
  return value.kind === 'station'
    ? `station:${value.stationId}`
    : `point:${value.label}:${value.position.x}:${value.position.y}`;
}
/** Pick one reachable system, then a destination within it, using per-actor serialized decision memory. */
export function chooseDestination(
  ctx: JobContext,
  memory: DestinationMemory,
  candidates: Destination[],
  minHops = 1,
  avoidSystems: string[] = []
): DestinationChoice | undefined {
  const routes = ctx.routes ?? new RouteResolver(ctx.catalog),
    distances = routes.distances(ctx.systemId);
  const grouped = new Map<string, Destination[]>();
  for (const candidate of candidates) {
    if (candidate.systemId === ctx.systemId || !distances.has(candidate.systemId)) continue;
    const group = grouped.get(candidate.systemId) ?? [];
    group.push(candidate);
    grouped.set(candidate.systemId, group);
  }
  let systems = [...grouped.keys()].sort();
  const preferred = systems.filter(
    /** Avoid home or an authored exclusion when other systems are reachable. */ (id) =>
      !avoidSystems.includes(id)
  );
  if (preferred.length) systems = preferred;
  const fresh = systems.filter(
    /** Avoid immediate reversals and short repetitive loops when alternatives exist. */ (id) =>
      !memory.recentSystems.includes(id)
  );
  if (fresh.length) systems = fresh;
  const distant = systems.filter(
    /** Prefer meaningful long-haul legs, falling back gracefully in small networks. */ (id) =>
      distances.get(id)! >= minHops
  );
  if (distant.length) systems = distant;
  if (!systems.length) return;
  const random = randomStream(
    ctx.catalog.systems[ctx.homeSystemId].seed,
    `npc-destination:${ctx.ship.id}:${memory.decision}`
  );
  const total = systems.reduce(
    /** Favor longer reachable trips with bounded weights rather than always choosing the farthest. */ (
      sum,
      id
    ) => sum + 1 + Math.min(6, distances.get(id)!),
    0
  );
  let draw = random() * total,
    selected = systems.at(-1)!;
  for (const id of systems) {
    draw -= 1 + Math.min(6, distances.get(id)!);
    if (draw < 0) {
      selected = id;
      break;
    }
  }
  const choices = grouped
    .get(selected)!
    .sort(
      /** Stabilize the second draw when systems have multiple ports or viewpoints. */ (a, b) =>
        destinationKey(a).localeCompare(destinationKey(b))
    );
  const destination = structuredClone(choices[Math.floor(random() * choices.length)]);
  return {
    destination,
    decision: memory.decision === Number.MAX_SAFE_INTEGER ? 0 : memory.decision + 1,
    recentSystems: [...memory.recentSystems, selected].slice(-3)
  };
}
/** Enumerate actual market stations without coupling destination choices to culture or the home region. */
export function marketPorts(catalog: ContentCatalog): Port[] {
  const ports: Port[] = [];
  for (const system of Object.values(catalog.systems))
    for (const station of system.stations)
      if (
        station.services.some(
          /** Require a market capability, independently of station size or model. */ (service) =>
            service.kind === 'market'
        )
      )
        ports.push({ systemId: system.id, stationId: station.id });
  return ports;
}
/** Offer factual planet viewpoints and station visits throughout the currently registered universe. */
export function tourDestinations(catalog: ContentCatalog): Destination[] {
  const destinations: Destination[] = [];
  for (const system of Object.values(catalog.systems)) {
    for (const station of system.stations)
      destinations.push({ kind: 'station', systemId: system.id, stationId: station.id });
    for (const landmark of system.landmarks) {
      const x = landmark.position.x + landmark.radius * 1.25,
        y = landmark.position.y + landmark.radius * 0.35;
      const clamp = Math.min(1, (system.radius - 50) / Math.max(1, Math.hypot(x, y)));
      destinations.push({
        kind: 'point',
        systemId: system.id,
        position: { x: x * clamp, y: y * clamp, z: 0 },
        label: `${landmark.name} panorama`
      });
    }
  }
  return destinations;
}
