import { marketPrice } from '../../services';
import { definitions, type Ship } from '../../../core/model';
import type { ContentCatalog } from '../../../content/catalog';
import type { Port } from '../model';
/** Read one validated market endpoint through its service configuration. */
export function freightMarket(catalog: ContentCatalog, port: Port) {
  const market = catalog.systems[port.systemId]?.stations
    .find(
      /** Resolve the station without inferring commerce from visual size or ownership. */ (
        station
      ) => station.id === port.stationId
    )
    ?.services.find(
      /** Select the actual market capability. */ (service) => service.kind === 'market'
    );
  if (!market || !catalog.markets[String(market.config.profileId)])
    throw Error('Freight port needs a market.');
  return catalog.markets[String(market.config.profileId)];
}
/** Rank genuine exports accepted at the destination by bid-minus-ask per cargo-space unit. */
export function freightGoods(catalog: ContentCatalog, origin: Port, destination: Port) {
  const from = freightMarket(catalog, origin),
    to = freightMarket(catalog, destination);
  return Object.keys(from.goods)
    .filter(
      /** Never invent stock, export import-only goods, or deliver unsupported cargo. */ (id) =>
        marketPrice(from, id, 'buy') !== null &&
        marketPrice(to, id, 'sell') !== null &&
        from.goods[id].stock > 0
    )
    .sort(
      /** Select useful manifests consistently; destination randomization is a separate decision. */ (
        a,
        b
      ) =>
        (marketPrice(to, b, 'sell')! - marketPrice(from, b, 'buy')!) /
          catalog.commodities[b].unitSize -
        (marketPrice(to, a, 'sell')! - marketPrice(from, a, 'buy')!) /
          catalog.commodities[a].unitSize
    );
}
/** Load the actual hold for an assigned delivery; background traffic does not mutate player market stocks. */
export function loadFreight(
  ship: Ship,
  catalog: ContentCatalog,
  origin: Port,
  destination: Port,
  quantity: number
) {
  const good = freightGoods(catalog, origin, destination)[0],
    from = freightMarket(catalog, origin);
  ship.cargo = good
    ? {
        [good]: Math.min(
          quantity,
          from.goods[good].stock,
          Math.floor(definitions[ship.kind].cargoCapacity / catalog.commodities[good].unitSize)
        )
      }
    : {};
}
/** Describe the real carried manifest for contact details and culture-specific departure chatter. */
export function freightManifest(ship: Ship, catalog: ContentCatalog, empty = 'Awaiting cargo') {
  return (
    Object.entries(ship.cargo)
      .filter(/** Omit depleted inventory entries. */ ([, quantity]) => quantity > 0)
      .map(
        /** Resolve commodity names from the shared catalog rather than storing stale display text. */ ([
          id,
          quantity
        ]) => `${quantity} ${catalog.commodities[id].name}`
      )
      .join(' · ') || empty
  );
}
