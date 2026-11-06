import { currentSpatialVersion, legacyDistanceScale } from '../content/spatial-scale';
/** Recognize serialized records without changing or repairing malformed values before normal decoding. */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Scale only known positional contracts; velocities, timers, cargo and identities retain their original meaning. */
function convertCoordinates(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) convertCoordinates(item);
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'velocity') continue;
    if ((key === 'position' || key === 'from' || key === 'to') && record(child)) {
      for (const axis of ['x', 'y', 'z'])
        if (typeof child[axis] === 'number')
          child[axis] = Number(child[axis]) * legacyDistanceScale;
    } else if (key === 'responseRange' && typeof child === 'number')
      value[key] = child * legacyDistanceScale;
    else convertCoordinates(child);
  }
}
/** Upgrade a supported saved coordinate revision once, before gate/waypoint validation against enlarged content. */
export function migrateSpatialSave(raw: Record<string, any>, targetVersion: number) {
  const version = raw.spatialVersion ?? 0;
  if (
    !Number.isInteger(version) ||
    version < 0 ||
    version > currentSpatialVersion ||
    version > targetVersion
  )
    throw Error('Unsupported spatial layout in save.');
  if (version === targetVersion) return false;
  if (version !== 0 || targetVersion !== currentSpatialVersion)
    throw Error('Unsupported spatial migration.');
  convertCoordinates(raw);
  raw.spatialVersion = targetVersion;
  return true;
}
