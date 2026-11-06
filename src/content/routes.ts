import type { ContentCatalog } from './catalog';
export type RouteHop = {
  fromSystemId: string;
  gateId: string;
  connectionId: string;
  toSystemId: string;
  arrivalGateId: string;
};
export type AccessDecision = { allowed: true } | { allowed: false; reason: string };
export type RoutePolicy = (hop: RouteHop) => AccessDecision;
export type Route = { fromSystemId: string; toSystemId: string; hops: RouteHop[] };
/**
 * Query the jump graph through a shared access policy; routing does not move ships or
 * advance game time.
 */
export class RouteResolver {
  /**
   * Retain the catalog and access callback; readonly constructor parameters also declare
   * instance fields in TypeScript.
   */
  constructor(
    readonly catalog: ContentCatalog,
    /** Allow graph connections by default until a caller installs a permit or closure policy. */
    public policy: RoutePolicy = () => ({ allowed: true })
  ) {}
  /**
   * List this system's directed gate connections in stable ID order for deterministic route
   * choices.
   */
  connections(systemId: string): RouteHop[] {
    const system = this.catalog.systems[systemId];
    if (!system) return [];
    return system.gates
      .flatMap(
        /** Expand each local gate into its directed outgoing hops. */
        (g) =>
          g.connections.map(
            /** Describe the exact departure and arrival endpoints needed to execute this hop later. */
            (c) => ({
              fromSystemId: systemId,
              gateId: g.id,
              connectionId: c.id,
              toSystemId: c.systemId,
              arrivalGateId: c.gateId
            })
          )
      )
      .sort(
        /** Sort connection IDs so equally short paths are chosen reproducibly. */
        (a, b) => a.connectionId.localeCompare(b.connectionId)
      );
  }
  /**
   * Find one outgoing connection by its stable ID, returning undefined if it is not
   * available in this system.
   */
  connection(systemId: string, connectionId: string) {
    return this.connections(systemId).find(
      /** Find the requested outgoing hop without searching unrelated systems. */
      (h) => h.connectionId === connectionId
    );
  }
  /**
   * Evaluate the current access rule for a hop, keeping permit or closure decisions separate
   * from graph traversal.
   */
  access(hop: RouteHop): AccessDecision {
    return this.policy(hop);
  }
  /** Compute reachable system hop counts once when a policy considers destinations across the universe. */
  distances(fromSystemId: string): Map<string, number> {
    const distances = new Map<string, number>();
    if (!Object.hasOwn(this.catalog.systems, fromSystemId)) return distances;
    const queue = [fromSystemId];
    distances.set(fromSystemId, 0);
    for (let head = 0; head < queue.length; head++)
      for (const hop of this.connections(queue[head])) {
        if (distances.has(hop.toSystemId) || !this.access(hop).allowed) continue;
        distances.set(hop.toSystemId, distances.get(queue[head])! + 1);
        queue.push(hop.toSystemId);
      }
    return distances;
  }
  /**
   * Find the fewest-jump allowed route with breadth-first search; return null when no route
   * exists.
   */
  find(fromSystemId: string, toSystemId: string): Route | null {
    if (
      !Object.hasOwn(this.catalog.systems, fromSystemId) ||
      !Object.hasOwn(this.catalog.systems, toSystemId)
    )
      return null;
    const queue = [fromSystemId],
      previous = new Map<string, RouteHop>();
    const seen = new Set([fromSystemId]);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (current === toSystemId) {
        const hops: RouteHop[] = [];
        let at = current;
        while (at !== fromSystemId) {
          const hop = previous.get(at)!;
          hops.push(hop);
          at = hop.fromSystemId;
        }
        return { fromSystemId, toSystemId, hops: hops.reverse() };
      }
      for (const hop of this.connections(current)) {
        if (seen.has(hop.toSystemId) || !this.access(hop).allowed) continue;
        seen.add(hop.toSystemId);
        previous.set(hop.toSystemId, hop);
        queue.push(hop.toSystemId);
      }
    }
    return null;
  }
}
