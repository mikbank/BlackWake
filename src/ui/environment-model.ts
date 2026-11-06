import * as THREE from 'three';
import type { EnvironmentProfileDefinition, SystemDefinition } from '../content/schema';
import { randomStream } from '../content/generation/random';
/** Rendering budgets are device policy, never authored system size or culture. */
export type EnvironmentQuality = Readonly<{
  maxStars: number;
  maxDust: number;
  maxAsteroids: number;
  textureWidth: number;
  textureHeight: number;
}>;
export const environmentQualityPresets = {
  mobile: { maxStars: 2600, maxDust: 140, maxAsteroids: 65, textureWidth: 512, textureHeight: 256 },
  low: { maxStars: 1400, maxDust: 65, maxAsteroids: 30, textureWidth: 256, textureHeight: 128 }
} satisfies Record<string, EnvironmentQuality>;
export type BuiltEnvironment = {
  profileId: string;
  background: string;
  sky: THREE.Group;
  world: THREE.Group;
};
type EnvironmentPart = { layer: 'sky' | 'world'; object: THREE.Object3D } | null;
/** Decode validated sRGB colors directly into encoded texture-byte units. */
function rgb(hex: string) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}
/** Clamp a procedural appearance value without affecting any domain record. */
function unit(n: number) {
  return Math.max(0, Math.min(1, n));
}
/** Interpolate noise-cell corners smoothly. */
function ease(n: number) {
  return n * n * (3 - 2 * n);
}
/** Produce stable lattice noise from integer coordinates and a dedicated visual seed. */
function noiseHash(x: number, y: number, z: number, seed: number) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2246822519) + seed) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
/** Sample continuous value noise on a sphere so equirectangular background seams remain periodic. */
function noise(x: number, y: number, z: number, seed: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z),
    tx = ease(x - ix),
    ty = ease(y - iy),
    tz = ease(z - iz);
  let sum = 0;
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        sum +=
          noiseHash(ix + dx, iy + dy, iz + dz, seed) *
          (dx ? tx : 1 - tx) *
          (dy ? ty : 1 - ty) *
          (dz ? tz : 1 - tz);
  return sum;
}
/** Resolve one deterministic procedural texture sampler; parsing and seed setup happen once per background. */
export function backgroundSampler(profile: EnvironmentProfileDefinition, seed: number) {
  const base = rgb(profile.background.color),
    first = rgb(profile.background.tint),
    second = rgb(profile.background.secondaryTint);
  const random = randomStream(seed, 'visual-background'),
    offset = random() * 19,
    textureSeed = Math.floor(random() * 0x100000000);
  /** Sample encoded RGB values at angular coordinates without consuming a mutable random stream. */
  return (longitude: number, latitude: number) => {
    if (profile.rendererId === 'clear-space') return [...base];
    const scale = profile.background.scale,
      cos = Math.cos(latitude);
    let x = Math.cos(longitude) * cos * scale,
      y = Math.sin(latitude) * scale,
      z = Math.sin(longitude) * cos * scale;
    if (profile.background.textureSetId === 'wisps') {
      x *= 1.5;
      y *= 0.55;
      z *= 2.2;
    }
    const n =
      (noise(x + offset, y, z, textureSeed) * 0.5 +
        noise(x * 2 + offset, y * 2, z * 2, textureSeed) * 0.25 +
        noise(x * 4 + offset, y * 4, z * 4, textureSeed) * 0.125) /
      0.875;
    const shape = profile.background.textureSetId === 'billows' ? Math.pow(n, 0.85) : n;
    let cloud =
      unit((shape - (0.68 - profile.background.coverage * 0.35)) * 2.5) *
      profile.background.intensity;
    if (profile.rendererId === 'dust-field')
      cloud *= 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(x * 1.4 + n * 6 + z * 0.6), 2);
    const blend = unit(0.5 + 0.5 * Math.sin(longitude * 2 + latitude * 3 + offset));
    return base.map(
      /** Blend a seeded cloud palette in encoded sRGB byte space. */ (channel, i) =>
        Math.round(channel * (1 - cloud) + (first[i] * (1 - blend) + second[i] * blend) * cloud)
    );
  };
}
/** Keep decorative rocks outside landmarks, docking approaches and gateway arrival envelopes. */
function clearDecoration(system: SystemDefinition, x: number, y: number, size: number) {
  if (Math.hypot(x, y) + size > system.radius) return false;
  for (const station of system.stations)
    if (Math.hypot(x - station.position.x, y - station.position.y) < 220 + size) return false;
  for (const gate of system.gates)
    if (Math.hypot(x - gate.position.x, y - gate.position.y) < gate.radius + 70 + size)
      return false;
  for (const landmark of system.landmarks)
    if (Math.hypot(x - landmark.position.x, y - landmark.position.y) < landmark.radius + 60 + size)
      return false;
  return true;
}
/** Generate bounded graphics parts with explicit yields between texture-row batches. */
function* environmentParts(
  system: SystemDefinition,
  profile: EnvironmentProfileDefinition,
  quality: EnvironmentQuality
): Generator<EnvironmentPart> {
  const starsRandom = randomStream(system.seed, 'visual-stars'),
    count = Math.round((quality.maxStars * profile.stars.density) / 1.5);
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = starsRandom() * 2 - 1,
      angle = starsRandom() * Math.PI * 2;
    points[i * 3] = Math.sqrt(1 - z * z) * Math.cos(angle) * 9000;
    points[i * 3 + 1] = Math.sqrt(1 - z * z) * Math.sin(angle) * 9000;
    points[i * 3 + 2] = z * 9000;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      color: profile.stars.color,
      size: 14 * profile.stars.size,
      transparent: true,
      opacity: 0.85,
      toneMapped: false
    })
  );
  stars.name = 'environment-stars';
  stars.renderOrder = -90;
  yield { layer: 'sky', object: stars };
  const width = quality.textureWidth,
    height = quality.textureHeight,
    pixels = new Uint8Array(width * height * 4),
    sample = backgroundSampler(profile, system.seed);
  for (let y = 0; y < height; y++) {
    const latitude = (y / (height - 1) - 0.5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const color = sample((x / width) * Math.PI * 2, latitude),
        offset = (y * width + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
    if (y % 16 === 15) yield null;
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  const background = new THREE.Mesh(
    new THREE.SphereGeometry(12000, 32, 20),
    new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false
    })
  );
  background.name = 'environment-background';
  background.renderOrder = -100;
  yield { layer: 'sky', object: background };
  const dustCount = Math.round(quality.maxDust * profile.dust.density);
  if (dustCount) {
    const random = randomStream(system.seed, 'visual-dust'),
      positions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      const angle = random() * Math.PI * 2,
        radius = Math.sqrt(random()) * system.radius * 0.95;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius;
      positions[i * 3 + 2] = (random() - 0.5) * 400;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dust = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: profile.dust.color,
        size: 1.8,
        transparent: true,
        opacity: 0.3,
        depthWrite: false
      })
    );
    dust.name = 'environment-dust';
    yield { layer: 'world', object: dust };
  }
  const rockCount = Math.round(quality.maxAsteroids * profile.asteroids.density);
  if (rockCount) {
    const random = randomStream(system.seed, 'visual-asteroids'),
      rock = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({
          color: profile.asteroids.color,
          roughness: 1,
          flatShading: true
        }),
        rockCount
      );
    const transform = new THREE.Object3D();
    let placed = 0;
    for (let attempt = 0; attempt < rockCount * 12 && placed < rockCount; attempt++) {
      const angle = random() * Math.PI * 2,
        radius = system.radius * (0.3 + random() * 0.6),
        size = 8 + random() * 27,
        x = Math.cos(angle) * radius,
        y = Math.sin(angle) * radius;
      if (!clearDecoration(system, x, y, size)) continue;
      transform.position.set(x, y, (random() - 0.5) * 360);
      transform.rotation.set(random() * 3, random() * 3, random() * 3);
      transform.scale.set(size, size * (0.65 + random() * 0.45), size * (0.7 + random() * 0.4));
      transform.updateMatrix();
      rock.setMatrixAt(placed++, transform.matrix);
    }
    rock.count = placed;
    rock.instanceMatrix.needsUpdate = true;
    rock.computeBoundingSphere();
    rock.name = 'environment-asteroids';
    yield { layer: 'world', object: rock };
  }
  const key = new THREE.DirectionalLight(profile.lighting.keyColor, profile.lighting.keyIntensity);
  key.position.set(-200, 400, 700);
  key.name = 'environment-key-light';
  yield { layer: 'world', object: key };
  const fill = new THREE.HemisphereLight(
    profile.lighting.fillColor,
    '#14212b',
    profile.lighting.fillIntensity
  );
  fill.position.set(0, 0, 1);
  fill.name = 'environment-fill-light';
  yield { layer: 'world', object: fill };
}
/** Allocate only the resource roots; the camera-centred sky and world decoration have separate transforms. */
function emptyEnvironment(profile: EnvironmentProfileDefinition): BuiltEnvironment {
  return {
    profileId: profile.id,
    background: profile.background.color,
    sky: new THREE.Group(),
    world: new THREE.Group()
  };
}
/** Build initial-system graphics synchronously from the same parts used by destination preparation. */
export function buildEnvironment(
  system: SystemDefinition,
  profile: EnvironmentProfileDefinition,
  quality: EnvironmentQuality = environmentQualityPresets.mobile
) {
  const environment = emptyEnvironment(profile);
  try {
    for (const part of environmentParts(system, profile, quality))
      if (part) environment[part.layer].add(part.object);
    return environment;
  } catch (error) {
    disposeEnvironment(environment);
    throw error;
  }
}
/** Prepare a destination background across frames while retaining one explicit disposable ownership bundle. */
export async function prepareEnvironment(
  system: SystemDefinition,
  profile: EnvironmentProfileDefinition,
  yieldFrame: () => Promise<void>,
  quality: EnvironmentQuality = environmentQualityPresets.mobile
) {
  const environment = emptyEnvironment(profile);
  try {
    for (const part of environmentParts(system, profile, quality)) {
      if (part) environment[part.layer].add(part.object);
      await yieldFrame();
    }
    return environment;
  } catch (error) {
    disposeEnvironment(environment);
    throw error;
  }
}
/** Release sky textures, particle buffers, instance attributes and materials when a candidate or active system unloads. */
export function disposeEnvironment(environment: BuiltEnvironment) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  for (const root of [environment.sky, environment.world])
    root.traverse(
      /** Collect shared resources once, and release instance-owned GPU attributes explicitly. */ (
        object
      ) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    );
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  environment.sky.clear();
  environment.world.clear();
}
