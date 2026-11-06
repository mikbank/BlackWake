import type { SystemDefinition, JumpGate } from '../schema';
import { distance } from '../../core/model';
import { round } from './random';
/**
 * Add reciprocal jump gates without moving existing exits; reject inconsistent links and
 * leave complete pairs unchanged.
 */
export function connectSystems(a: SystemDefinition, b: SystemDefinition) {
  if (a.id === b.id) throw Error('A jump connection needs two different systems.');
  const existing = a.gates.find(
    /** Locate an existing outgoing gate before deciding whether a link must be created. */
    (g) =>
      g.connections.some(
        /** Check whether this gate already leads to the other system. */
        (c) => c.systemId === b.id
      )
  );
  if (existing) {
    const link = existing.connections.find(
        /** Resolve the matching outgoing link for reciprocal-pair validation. */
        (c) => c.systemId === b.id
      )!,
      arrival = b.gates.find(
        /** Locate the arrival endpoint named by the existing link. */
        (g) => g.id === link.gateId
      );
    if (
      !arrival?.connections.some(
        /** Confirm the arrival gate links back to the original physical exit. */
        (c) => c.systemId === a.id && c.gateId === existing.id
      )
    )
      throw Error('Existing connection is not paired; repair it explicitly.');
    return false;
  }
  if (
    b.gates.some(
      /** Detect an inconsistent reverse-only connection rather than silently overwrite it. */
      (g) =>
        g.connections.some(
          /** Check whether this reverse gate already leads to the first system. */
          (c) => c.systemId === a.id
        )
    )
  )
    throw Error('Existing reverse-only connection needs explicit repair.');
  const edge = [a.id, b.id].sort().join('-');
  /**
   * Find a separated outer position for a new gate, using the destination's chart bearing as
   * the initial direction.
   */
  function gate(from: SystemDefinition, to: SystemDefinition): JumpGate {
    const bearing = Math.atan2(to.chart.y - from.chart.y, to.chart.x - from.chart.x),
      radius = from.radius - Math.min(900, from.radius * 0.15);
    for (let n = 0; n < 64; n++) {
      const angle = bearing + (n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 0.25),
        position = { x: round(Math.cos(angle) * radius), y: round(Math.sin(angle) * radius), z: 0 };
      if (
        from.gates.some(
          /** Reject candidate exit positions too close to an existing gate. */
          (g) => distance(g.position, position) < g.radius + 140 + Math.min(500, from.radius * 0.1)
        ) ||
        from.stations.some(
          /** Keep new exits clear of station approaches. */
          (s) => distance(s.position, position) < Math.min(1200, from.radius * 0.2)
        ) ||
        from.landmarks.some(
          /** Keep new exits outside landmark bodies and their clearance margin. */
          (l) => distance(l.position, position) < l.radius + Math.min(900, from.radius * 0.15)
        )
      )
        continue;
      return {
        id: `${from.id}-gate-${edge}`,
        name: `${to.name} gateway`,
        position,
        radius: 140,
        connections: [
          { id: `${from.id}-to-${to.id}`, systemId: to.id, gateId: `${to.id}-gate-${edge}` }
        ]
      };
    }
    throw Error(`No separated outer gate position is available in ${from.id}.`);
  }
  const ga = gate(a, b),
    gb = gate(b, a);
  a.gates.push(ga);
  b.gates.push(gb);
  return true;
}
