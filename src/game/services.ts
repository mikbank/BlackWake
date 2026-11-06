import { definitions, type Ship } from '../core/model';
import type { ContentCatalog } from '../content/catalog';
import type { StationDefinition, StationService, MarketProfile } from '../content/schema';
export type TradeDirection = 'buy' | 'sell';
export type Captain = { cultureId: string; credits: number; controlledShipId: string };
export type MarketState = { stock: Record<string, number> };
/** Restricted market context shared by quote previews and the validated command handler. */
export type MarketContext = Pick<
  ServiceContext,
  'catalog' | 'spec' | 'station' | 'markets' | 'ship' | 'captain'
>;
export type ServiceResult = {
  ok: boolean;
  message: string;
  trade?: {
    stationId: string;
    commodityId: string;
    direction: 'buy' | 'sell';
    quantity: number;
    total: number;
  };
};
/**
 * Restricted state and capabilities supplied to a station operation, including the
 * validated hull-exchange callback.
 */
export type ServiceContext = {
  captain: Captain;
  ship: Ship;
  station: StationDefinition;
  spec: StationService;
  catalog: ContentCatalog;
  markets: Record<string, MarketState>;
  /**
   * Request a validated docked hull exchange through the session; a service cannot replace
   * world ownership directly.
   */
  replaceControlledShip: (replacement: Ship) => ServiceResult;
};
/**
 * Domain capability registered by kind and selected by station content; presentation is
 * registered separately.
 */
export type ServiceHandler = {
  kind: string;
  title: string;
  /** Optionally reject invalid authored settings before the station capability is offered. */
  validate?: (config: Record<string, unknown>, catalog: ContentCatalog) => void;
  /**
   * Validate and perform a service request, returning a player-visible result and optional
   * completed-trade fact.
   */
  execute: (ctx: ServiceContext, payload: Record<string, unknown>) => ServiceResult;
};
/**
 * Register station capabilities independently of station size, visual model and
 * environment theme.
 */
export class ServiceRegistry {
  readonly handlers = new Map<string, ServiceHandler>();
  /**
   * Add a uniquely named service implementation; authored stations opt in through their
   * service definitions.
   */
  register(handler: ServiceHandler) {
    if (this.handlers.has(handler.kind)) throw Error(`Duplicate service ${handler.kind}`);
    this.handlers.set(handler.kind, handler);
  }
  /**
   * Run each registered service's configuration checks across all authored stations before
   * play.
   */
  validate(catalog: ContentCatalog) {
    for (const system of Object.values(catalog.systems))
      for (const station of system.stations)
        for (const spec of station.services)
          this.handlers.get(spec.kind)?.validate?.(spec.config, catalog);
  }
  /**
   * List only station services with an installed implementation, leaving future capabilities
   * safely undisplayed.
   */
  available(station: StationDefinition) {
    return station.services.filter(
      /** Expose only station capabilities with a registered domain implementation. */
      (s) => this.handlers.has(s.kind)
    );
  }
}
/** Calculate occupied hold space from quantities and per-commodity unit sizes. */
export function cargoUsed(ship: Ship, catalog: ContentCatalog) {
  return Object.entries(ship.cargo).reduce(
    /** Accumulate cargo space using each commodity's quantity and per-unit size. */
    (sum, [id, quantity]) => sum + quantity * (catalog.commodities[id]?.unitSize ?? 1),
    0
  );
}
/**
 * Return persistent stock for this station, seeding newly introduced goods without
 * resetting existing stock.
 */
export function marketState(ctx: Pick<ServiceContext, 'catalog' | 'spec' | 'station' | 'markets'>) {
  const profile = ctx.catalog.markets[String(ctx.spec.config.profileId)];
  if (!profile) throw Error('Missing market profile');
  const state = (ctx.markets[ctx.station.id] ??= { stock: {} });
  for (const [id, item] of Object.entries(profile.goods))
    if (state.stock[id] === undefined) state.stock[id] = item.stock;
  return state;
}
/** Resolve a permitted player-facing price; absent offers never become implicit buyers. */
export function marketPrice(
  profile: MarketProfile,
  id: string,
  direction: TradeDirection
): number | null {
  if (!Object.hasOwn(profile.goods, id)) return null;
  const quote = profile.goods[id];
  if (direction === 'buy') return quote.sells === false ? null : quote.price;
  return quote.buys === false ? null : (quote.bidPrice ?? quote.price);
}
/** Buy lists local sale offers; Sell lists all carried cargo, including goods without a local buyer. */
export function marketGoods(ctx: MarketContext, direction: TradeDirection) {
  const profile = ctx.catalog.markets[String(ctx.spec.config.profileId)];
  return direction === 'buy'
    ? Object.keys(profile.goods).filter(
        /** Import bids are not stock offered for purchase, even after a player sells some here. */
        (id) => marketPrice(profile, id, 'buy') !== null
      )
    : Object.keys(ctx.ship.cargo).filter(
        /** Retain unsupported goods in the cargo list so station preferences never hide inventory. */
        (id) => ctx.ship.cargo[id] > 0
      );
}
/** Calculate the most the player can trade now, respecting inventory, funds and cargo sizes. */
export function marketLimit(ctx: MarketContext, id: string, direction: TradeDirection) {
  const profile = ctx.catalog.markets[String(ctx.spec.config.profileId)];
  const price = profile && marketPrice(profile, id, direction);
  const commodity = ctx.catalog.commodities[id];
  if (price == null || !commodity) return 0;
  if (direction === 'sell') return ctx.ship.cargo[id] ?? 0;
  const stock = marketState(ctx);
  return Math.max(
    0,
    Math.min(
      stock.stock[id] ?? 0,
      Math.floor(ctx.captain.credits / price),
      Math.floor(
        (definitions[ctx.ship.kind].cargoCapacity - cargoUsed(ctx.ship, ctx.catalog)) /
          commodity.unitSize
      )
    )
  );
}
/** Return a rejected service result without mutating credits, stock or ship state. */
const fail = (message: string): ServiceResult => ({ ok: false, message });
/**
 * Register market trading and repair capabilities, keeping their validation and state
 * changes behind the service boundary.
 */
export function createServices() {
  const services = new ServiceRegistry();
  services.register({
    kind: 'market',
    title: 'Commodity market',
    /** Require the market service to reference a registered price-and-stock profile. */
    validate(config, catalog) {
      if (!catalog.markets[String(config.profileId)]) throw Error('Unknown market profile');
    },
    /**
     * Validate and commit a buy or sell operation across credits, ship cargo and station
     * stock, returning a trade fact on success.
     */
    execute(ctx, payload) {
      const id = String(payload.commodityId),
        direction = payload.direction,
        quantity = payload.quantity;
      if (
        (direction !== 'buy' && direction !== 'sell') ||
        !Number.isInteger(quantity) ||
        Number(quantity) <= 0
      )
        return fail('Choose a positive whole quantity.');
      const q = Number(quantity),
        profile = ctx.catalog.markets[String(ctx.spec.config.profileId)],
        price = profile && marketPrice(profile, id, direction),
        commodity = ctx.catalog.commodities[id];
      if (price == null || !commodity)
        return fail(
          direction === 'sell'
            ? 'This station does not buy that commodity.'
            : 'This station does not sell that commodity.'
        );
      const stock = marketState(ctx),
        total = price * q,
        owned = ctx.ship.cargo[id] ?? 0;
      if (!Number.isSafeInteger(total)) return fail('Quantity is too large.');
      if (direction === 'buy') {
        if ((stock.stock[id] ?? 0) < q) return fail('The market does not have that much stock.');
        if (ctx.captain.credits < total) return fail('Not enough credits.');
        if (
          cargoUsed(ctx.ship, ctx.catalog) + q * commodity.unitSize >
          definitions[ctx.ship.kind].cargoCapacity
        )
          return fail('Not enough cargo space.');
        ctx.captain.credits -= total;
        ctx.ship.cargo[id] = owned + q;
        stock.stock[id] -= q;
      } else {
        if (!Number.isSafeInteger(ctx.captain.credits + total))
          return fail('Credit total is too large.');
        if (owned < q) return fail('You do not carry that much cargo.');
        if (!Number.isSafeInteger((stock.stock[id] ?? 0) + q))
          return fail('The market cannot accept that quantity.');
        ctx.captain.credits += total;
        ctx.ship.cargo[id] = owned - q;
        stock.stock[id] = (stock.stock[id] ?? 0) + q;
      }
      return {
        ok: true,
        message: `${direction === 'buy' ? 'Bought' : 'Sold'} ${q} ${commodity.name.toLowerCase()} for ${total} cr.`,
        trade: { stationId: ctx.station.id, commodityId: id, direction, quantity: q, total }
      };
    }
  });
  services.register({
    kind: 'repair',
    title: 'Repair dock',
    /** Require the repair service's per-point price to be finite and nonnegative. */
    validate(config) {
      if (!Number.isFinite(config.pricePerPoint) || Number(config.pricePerPoint) < 0)
        throw Error('Invalid repair rate');
    },
    /**
     * Charge for missing hull and engine points and repair both systems only when funds and
     * configuration permit it.
     */
    execute(ctx) {
      const rate = Number(ctx.spec.config.pricePerPoint);
      if (!Number.isFinite(rate) || rate < 0) return fail('Repair service is unavailable.');
      const cost = Math.ceil((100 - ctx.ship.hull + 100 - ctx.ship.engines) * rate);
      if (cost === 0) return fail('Your ship is already fully repaired.');
      if (ctx.captain.credits < cost) return fail(`Repairs require ${cost} cr.`);
      ctx.captain.credits -= cost;
      ctx.ship.hull = 100;
      ctx.ship.engines = 100;
      return { ok: true, message: `Hull and engines repaired for ${cost} cr.` };
    }
  });
  return services;
}
