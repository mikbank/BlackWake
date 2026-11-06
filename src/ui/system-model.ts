import { createHyperspaceGateway } from './gateway-model';
import * as THREE from 'three';
import type {
  EnvironmentProfileDefinition,
  SystemDefinition,
  ThemeDefinition,
  StationSize,
  StationDefinition,
  Landmark
} from '../content/schema';
export type SceneContent = {
  definition: SystemDefinition;
  theme: ThemeDefinition;
  environment?: EnvironmentProfileDefinition;
  sizes: Record<string, StationSize>;
  key: string;
  focus?: { x: number; y: number; z: number };
  combatTargetId?: string;
  dockedAt: string | null;
};
/** Visual providers can be registered without changing simulation, services or content loading. */
export const stationModelBuilders = new Map<
  string,
  (station: StationDefinition, theme: ThemeDefinition) => THREE.Group
>();
export const landmarkModelBuilders = new Map<
  string,
  (landmark: Landmark, theme: ThemeDefinition) => THREE.Object3D
>();
stationModelBuilders.set(
  'orbital',
  /**
   * Build the default industrial station model from its theme rather than its available
   * services.
   */
  (_station, theme) => {
    const group = new THREE.Group(),
      core = new THREE.Mesh(
        new THREE.CylinderGeometry(37, 37, 23, 8),
        new THREE.MeshStandardMaterial({
          color: theme.stationColor,
          metalness: 0.6,
          roughness: 0.6
        })
      );
    core.rotation.x = Math.PI / 2;
    group.add(core);
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2 + Math.PI / 4,
        arm = new THREE.Mesh(
          new THREE.BoxGeometry(110, 12, 11),
          new THREE.MeshStandardMaterial({ color: '#43515e', metalness: 0.5 })
        );
      arm.rotation.z = angle;
      group.add(arm);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(3, 8, 6),
        new THREE.MeshBasicMaterial({ color: theme.accent })
      );
      lamp.position.set(Math.cos(angle) * 55, Math.sin(angle) * 55, 12);
      group.add(lamp);
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(76, 4, 8, 64),
      new THREE.MeshStandardMaterial({ color: '#465663', metalness: 0.65, roughness: 0.5 })
    );
    group.add(ring);
    const spine = new THREE.Mesh(
      new THREE.CylinderGeometry(12, 20, 95, 8),
      new THREE.MeshStandardMaterial({ color: theme.stationColor, metalness: 0.65, roughness: 0.6 })
    );
    spine.rotation.x = Math.PI / 2;
    spine.position.z = 18;
    group.add(spine);
    for (const z of [-15, 24, 48]) {
      const deck = new THREE.Mesh(
        new THREE.TorusGeometry(z === 48 ? 15 : 28, 2, 6, 32),
        new THREE.MeshStandardMaterial({
          color: theme.accent,
          emissive: theme.accent,
          emissiveIntensity: 0.6
        })
      );
      deck.position.z = z;
      group.add(deck);
    }
    return group;
  }
);
/** Produce a small deterministic surface texture locally; no network, canvas or gameplay random stream is involved. */
function planetTexture(color: string) {
  const width = 256,
    height = 128,
    data = new Uint8Array(width * height * 4);
  const sea = new THREE.Color(color),
    land = new THREE.Color('#8c9274'),
    ice = new THREE.Color('#b5cbd2');
  for (let y = 0; y < height; y++) {
    const latitude = (y / (height - 1) - 0.5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const longitude = (x / width) * Math.PI * 2;
      const terrain =
        Math.sin(longitude * 3 + Math.sin(latitude * 5)) +
        Math.cos(longitude * 7 - latitude * 8) * 0.5 +
        Math.sin(longitude * 13 + latitude * 17) * 0.2;
      const pixel = sea.clone();
      if (terrain > 0.5) pixel.lerp(land, Math.min(0.75, (terrain - 0.5) * 0.7));
      if (Math.abs(latitude) > 1.2) pixel.lerp(ice, Math.min(1, (Math.abs(latitude) - 1.2) * 4));
      // Data textures tagged sRGB need encoded bytes, whereas Three.Color stores linear values.
      pixel.convertLinearToSRGB();
      const offset = (y * width + x) * 4;
      data[offset] = pixel.r * 255;
      data[offset + 1] = pixel.g * 255;
      data[offset + 2] = pixel.b * 255;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
landmarkModelBuilders.set(
  'planet',
  /** Build the default planet landmark using its authored size and environment palette. */
  (landmark, theme) => {
    const group = new THREE.Group(),
      planet = new THREE.Mesh(
        new THREE.SphereGeometry(landmark.radius, 32, 24),
        new THREE.MeshStandardMaterial({
          map: planetTexture(theme.bodyColor),
          roughness: 1,
          metalness: 0
        })
      );
    planet.position.z = -Math.max(320, landmark.radius * 1.9);
    group.add(planet);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(landmark.radius * 1.045, 32, 24),
      new THREE.MeshBasicMaterial({
        color: '#8abbd1',
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    halo.position.z = planet.position.z;
    group.add(halo);
    return group;
  }
);
/**
 * Build station, landmark and jump-zone graphics from content and registered model
 * providers, independently of station services.
 */
function* systemModelParts(content: SceneContent): Generator<THREE.Object3D> {
  const theme = content.theme;
  for (const station of content.definition.stations) {
    const builder =
        stationModelBuilders.get(station.modelId ?? theme.stationModelId ?? 'orbital') ??
        stationModelBuilders.get('orbital')!,
      group = builder(station, theme);
    group.scale.setScalar(content.sizes[station.size].scale);
    group.position.set(station.position.x, station.position.y, 0);
    group.name = station.id;
    yield group;
  }
  for (const landmark of content.definition.landmarks) {
    const builder = landmarkModelBuilders.get(landmark.kind);
    if (!builder) continue;
    const object = builder(landmark, theme);
    object.position.x = landmark.position.x;
    object.position.y = landmark.position.y;
    yield object;
  }
  for (const gate of content.definition.gates) yield createHyperspaceGateway(gate, theme);
}
/** Build a complete system synchronously for initial loading and browser-free model tests. */
export function buildSystemModels(content: SceneContent) {
  const root = new THREE.Group();
  for (const part of systemModelParts(content)) root.add(part);
  return root;
}
/** Prepare one destination in frame-sized object batches, releasing completed parts on failure. */
export async function prepareSystemModels(content: SceneContent, yieldFrame: () => Promise<void>) {
  const root = new THREE.Group();
  try {
    for (const part of systemModelParts(content)) {
      root.add(part);
      await yieldFrame();
    }
    return root;
  } catch (error) {
    disposeSystemModels(root);
    throw error;
  }
}
/** Release the system graphics' geometries and materials when its scene is replaced. */
export function disposeSystemModels(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  root.traverse(
    /** Release mesh resources when the active system graphics are unloaded. */
    (o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          materials.add(m);
          for (const value of Object.values(m))
            if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    }
  );
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
