import type { Ship, Vec3 } from '../core/model';
/**
 * A station capability selected by kind with handler-specific settings, independent of
 * station size or appearance.
 */
export type StationService = { kind: string; config: Record<string, unknown> };
export type StationDefinition = {
  description?: string;
  id: string;
  name: string;
  position: Vec3;
  size: string;
  modelId?: string;
  services: StationService[];
};
export type Landmark = {
  description?: string;
  id: string;
  name: string;
  kind: string;
  position: Vec3;
  radius: number;
};
export type JumpConnection = { id: string; systemId: string; gateId: string };
export type JumpGate = {
  id: string;
  name: string;
  position: Vec3;
  radius: number;
  connections: JumpConnection[];
};
/**
 * Authored NPC starting hull and job configuration; optional culture overrides represent
 * visiting crews.
 */
export type TrafficSpawn = {
  cultureId?: string;
  ship: Ship;
  job: { kind: string; config: Record<string, unknown> };
};
/**
 * Editable system content: local objects and graph exits plus resolved cultural defaults.
 * Runtime state is owned by GameSession and TrafficDirector.
 */
export type SystemDefinition = {
  regionId?: string;
  description?: string;
  generation?: { generatorVersion: number; seed: number; presetId: string };
  cultureId: string;
  id: string;
  name: string;
  themeId: string;
  /** Space appearance reference; legacy systems fall back to the catalog default. */
  environmentId?: string;
  seed: number;
  radius: number;
  chart: { x: number; y: number };
  stations: StationDefinition[];
  landmarks: Landmark[];
  gates: JumpGate[];
  traffic: TrafficSpawn[];
};
/**
 * Authoring grouping and cultural default; NPCs retain independent culture after creation
 * and when crossing region boundaries.
 */
export type RegionDefinition = { id: string; name: string; cultureId: string };
/** Infrastructure and primary-body material palette, independent of the space environment. */
export type ThemeDefinition = {
  id: string;
  /** Legacy authored field; space backgrounds now come from environment profiles. */
  background?: string;
  /** Legacy authored field; star appearance now comes from environment profiles. */
  starColor?: string;
  bodyColor: string;
  stationColor: string;
  accent: string;
  stationModelId?: string;
};
/** Data-only space appearance; physical dimensions, cultures and station materials live elsewhere. */
export type EnvironmentProfileDefinition = {
  id: string;
  name: string;
  rendererId: 'clear-space' | 'nebula' | 'dust-field';
  background: {
    color: string;
    tint: string;
    secondaryTint: string;
    textureSetId: 'none' | 'wisps' | 'billows' | 'dust-lanes';
    intensity: number;
    coverage: number;
    scale: number;
  };
  stars: { density: number; color: string; size: number };
  lighting: { keyColor: string; keyIntensity: number; fillColor: string; fillIntensity: number };
  dust: { density: number; color: string };
  asteroids: { density: number; color: string };
};
export type StationSize = { id: string; scale: number; dockRadius: number; description: string };
/** A station's offer: price is the player's purchase price; bidPrice is the station's offer. */
export type MarketGood = {
  price: number;
  stock: number;
  bidPrice?: number;
  buys?: boolean;
  sells?: boolean;
};
/** Assortment and directional trading permissions are independent of the shared goods catalog. */
export type MarketProfile = {
  id: string;
  name?: string;
  description?: string;
  goods: Record<string, MarketGood>;
};
export type Commodity = {
  id: string;
  name: string;
  unitSize: number;
  category?: string;
  description?: string;
};

/**
 * Visual identity mapped to a registered 3D provider while retaining an existing gameplay
 * hull class.
 */
export type ShipDesignDefinition = {
  id: string;
  name: string;
  kind: Ship['kind'];
  modelId: string;
};
/**
 * Crew voice and default visual pools; allegiance, job behavior and environment theme
 * remain separate.
 */
export type CultureDefinition = {
  id: string;
  name: string;
  radioProfileId: string;
  shipDesigns: Record<Ship['kind'], string[]>;
  /** Optional visual pools for job keys. Gameplay classes and job policies stay independent. */
  roleDesigns?: Record<string, string[]>;
};
/**
 * Data-only topic phrases with placeholders resolved from actual announcement facts; no
 * executable dialogue scripts.
 */
export type RadioProfileDefinition = { id: string; templates: Record<string, string[]> };
