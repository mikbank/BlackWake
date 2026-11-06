import { definitions, type Ship, type Vec3 } from '../core/model';
import type { StationDefinition, StationSize } from '../content/schema';
import { stationFootprintRadius } from '../content/spatial-scale';
/** Stop outside station hardware while staying inside its corresponding docking envelope. */
export function stationApproachDistance(size: StationSize, kind: Ship['kind']) {
  return Math.min(
    size.dockRadius - 20,
    stationFootprintRadius * size.scale + definitions[kind].length / 2 + 25
  );
}
/** Give each actor an exterior berth whose clearance follows station size rather than fixed world coordinates. */
export function stationBerth(
  station: StationDefinition,
  size: StationSize,
  ship: Pick<Ship, 'id' | 'kind'>,
  systemRadius: number
): Vec3 {
  let hash = 0;
  for (const char of ship.id) hash = (hash + char.charCodeAt(0)) % 3;
  let angle = (hash - 1) * 0.55;
  const radius = stationApproachDistance(size, ship.kind);
  let x = station.position.x + Math.cos(angle) * radius,
    y = station.position.y + Math.sin(angle) * radius;
  if (Math.hypot(x, y) > systemRadius - 30) {
    angle = Math.atan2(-station.position.y, -station.position.x) + (hash - 1) * 0.55;
    x = station.position.x + Math.cos(angle) * radius;
    y = station.position.y + Math.sin(angle) * radius;
  }
  const clamp = Math.min(1, (systemRadius - 30) / Math.max(1, Math.hypot(x, y)));
  return { x: x * clamp, y: y * clamp, z: 0 };
}
