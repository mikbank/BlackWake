import { defaultEnvironmentProfile, validateEnvironmentProfiles } from './environments';
import type {
  EnvironmentProfileDefinition,
  SystemDefinition,
  ThemeDefinition,
  StationSize,
  MarketProfile,
  Commodity,
  CultureDefinition,
  ShipDesignDefinition,
  RadioProfileDefinition,
  RegionDefinition
} from './schema';
/** Check that an authored identifier can safely be used as a stable content key. */
const validId = (id: unknown) => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id);
/**
 * Hold validated world definitions and extension registries; this is content, not a live
 * game session.
 */
export class ContentCatalog {
  spatialVersion = 0;
  defaultEnvironmentId = defaultEnvironmentProfile.id;
  environmentProfiles: Record<string, EnvironmentProfileDefinition> = {
    [defaultEnvironmentProfile.id]: structuredClone(defaultEnvironmentProfile)
  };
  defaultCultureId = '';
  regions: Record<string, RegionDefinition> = {};
  cultures: Record<string, CultureDefinition> = {};
  shipDesigns: Record<string, ShipDesignDefinition> = {};
  radioProfiles: Record<string, RadioProfileDefinition> = {};
  systems: Record<string, SystemDefinition> = {};
  themes: Record<string, ThemeDefinition> = {};
  stationSizes: Record<string, StationSize> = {};
  markets: Record<string, MarketProfile> = {};
  commodities: Record<string, Commodity> = {};
  /**
   * Register an independent copy of a system definition, rejecting duplicate IDs before
   * play.
   */
  addSystem(system: SystemDefinition) {
    if (this.systems[system.id]) throw Error(`Duplicate system: ${system.id}`);
    this.systems[system.id] = structuredClone(system);
  }
  /**
   * Reject broken references, invalid layouts and incompatible designs before the content
   * reaches simulation code.
   */
  validate() {
    if (![0, 1].includes(this.spatialVersion)) throw Error('Invalid spatial content version.');
    validateEnvironmentProfiles(this.environmentProfiles, this.defaultEnvironmentId);
    if (!Object.hasOwn(this.cultures, this.defaultCultureId))
      throw Error('Missing default culture.');
    for (const [id, region] of Object.entries(this.regions))
      if (
        !validId(id) ||
        region.id !== id ||
        typeof region.name !== 'string' ||
        !region.name.trim() ||
        !Object.hasOwn(this.cultures, region.cultureId)
      )
        throw Error('Invalid region definition.');
    for (const [id, design] of Object.entries(this.shipDesigns))
      if (
        design.id !== id ||
        !['cutter', 'merchant'].includes(design.kind) ||
        !design.name ||
        !design.modelId
      )
        throw Error('Invalid ship design.');
    for (const [id, profile] of Object.entries(this.radioProfiles)) {
      if (
        profile.id !== id ||
        !profile.templates ||
        typeof profile.templates !== 'object' ||
        Array.isArray(profile.templates)
      )
        throw Error('Invalid radio profile.');
      for (const variants of Object.values(profile.templates))
        if (
          !Array.isArray(variants) ||
          variants.length < 1 ||
          variants.length > 16 ||
          variants.some(
            /** Reject an empty, non-string or oversized radio phrase before play. */
            (t) => typeof t !== 'string' || !t.trim().length || t.length > 400
          )
        )
          throw Error('Invalid radio phrase variants.');
    }
    for (const [id, culture] of Object.entries(this.cultures)) {
      if (
        culture.id !== id ||
        !culture.name ||
        !Object.hasOwn(this.radioProfiles, culture.radioProfileId)
      )
        throw Error('Invalid culture radio profile.');
      if (culture.roleDesigns !== undefined) {
        if (
          !culture.roleDesigns ||
          typeof culture.roleDesigns !== 'object' ||
          Array.isArray(culture.roleDesigns)
        )
          throw Error('Invalid culture role design pools.');
        for (const [role, choices] of Object.entries(culture.roleDesigns))
          if (
            !validId(role) ||
            !Array.isArray(choices) ||
            !choices.length ||
            choices.some(
              /** Detect a role pool referring to an unregistered hull design. */
              (designId) => !Object.hasOwn(this.shipDesigns, designId)
            )
          )
            throw Error('Invalid culture role design pool.');
      }
      for (const kind of ['cutter', 'merchant'] as const) {
        const choices = culture.shipDesigns?.[kind];
        if (
          !Array.isArray(choices) ||
          !choices.length ||
          choices.some(
            /** Detect an unknown design or a design incompatible with this gameplay class. */
            (designId) =>
              !Object.hasOwn(this.shipDesigns, designId) || this.shipDesigns[designId].kind !== kind
          )
        )
          throw Error('Culture has an invalid ship design pool.');
      }
    }
    for (const commodity of Object.values(this.commodities))
      if (
        !Number.isFinite(commodity.unitSize) ||
        commodity.unitSize <= 0 ||
        (commodity.category !== undefined &&
          (typeof commodity.category !== 'string' || !commodity.category.trim()))
      )
        throw Error('Invalid commodity unit size.');
    for (const size of Object.values(this.stationSizes))
      if (
        !Number.isFinite(size.scale) ||
        size.scale <= 0 ||
        !Number.isFinite(size.dockRadius) ||
        size.dockRadius <= 0
      )
        throw Error('Invalid station size.');
    const globalIds = new Set<string>();
    for (const s of Object.values(this.systems)) {
      if (
        !s.id ||
        (s.regionId !== undefined && !Object.hasOwn(this.regions, s.regionId)) ||
        !Object.hasOwn(this.cultures, s.cultureId) ||
        !this.themes[s.themeId] ||
        (s.environmentId !== undefined &&
          !Object.hasOwn(this.environmentProfiles, s.environmentId)) ||
        !Number.isFinite(s.radius) ||
        s.radius < 100 ||
        !Number.isInteger(s.seed)
      )
        throw Error(`Invalid system ${s.id}`);
      for (const object of [
        ...s.stations,
        ...s.landmarks,
        ...s.gates,
        ...s.traffic.map(
          /** Include each traffic hull when checking global object IDs and positions. */
          (t) => t.ship
        )
      ]) {
        if (!validId(object.id) || globalIds.has(object.id))
          throw Error(`Duplicate object ${object.id}`);
        globalIds.add(object.id);
        if (
          ![object.position.x, object.position.y, object.position.z].every(Number.isFinite) ||
          Math.hypot(object.position.x, object.position.y) > s.radius
        )
          throw Error(`Invalid position ${object.id}`);
      }
      for (const landmark of s.landmarks)
        if (!Number.isFinite(landmark.radius) || landmark.radius <= 0)
          throw Error('Invalid landmark radius.');
      for (const spawn of s.traffic) {
        const ship = spawn.ship;
        if (
          !['cutter', 'merchant'].includes(ship.kind) ||
          typeof ship.name !== 'string' ||
          !ship.name.length ||
          ship.name.length > 80 ||
          typeof ship.owner !== 'string' ||
          typeof ship.factionId !== 'string' ||
          !['idle', 'trader', 'hostile'].includes(ship.role) ||
          !Number.isInteger(ship.crew) ||
          ship.crew < 0 ||
          ![
            ship.heading,
            ship.hull,
            ship.engines,
            ship.crew,
            ship.velocity.x,
            ship.velocity.y,
            ship.velocity.z
          ].every(Number.isFinite) ||
          ship.hull < 0 ||
          ship.hull > 100 ||
          ship.engines < 0 ||
          ship.engines > 100 ||
          !Array.isArray(ship.reload) ||
          ship.reload.length !== 2 ||
          ship.reload.some(
            /** Reject negative or non-finite broadside reload timers. */
            (n) => !Number.isFinite(n) || n < 0
          ) ||
          !ship.cargo ||
          Object.entries(ship.cargo).some(
            /** Reject unknown goods or invalid quantities in an authored cargo manifest. */
            ([id, q]) => !this.commodities[id] || !Number.isInteger(q) || q < 0
          )
        )
          throw Error('Invalid traffic ship definition.');
        if (spawn.cultureId !== undefined && !Object.hasOwn(this.cultures, spawn.cultureId))
          throw Error('Unknown spawn culture.');
        const roleChoices =
          this.cultures[spawn.cultureId ?? s.cultureId].roleDesigns?.[spawn.job.kind];
        if (
          ship.designId === undefined &&
          roleChoices &&
          !roleChoices.some(
            /** Confirm this role pool contains a design for the spawn's gameplay class. */
            (id) => this.shipDesigns[id].kind === ship.kind
          )
        )
          throw Error('Culture role has no compatible hull class.');
        if (
          spawn.ship.designId !== undefined &&
          (!Object.hasOwn(this.shipDesigns, spawn.ship.designId) ||
            this.shipDesigns[spawn.ship.designId].kind !== spawn.ship.kind)
        )
          throw Error('Invalid spawn ship design.');
      }
      for (const station of s.stations) {
        if (!this.stationSizes[station.size]) throw Error(`Unknown station size ${station.size}`);
        const kinds = new Set<string>();
        for (const service of station.services) {
          if (kinds.has(service.kind)) throw Error('Duplicate service');
          kinds.add(service.kind);
        }
      }
      for (const gate of s.gates) {
        if (!Number.isFinite(gate.radius) || gate.radius < 20 || !Array.isArray(gate.connections))
          throw Error('Invalid jump gate.');
        for (const link of gate.connections) {
          if (!validId(link.id) || globalIds.has(link.id))
            throw Error('Duplicate jump connection ID.');
          globalIds.add(link.id);
          if (
            !this.systems[link.systemId]?.gates.some(
              /** Confirm the referenced arrival gate exists in the destination system. */
              (g) => g.id === link.gateId
            )
          )
            throw Error(`Broken jump ${link.id}`);
        }
      }
    }
    for (const market of Object.values(this.markets))
      for (const [id, quote] of Object.entries(market.goods)) {
        if (
          !this.commodities[id] ||
          !Number.isInteger(quote.price) ||
          quote.price <= 0 ||
          !Number.isSafeInteger(quote.price) ||
          (quote.bidPrice !== undefined &&
            (!Number.isSafeInteger(quote.bidPrice) ||
              quote.bidPrice <= 0 ||
              quote.bidPrice > quote.price)) ||
          (quote.buys !== undefined && typeof quote.buys !== 'boolean') ||
          (quote.sells !== undefined && typeof quote.sells !== 'boolean') ||
          !Number.isInteger(quote.stock) ||
          !Number.isSafeInteger(quote.stock) ||
          quote.stock < 0
        )
          throw Error('Invalid market quote');
      }
  }
}
