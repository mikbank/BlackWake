import type { ContentCatalog } from './catalog';
import type { EnvironmentProfileDefinition, SystemDefinition } from './schema';
/** Legacy content without an environment table resolves to this independent space palette. */
export const defaultEnvironmentProfile: EnvironmentProfileDefinition = {
  id: 'frontier-space',
  name: 'Frontier haze',
  rendererId: 'nebula',
  background: {
    color: '#060e1a',
    tint: '#416d91',
    secondaryTint: '#695b83',
    textureSetId: 'wisps',
    intensity: 0.5,
    coverage: 0.6,
    scale: 2.5
  },
  stars: { density: 1, color: '#acc4db', size: 1 },
  lighting: { keyColor: '#ffe3b4', keyIntensity: 3, fillColor: '#c4d7df', fillIntensity: 1 },
  dust: { density: 0.12, color: '#99b4c4' },
  asteroids: { density: 0.6, color: '#35434d' }
};
/** Accept only object records at the content boundary; no renderer or DOM is needed for validation. */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Validate a bounded authored scalar before it can control allocation or lighting. */
function bounded(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
/** Keep color parsing identical in CPU texture generation and Three.js materials. */
function color(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
/** Validate profile recipes, colors and density limits without importing graphics code. */
export function validateEnvironmentProfiles(profiles: unknown, defaultId: string) {
  if (!record(profiles) || !Object.hasOwn(profiles, defaultId))
    throw Error('Missing default environment profile.');
  for (const [id, p] of Object.entries(profiles)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(id) ||
      !record(p) ||
      p.id !== id ||
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      !record(p.background) ||
      !record(p.stars) ||
      !record(p.lighting) ||
      !record(p.dust) ||
      !record(p.asteroids)
    )
      throw Error(`Invalid environment profile: ${id}`);
    const b = p.background,
      s = p.stars,
      l = p.lighting,
      d = p.dust,
      a = p.asteroids;
    const recipes: Record<string, string[]> = {
      'clear-space': ['none'],
      nebula: ['wisps', 'billows'],
      'dust-field': ['dust-lanes']
    };
    if (
      typeof p.rendererId !== 'string' ||
      !Object.hasOwn(recipes, p.rendererId) ||
      !recipes[p.rendererId].includes(String(b.textureSetId)) ||
      !color(b.color) ||
      !color(b.tint) ||
      !color(b.secondaryTint) ||
      !bounded(b.intensity, 0, 1) ||
      !bounded(b.coverage, 0, 1) ||
      !bounded(b.scale, 0.5, 8) ||
      !color(s.color) ||
      !bounded(s.density, 0, 1.5) ||
      !bounded(s.size, 0.3, 3) ||
      !color(l.keyColor) ||
      !color(l.fillColor) ||
      !bounded(l.keyIntensity, 0, 5) ||
      !bounded(l.fillIntensity, 0, 3) ||
      !color(d.color) ||
      !bounded(d.density, 0, 1) ||
      !color(a.color) ||
      !bounded(a.density, 0, 1)
    )
      throw Error(`Invalid environment settings: ${id}`);
  }
}
/** Resolve a system's space appearance independently of its infrastructure theme, culture and physical radius. */
export function systemEnvironment(catalog: ContentCatalog, system: SystemDefinition) {
  const id = system.environmentId ?? catalog.defaultEnvironmentId,
    profile = catalog.environmentProfiles[id];
  if (!Object.hasOwn(catalog.environmentProfiles, id))
    throw Error(`Unknown environment profile: ${id}`);
  return profile;
}
