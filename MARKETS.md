# Markets and trade goods

The shared catalog defines 21 commodities. A station's market profile independently defines which it sells and which it buys. The Buy screen lists local sale offers, including sold-out lines. The Sell screen lists every carried good; cargo without a buyer remains visible with disabled trade controls.

Category filters reduce long lists. Quantity applies to the main trade buttons, while each row's Max button uses its current feasible quantity. Buy limits account for station stock, credits and free hold space; Sell limits use the actual carried quantity. Domain commands repeat the checks rather than trusting disabled browser controls.

## Goods

| Category | Goods |
| --- | --- |
| Essentials | Rations, water, oxygen, medical supplies |
| Agriculture | Grain, algae cultures |
| Industry | Machine parts, drive fuel, metal ore, refined metals, polymers, rare minerals |
| Technology | Electronics, industrial machinery, reactor components, research archives |
| Luxury | Exotic spices, fine spirits, luxury textiles, artwork, jewellery |

Most goods use one hold-space unit each. Ore, refined metals, rare minerals and artwork use two; machinery uses three and reactor components use four. `Commodity.category` and `description` are optional authoring metadata; `unitSize` continues to control trade and boarding capacity.

## Station specializations

Haven exports provisions and buys industrial imports and luxury cargo. Relay exports manufacturing equipment. Lantern Anchorage supplies habitat essentials and research. Lacuna exports minerals, Halcyon agricultural goods, Nacre artisan luxuries, Ilex medical/biological products, Meridian commercial imports, and Brume research and refinery products.

These are content profiles, not new station classes. Two stations can use different assortments without changing the service handler or UI. Existing rations and machine-parts quotes preserve the original Haven–Relay circuit.

## Quote format

```json
{
  "fine-spirits": {"price": 105, "bidPrice": 86, "stock": 24},
  "artwork": {"price": 285, "bidPrice": 285, "stock": 0, "sells": false}
}
```

`price` is what the player pays to buy. `bidPrice` is what the station pays the player. `sells: false` makes an import bid unavailable in Buy, even after the player has sold stock to that station. `buys: false` can mark an export that the station will not purchase from the player. Omitted flags allow that direction; an entirely absent commodity has no local offer. Omitted `bidPrice` retains the legacy single-price behavior. New quotes use spreads, and validation rejects invalid or crossed bid/ask prices.

`marketPrice`, `marketGoods` and `marketLimit` in [services.ts](src/game/services.ts) supply the shared query rules. The command handler validates and commits changes to credits, inventory and station stock. [market.ts](src/ui/market.ts) owns only browser presentation and filter state. Trade results still emit the same optional-activity facts.

## Generation and persistence

Presets can give each good `price`, `bidPrice` and `stock` ranges, an `availability` probability from 0 to 1, and optional `buys`/`sells` flags. Availability uses a stable per-station/per-good random stream, so adding a commodity does not rearrange a system or change another good's generated quote. Existing generated files remain editable and are never silently rebuilt when a preset changes.

Station stock remains keyed by stable station and commodity IDs. Added goods seed only when their stock entry is absent. A saved zero stays zero, and stock accumulated by accepting imports survives reload. Existing cargo and credits retain their values. Save shape remains schema 6; content revision 4 adds initial luxury provisions once to the two established empty liners in older saves, preserving existing manifests and retired/captured actors.

## Luxury liners and freight

Both authored liners carry valuable luxury provisions as ordinary `Ship.cargo`. Contact inspection describes the actual remaining manifest alongside guest counts. Boarding uses the same capacity-aware cargo transfer as any other target; emptied stores do not replenish through touring, saving or loading. Future generated liners provision themselves from catalog goods categorized as Luxury, bounded by hull capacity.

Freighters consider only goods their origin actually offers and the destination accepts. They compare destination bids with origin asks per cargo-space unit, and never load beyond their configured amount, authored supply or hull capacity. Background traffic still uses authored supply rather than consuming the player's persistent market stock. Dynamic production, replenishment and price movement remain separate economic features.
