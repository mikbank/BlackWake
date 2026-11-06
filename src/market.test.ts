import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCatalog, position } from './content/universe';
import { startFreeRoam } from './game/start';
import {
  createServices,
  marketState,
  marketPrice,
  marketLimit,
  marketGoods,
  cargoUsed,
  type MarketContext
} from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { freightPolicy } from './game/traffic/jobs/freight';
import { expandUniverse } from './content/generation/generate';
import { readContent } from '../tools/content-files';
import { marketView } from './ui/market';

/** Create the authored free-roam economy without touching browser storage. */
function game() {
  return startFreeRoam(createCatalog(), createServices(), createActivities(), {
    trafficWarmup: false
  });
}
/** Describe the currently docked market through the same query context as its view. */
function context(g: ReturnType<typeof game>): MarketContext {
  const station = g.station!;
  const spec = station.services.find(
    /** Select the market capability rather than infer services from the station's appearance. */
    (s) => s.kind === 'market'
  )!;
  return {
    catalog: g.catalog,
    station,
    spec,
    ship: g.world.player,
    captain: g.captain,
    markets: g.markets
  };
}
/** Enter a named market through real jump and dock commands, bypassing only approach travel time. */
function dockAt(g: ReturnType<typeof game>, systemId: string) {
  if (g.dockedAt) g.dispatch({ type: 'undock' });
  while (g.systemId !== systemId) {
    const hop = g.routes.find(g.systemId, systemId)!.hops[0];
    g.world.player.position = { ...g.gateById(hop.gateId)!.position };
    g.world.player.velocity = position(0, 0);
    assert.ok(g.dispatch({ type: 'jump', connectionId: hop.connectionId }).ok);
    finishTransit(g);
  }
  g.world.player.position = { ...g.definition.stations[0].position };
  assert.ok(g.dispatch({ type: 'dock', stationId: g.definition.stations[0].id }).ok);
}
/** Route every economic mutation through the station service boundary under test. */
function trade(
  g: ReturnType<typeof game>,
  direction: 'buy' | 'sell',
  commodityId: string,
  quantity: number
) {
  return g.dispatch({
    type: 'service',
    kind: 'market',
    payload: { direction, commodityId, quantity }
  });
}

/** Verify the shared catalog grew while each station still advertises a limited local assortment. */
test('twenty-one goods are categorized and station sale assortments differ', () => {
  const g = game(),
    c = g.catalog;
  assert.equal(Object.keys(c.commodities).length, 21);
  const assortments = new Set<string>();
  for (const profile of Object.values(c.markets)) {
    const ids = Object.keys(profile.goods).filter(
      /** Count sale offers rather than import bids. */
      (id) => marketPrice(profile, id, 'buy') !== null
    );
    assert.ok(ids.length >= 5 && ids.length < 21);
    assortments.add(ids.sort().join(','));
  }
  assert.ok(assortments.size >= 8);
  assert.ok(c.commodities.machinery.unitSize > 1);
  assert.equal(c.commodities.artwork.category, 'Luxury');
});

/** Verify import bids never become Buy entries and unsupported owned goods remain visible in Sell. */
test('buy and sell lists represent station offers and actual cargo independently', () => {
  const g = game(),
    ctx = context(g),
    profile = g.catalog.markets.haven;
  g.world.player.cargo = { 'fine-spirits': 2, ore: 1 };
  assert.ok(!marketGoods(ctx, 'buy').includes('fine-spirits'));
  assert.deepEqual(marketGoods(ctx, 'sell').sort(), ['fine-spirits', 'ore']);
  assert.equal(marketPrice(profile, 'fine-spirits', 'sell'), 115);
  assert.equal(marketPrice(profile, 'ore', 'sell'), null);
  assert.ok(trade(g, 'sell', 'fine-spirits', 1).ok);
  assert.equal(g.markets.haven.stock['fine-spirits'], 1);
  assert.ok(!marketGoods(ctx, 'buy').includes('fine-spirits'));
  assert.equal(trade(g, 'buy', 'fine-spirits', 1).ok, false);
  assert.equal(trade(g, 'sell', 'ore', 1).ok, false);
  assert.equal(g.world.player.cargo.ore, 1);
});

/** Verify the real market renderer exposes separate direction controls and omits import-only goods from shopping. */
test('market markup has dedicated buy and sell controls and useful capacity information', () => {
  const html = marketView.render(game());
  assert.match(html, /id="market-buy"/);
  assert.match(html, /id="market-sell"/);
  assert.match(html, /data-trade="buy"/);
  assert.doesNotMatch(html, /data-trade="sell"/);
  assert.match(html, /id="market-category"/);
  assert.match(html, /data-limit=/);
  assert.doesNotMatch(html, /data-good="fine-spirits"/);
});

/** Verify separated bid/ask prices prevent a same-station credit loop and respect cargo limits. */
test('new quotes have a spread and maximum quantities respect funds, stock and unit sizes', () => {
  const g = game(),
    ctx = context(g),
    profile = g.catalog.markets.haven;
  const before = g.captain.credits;
  assert.ok(trade(g, 'buy', 'water', 2).ok);
  assert.ok(trade(g, 'sell', 'water', 2).ok);
  assert.ok(g.captain.credits < before);
  g.world.player.cargo = { rations: 19 };
  g.captain.credits = 10000;
  assert.equal(marketLimit(ctx, 'water', 'buy'), 1);
  g.world.player.cargo = { rations: 20 };
  assert.equal(marketLimit(ctx, 'water', 'buy'), 0);
  g.world.player.cargo = {};
  g.captain.credits = 4;
  assert.equal(marketLimit(ctx, 'water', 'buy'), 0);
  assert.equal(marketPrice(profile, 'water', 'buy'), 5);
});

/** Verify the two original trade quotes remain compatible while a new luxury route can earn money. */
test('original route prices survive and artisan luxury exports can be sold at an importing hub', () => {
  const g = game();
  assert.equal(g.catalog.markets.haven.goods.rations.price, 12);
  assert.equal(marketPrice(g.catalog.markets.relay, 'rations', 'sell'), 22);
  assert.equal(marketPrice(g.catalog.markets.haven, 'parts', 'sell'), 45);
  dockAt(g, 'drift-003');
  assert.ok(trade(g, 'buy', 'artwork', 2).ok);
  assert.equal(cargoUsed(g.world.player, g.catalog), 4);
  dockAt(g, 'drift-005');
  assert.ok(trade(g, 'sell', 'artwork', 2).ok);
  assert.equal(g.captain.credits, 770);
});

/** Verify rejected quantities and unaffordable operations do not change economic records. */
test('invalid transactions leave credits, cargo and stock intact', () => {
  const g = game(),
    ctx = context(g);
  marketState(ctx);
  const before = JSON.parse(g.save());
  for (const [id, q] of [
    ['water', -1],
    ['water', 1.5],
    ['water', Number.MAX_SAFE_INTEGER],
    ['artwork', 1],
    ['water', 1000]
  ] as const)
    assert.equal(trade(g, 'buy', id, q).ok, false);
  assert.equal(trade(g, 'sell', 'water', 1).ok, false);
  assert.deepEqual(JSON.parse(g.save()), before);
});

/** Verify new assortment seeding does not refill spent legacy goods or reset accumulated import stock. */
test('market stock and new cargo survive reload without replenishing existing quantities', () => {
  let g = game();
  g.markets.haven = { stock: { rations: 0, parts: 7, 'fine-spirits': 3 } };
  const state = marketState(context(g));
  assert.equal(state.stock.rations, 0);
  assert.equal(state.stock.water, 55);
  assert.equal(state.stock['fine-spirits'], 3);
  assert.ok(trade(g, 'buy', 'water', 3).ok);
  g = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(g.markets.haven.stock.water, 52);
  assert.equal(g.world.player.cargo.water, 3);
  assert.equal(marketState(context(g)).stock.rations, 0);
});

/** Verify both cultures' leisure liners carry actual valuable goods and depleted stores do not regenerate. */
test('luxury supplies are real boardable cargo and a raided liner stays depleted across save and time', () => {
  let g = game();
  for (const id of ['ashen-liner', 'aster-commonlight']) {
    const a = g.traffic.get(id)!;
    assert.ok(cargoUsed(a.ship, g.catalog) > 0);
    assert.ok(cargoUsed(a.ship, g.catalog) <= 60);
    for (const good of Object.keys(a.ship.cargo))
      assert.equal(g.catalog.commodities[good].category, 'Luxury');
  }
  g.dispatch({ type: 'undock' });
  const a = g.traffic.get('ashen-liner')!;
  a.ship.engines = 0;
  a.ship.position = position(g.world.player.position.x + 80, g.world.player.position.y);
  a.ship.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'board', shipId: a.ship.id, outcome: 'cargo' }).ok);
  assert.equal(cargoUsed(a.ship, g.catalog), 0);
  g = loadSession(g.save(), g.catalog, g.services, g.activities);
  for (let i = 0; i < 3600; i++) g.step(1 / 60, { turn: 0, thrust: 0, brake: true, fire: false });
  assert.equal(cargoUsed(g.traffic.get(a.ship.id)!.ship, g.catalog), 0);
  assert.equal(g.world.player.id, 'wayward');
  assert.ok(cargoUsed(g.world.player, g.catalog) > 0);
});

/** Verify old empty liners receive initial supplies once while captured and customized holds are preserved. */
test('content revision four seeds legacy liners without replacing custom or retired cargo', () => {
  const g = game(),
    raw = JSON.parse(g.save());
  raw.contentVersion = 3;
  raw.markets.haven = { stock: { rations: 0, parts: 17 } };
  const first = raw.traffic.find(
    /** Pick the original liner whose pre-market-overhaul inventory was empty. */
    (a: any) => a.ship.id === 'ashen-liner'
  );
  first.ship.cargo = {};
  const other = raw.traffic.find(
    /** Preserve a genuinely customized manifest on the other culture's liner. */
    (a: any) => a.ship.id === 'aster-commonlight'
  );
  other.ship.cargo = { rations: 2 };
  const loaded = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.ok(loaded.traffic.get(first.ship.id)!.ship.cargo['fine-spirits'] > 0);
  assert.deepEqual(loaded.traffic.get(other.ship.id)!.ship.cargo, { rations: 2 });
  assert.equal(marketState(context(loaded)).stock.rations, 0);
  first.ship.owner = 'salvage';
  first.motion = { kind: 'captured', systemId: 'ashen' };
  const retired = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.deepEqual(retired.traffic.get(first.ship.id)!.ship.cargo, {});
});

/** Verify freight planning uses permitted exports and destination bids, not nonexistent import stock or ask prices. */
test('freight cargo respects market direction, authored supply and bulk hold space', () => {
  const g = game();
  g.catalog.markets.haven.goods = {
    ore: { price: 10, bidPrice: 8, stock: 2 },
    artwork: { price: 100, bidPrice: 90, stock: 20, sells: false },
    medicine: { price: 10, stock: 0 }
  };
  g.catalog.markets.relay.goods = {
    ore: { price: 20, bidPrice: 15, stock: 0, sells: false },
    artwork: { price: 500, stock: 20 },
    medicine: { price: 100, stock: 20 }
  };
  const a = g.traffic.get('ashen-trader')!;
  freightPolicy.next(
    {
      catalog: g.catalog,
      ship: a.ship,
      homeSystemId: 'ashen',
      systemId: 'ashen',
      now: 0,
      ships: g.world.ships,
      active: true
    },
    {
      route: [
        { systemId: 'ashen', stationId: 'haven' },
        { systemId: 'kepler', stationId: 'relay' }
      ],
      quantity: 12,
      loadingSeconds: 4,
      unloadingSeconds: 4
    },
    { origin: 0, next: 'depart' }
  );
  assert.deepEqual(a.ship.cargo, { ore: 2 });
});

/** Verify seeded station assortments vary reproducibly and future generated liners receive luxury inventory. */
test('generation supports optional goods and supplies new leisure liners from the commodity catalog', () => {
  const source = readContent('content');
  const presets = JSON.parse(readFileSync('content/presets.json', 'utf8'));
  presets.presets.frontier.traffic = [
    { kind: 'liner', shipKind: 'merchant', owner: 'civilian', factionId: 'guild', count: 1 }
  ];
  const spec = {
    schemaVersion: 1,
    systems: [
      {
        id: 'market-test',
        name: 'Market Test',
        seed: 514,
        preset: 'frontier',
        regionId: 'lantern-marches',
        chart: { x: 4, y: 4 }
      }
    ],
    connections: [{ from: 'vesper', to: 'market-test' }]
  };
  const a = expandUniverse(source, spec, presets),
    b = expandUniverse(source, spec, presets);
  assert.deepEqual(a.bundle, b.bundle);
  const system = a.bundle.systems.find(
    /** Resolve the new generated system without relying on catalog insertion order. */
    (s) => s.id === 'market-test'
  )!;
  assert.ok(Object.keys(system.traffic[0].ship.cargo).length >= 4);
  const profile = a.bundle.definition.markets['market-test-station-1-market'];
  assert.ok(Object.keys(profile.goods).length < 21);
  assert.ok(profile.goods.rations && profile.goods.parts);
});

/** Verify the actual Buy/Sell controls change presentation without committing a trade or hiding unwanted cargo. */
test('market tab handlers render owned cargo and unsupported goods without changing the session', () => {
  const g = game();
  g.world.player.cargo = { 'fine-spirits': 2, ore: 1 };
  marketView.render(g);
  const before = g.save();
  const previous = globalThis.document;
  const nodes = new Map<
    string,
    { onclick?: () => void; onchange?: () => void; oninput?: () => void; value: string }
  >();
  for (const id of ['market-buy', 'market-sell', 'market-category', 'trade-quantity'])
    nodes.set(id, { value: '1' });
  globalThis.document = {
    /** Supply only the element lookup capability used to bind this component's controls. */
    getElementById(id: string) {
      return nodes.get(id);
    },
    /** No trade buttons are invoked here; this scenario isolates direction switching. */
    querySelectorAll() {
      return [];
    }
  } as unknown as Document;
  let refreshes = 0;
  try {
    marketView.bind(
      g,
      /** Observe requested menu refreshes while leaving persistence and domain state untouched. */
      () => {
        refreshes++;
      }
    );
    nodes.get('market-sell')!.onclick!();
    const html = marketView.render(g);
    assert.match(html, /data-trade="sell"/);
    assert.match(html, /data-good="fine-spirits"/);
    assert.match(html, /data-good="ore"/);
    assert.match(html, /Not accepted at this station/);
    assert.doesNotMatch(html, /data-trade="buy"/);
    assert.equal(refreshes, 1);
    assert.equal(g.save(), before);
  } finally {
    nodes.get('market-buy')!.onclick!();
    globalThis.document = previous;
  }
});
