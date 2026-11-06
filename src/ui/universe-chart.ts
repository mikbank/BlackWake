import type { GameSession } from '../game/session';
import { esc } from './dom';
/**
 * Render an SVG jump graph with current location and an optional route preview, without
 * changing saved navigation state.
 */
export function universeChart(
  game: GameSession,
  destinationId: string | null = game.routeDestinationId
) {
  const systems = Object.values(game.catalog.systems),
    height = Math.max(250, Math.min(650, systems.length * 55)),
    xs = systems.map(
      /** Read chart X coordinates to calculate the graph's horizontal extent. */
      (s) => s.chart.x
    ),
    ys = systems.map(
      /** Read chart Y coordinates to calculate the graph's vertical extent. */
      (s) => s.chart.y
    ),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  /** Project a system's chart coordinates into the responsive graph's padded SVG view box. */
  const point = (id: string) => {
    const p = game.catalog.systems[id].chart;
    return {
      x: 65 + ((p.x - minX) / Math.max(1, maxX - minX)) * 290,
      y: height - 50 - ((p.y - minY) / Math.max(0.7, maxY - minY)) * (height - 110)
    };
  };
  const highlighted = new Set(
      destinationId
        ? (game.routes.find(game.systemId, destinationId)?.hops ?? []).map(
            /** Normalize each highlighted hop's endpoints so the undirected graph edge is drawn once. */
            (h) => [h.fromSystemId, h.toSystemId].sort().join('|')
          )
        : []
    ),
    seen = new Set<string>(),
    lines: string[] = [];
  for (const s of systems)
    for (const hop of game.routes.connections(s.id)) {
      const key = [s.id, hop.toSystemId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = point(s.id),
        b = point(hop.toSystemId);
      lines.push(
        `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="${highlighted.has(key) ? 'plotted' : 'route-edge'}"/>`
      );
    }
  return `<svg class="universe-graph" viewBox="0 0 420 ${height}" role="img" aria-label="System connections. Plot a route using the buttons below.">${lines.join('')}${systems
    .map(
      /** Draw each named system with its current-location, destination and visit status. */
      (s) => {
        const p = point(s.id),
          current = s.id === game.systemId;
        return `<g transform="translate(${p.x} ${p.y})" class="${current ? 'current' : s.id === destinationId ? 'destination' : ''}"><circle r="${current ? 9 : 6}"/><text y="-19" text-anchor="middle">${esc(s.name)}</text><text class="node-status" y="26" text-anchor="middle">${current ? 'You are here' : game.visits[s.id] ? 'Visited' : 'Unvisited'}</text></g>`;
      }
    )
    .join('')}</svg>`;
}
