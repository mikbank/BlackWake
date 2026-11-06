import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCatalog, makeShip, position } from './content/universe';
import { RouteResolver } from './content/routes';
import { expandUniverse } from './content/generation/generate';
import { readContent } from '../tools/content-files';
import { catalogFromData } from './content/data';
import { startFreeRoam } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { createTrafficJobs } from './game/traffic/jobs';
import { longHaulPolicy, type LongHaulState } from './game/traffic/jobs/long-haul';
import { linerPolicy, type RoamingLinerState } from './game/traffic/jobs/liner';
import { chooseDestination, marketPorts, readDestinationMemory } from './game/traffic/destinations';
import { freightGoods } from './game/traffic/jobs/freight-cargo';
import type { Destination, JobContext, TrafficActor } from './game/traffic/model';

/** Create an isolated purpose context using the same catalog and access resolver as navigation. */
function context(): JobContext {
  const catalog = createCatalog();
  return {
    catalog,
    routes: new RouteResolver(catalog),
    ship: makeShip('roaming-test', 'Test', 'merchant', 'guild', 0, 0),
    homeSystemId: 'ashen',
    systemId: 'ashen',
    now: 0,
    ships: [],
    active: false
  };
}
/** Enumerate station destinations without introducing duplicate synthetic ports. */
function markets(ctx: JobContext): Destination[] {
  return marketPorts(ctx.catalog).map(
    /** Adapt actual market capabilities to generic travel destinations. */ (p) => ({
      kind: 'station',
      ...p
    })
  );
}
/** Create the production free-roam fleet for lifecycle and snapshot tests. */
function game() {
  return startFreeRoam(createCatalog(), createServices(), createActivities(), {
    trafficWarmup: false
  });
}
/**
 * Advance the real controller/navigation to one actor's next motion boundary. Active-flight
 * arrival is placed explicitly to avoid spending minutes testing already covered steering.
 * Background legs, gateway charging, transit and policy decisions use their actual deadlines.
 */
function boundary(g: ReturnType<typeof game>, actor: TrafficActor) {
  const m = actor.motion;
  let now = g.clock + 1 / 60;
  if (m.kind === 'flight') {
    if (m.systemId === g.systemId) {
      actor.ship.position = { ...m.leg.to };
      actor.ship.velocity = position(0, 0);
    } else now = Math.max(now, m.leg.arriveAt);
  } else if (m.kind === 'waiting' || m.kind === 'charging' || m.kind === 'transit')
    now = Math.max(now, m.until);
  else if (m.kind === 'awaiting-route') now = Math.max(now, m.retryAt);
  g.clock = now;
  g.traffic.advance(now, 1 / 60, g.world, g.systemId);
  return g.traffic.events;
}
/** Reach a named execution state while failing clearly if a job stalls or never visits it. */
function reach(g: ReturnType<typeof game>, a: TrafficActor, kind: TrafficActor['motion']['kind']) {
  for (let i = 0; i < 150 && a.motion.kind !== kind; i++) boundary(g, a);
  assert.equal(a.motion.kind, kind);
}

/** Check seeded selection is independent of candidate order, inspection and save decoding. */
test('destination draws are reproducible and serialized memory is read without rerolling', () => {
  const ctx = context(),
    memory = { decision: 8, recentSystems: ['ashen'] };
  const choice = chooseDestination(ctx, memory, markets(ctx), 2)!;
  assert.deepEqual(choice, chooseDestination(ctx, memory, markets(ctx).reverse(), 2));
  assert.deepEqual(memory, { decision: 8, recentSystems: ['ashen'] });
  assert.deepEqual(readDestinationMemory(choice, ctx.catalog), {
    decision: 9,
    recentSystems: choice.recentSystems
  });
  assert.ok(ctx.routes!.find('ashen', choice.destination.systemId)!.hops.length >= 2);
  const systems = new Set<string>();
  for (let decision = 0; decision < 200; decision++)
    systems.add(
      chooseDestination(ctx, { ...memory, decision }, markets(ctx), 2)!.destination.systemId
    );
  assert.ok(
    systems.size >= 4,
    'decisions should explore the network rather than one fixed distant port'
  );
});

/** Respect closures and recent history while still functioning in a two-system universe. */
test('destination choices avoid recent systems and obey the current connection access policy', () => {
  const ctx = context();
  ctx.routes!.policy = /** Restrict this fixture to the original two-system corridor. */ (hop) => ({
    allowed: hop.toSystemId === 'ashen' || hop.toSystemId === 'kepler'
  });
  const memory = { decision: 0, recentSystems: ['ashen', 'kepler'] };
  assert.equal(chooseDestination(ctx, memory, markets(ctx), 2)!.destination.systemId, 'kepler');
  ctx.routes!.policy = /** Close every outbound route without changing catalog content. */ () => ({
    allowed: false,
    reason: 'Closed'
  });
  assert.equal(chooseDestination(ctx, memory, markets(ctx)), undefined);
  assert.equal(memory.decision, 0);
  ctx.routes!.policy = /** Restore the network for a history-avoidance check. */ () => ({
    allowed: true
  });
  const first = chooseDestination(ctx, { decision: 0, recentSystems: ['ashen'] }, markets(ctx))!;
  const second = chooseDestination(ctx, first, markets(ctx))!;
  assert.notEqual(second.destination.systemId, first.destination.systemId);
});

/** Preserve safe integer decoding even at the counter's serialized upper boundary. */
test('destination memory rejects corrupt history and keeps extreme counters restorable', () => {
  const ctx = context();
  assert.throws(
    /** Reject a save referring to nonexistent history. */ () =>
      readDestinationMemory({ decision: 0, recentSystems: ['missing'] }, ctx.catalog)
  );
  assert.throws(
    /** Reject a fractional saved draw counter. */ () =>
      readDestinationMemory({ decision: 0.5, recentSystems: [] }, ctx.catalog)
  );
  const choice = chooseDestination(
    ctx,
    { decision: Number.MAX_SAFE_INTEGER, recentSystems: [] },
    markets(ctx)
  )!;
  assert.equal(readDestinationMemory(choice, ctx.catalog).decision, 0);
});

/** Verify delivery planning, actual exports, unloading and a new departure origin through policy contracts. */
test('long-haul freight commits a delivery, carries real cargo and plans again only after unloading', () => {
  const ctx = context(),
    config = longHaulPolicy.readConfig(
      { home: { systemId: 'ashen', stationId: 'haven' } },
      ctx.catalog
    );
  const initial = longHaulPolicy.create(ctx, config);
  const loading = longHaulPolicy.next(ctx, config, initial);
  assert.equal(loading.action.kind, 'wait');
  assert.equal(loading.state.decision, 1);
  const target = loading.state.destination!;
  const departure = longHaulPolicy.next(ctx, config, loading.state);
  assert.equal(departure.action.kind, 'travel');
  assert.equal(departure.state.decision, 1);
  assert.deepEqual(departure.state.destination, target);
  assert.ok(Object.keys(ctx.ship.cargo).length > 0);
  for (const good of Object.keys(ctx.ship.cargo))
    assert.ok(freightGoods(ctx.catalog, config.home, target).includes(good));
  ctx.systemId = target.systemId;
  const unloading = longHaulPolicy.next(ctx, config, departure.state);
  assert.equal(unloading.state.decision, 1);
  const complete = longHaulPolicy.next(ctx, config, unloading.state);
  assert.equal(complete.completedJourney, true);
  assert.deepEqual(ctx.ship.cargo, {});
  assert.deepEqual(complete.state.origin, target);
  assert.equal(complete.state.decision, 2);
  assert.notEqual(complete.state.destination!.systemId, target.systemId);
});

/** Make an inaccessible compatible trade fall back to an open repositioning port without inventing cargo. */
test('long-haul ships reposition when open ports have no compatible exports, and wait when all routes close', () => {
  const ctx = context(),
    config = longHaulPolicy.readConfig(
      { home: { systemId: 'ashen', stationId: 'haven' } },
      ctx.catalog
    );
  const original = structuredClone(ctx.catalog.markets);
  for (const market of Object.values(ctx.catalog.markets)) market.goods = {};
  // Keep export-compatible markets outside the only open corridor. Kepler stays empty.
  for (const system of Object.values(ctx.catalog.systems))
    if (system.id !== 'kepler')
      for (const station of system.stations)
        for (const service of station.services)
          if (service.kind === 'market')
            ctx.catalog.markets[String(service.config.profileId)] =
              original[String(service.config.profileId)];
  ctx.routes!.policy =
    /** Leave an empty receiving market reachable while compatible markets are closed. */ (
      hop
    ) => ({ allowed: hop.toSystemId === 'ashen' || hop.toSystemId === 'kepler' });
  const state = longHaulPolicy.create(ctx, config);
  const loading = longHaulPolicy.next(ctx, config, state);
  assert.ok(loading.state.destination);
  assert.equal(loading.state.destination.systemId, 'kepler');
  longHaulPolicy.next(ctx, config, loading.state);
  assert.deepEqual(ctx.ship.cargo, {});
  ctx.routes!.policy = /** Model a temporary complete closure of the home system. */ () => ({
    allowed: false,
    reason: 'Closed'
  });
  const blocked = longHaulPolicy.next(ctx, config, state);
  assert.equal(blocked.state.decision, 0);
  assert.equal(blocked.state.destination, null);
  assert.match(blocked.action.activity, /Waiting/);
});

/** Confirm visits, interrupted motion and reloads preserve the chosen job and next random decision. */
test('long-haul journeys survive multi-hop transfers, interruption and reload without destination changes', () => {
  let g = game();
  let a = g.traffic.get('aster-cradle')!;
  reach(g, a, 'flight');
  const planned = structuredClone(a.job),
    identity = { culture: a.cultureId, design: a.ship.designId };
  g.traffic.navigation.interrupt(a, 'interrupted', g.clock);
  const saved = g.save();
  g = loadSession(saved, g.catalog, g.services, g.activities);
  a = g.traffic.get(a.ship.id)!;
  assert.equal(a.motion.kind, 'interrupted');
  assert.deepEqual(a.job, planned);
  let transfer = false;
  for (let i = 0; i < 100 && a.journeys < 1; i++) {
    const events = boundary(g, a);
    transfer ||= events.some(
      /** Observe a real intermediate transfer rather than a fabricated policy stop. */ (e) =>
        e.actorId === a.ship.id && e.topic === 'navigation.transfer'
    );
    if (a.journeys === 0) {
      const state = a.job.state as LongHaulState,
        committed = planned.state as LongHaulState;
      assert.deepEqual(state.destination, committed.destination);
      assert.equal(state.decision, committed.decision);
    }
  }
  // The unloading phase changes next but must retain the delivery target and draw counter.
  assert.equal(a.journeys, 1);
  assert.equal((a.job.state as LongHaulState).decision, 2);
  assert.deepEqual({ culture: a.cultureId, design: a.ship.designId }, identity);
  assert.ok(transfer);
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities),
    copy = restored.traffic.get(a.ship.id)!;
  for (let i = 0; i < 100 && a.journeys < 2; i++) {
    boundary(g, a);
    boundary(restored, copy);
  }
  assert.equal(a.journeys, 2);
  assert.deepEqual(copy.job, a.job);
  assert.deepEqual(copy.motion, a.motion);
});

/** Exercise actual gateway transitions on a liner tour, including factual commentary and its home return. */
test('leisure liners tour several systems, retain luxury cargo and return to their home berth', () => {
  const g = game(),
    a = g.traffic.get('ashen-liner')!,
    visited = new Set<string>(),
    topics = new Set<string>();
  const identity = { culture: a.cultureId, design: a.ship.designId },
    cargo = structuredClone(a.ship.cargo);
  for (let i = 0; i < 200 && a.journeys < 1; i++) {
    for (const e of boundary(g, a)) if (e.actorId === a.ship.id) topics.add(e.topic);
    if (a.motion.systemId) visited.add(a.motion.systemId);
    if (a.motion.kind === 'flight' || a.motion.kind === 'charging' || a.motion.kind === 'transit') {
      const target = (a.job.state as RoamingLinerState).destination;
      if (target) assert.deepEqual(a.motion.action.destination, target);
    }
  }
  assert.equal(a.journeys, 1);
  assert.ok(visited.size >= 3);
  assert.equal(a.motion.systemId, 'ashen');
  assert.equal((a.job.state as RoamingLinerState).index, 0);
  assert.ok(
    topics.has('liner.depart') && topics.has('liner.view') && topics.has('navigation.charging')
  );
  assert.deepEqual(a.ship.cargo, cargo);
  assert.deepEqual({ culture: a.cultureId, design: a.ship.designId }, identity);
  a.ship.cargo = {};
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.deepEqual(restored.traffic.get(a.ship.id)!.ship.cargo, {});
});

/** Keep explicit circuits available, now including cross-system stops, without forcing roaming randomness. */
test('authored liner circuits support cross-system routes while rejecting unreachable itineraries', () => {
  const ctx = context(),
    stops: Destination[] = [
      { kind: 'station', systemId: 'ashen', stationId: 'haven' },
      { kind: 'station', systemId: 'kepler', stationId: 'relay' }
    ];
  const config = linerPolicy.readConfig({ stops }, ctx.catalog);
  assert.equal(config.routing, 'circuit');
  let state = linerPolicy.create(ctx, config);
  for (let i = 0; i < 4; i++) state = linerPolicy.next(ctx, config, state).state;
  assert.deepEqual(state, { index: 0, next: 'depart' });
  for (const system of Object.values(ctx.catalog.systems)) system.gates = [];
  assert.throws(
    /** Disconnected authored circuits cannot complete their promised return trip. */ () =>
      linerPolicy.readConfig({ stops }, ctx.catalog),
    /reachable/
  );
});

/** Retain the exact chosen liner stop and memory across repeated contact descriptions and restoration. */
test('liner inspection and reload preserve its current destination and subsequent itinerary', () => {
  let g = game(),
    a = g.traffic.get('aster-commonlight')!;
  reach(g, a, 'flight');
  const planned = structuredClone(a.job);
  for (let n = 0; n < 20; n++) g.traffic.describe(a);
  assert.deepEqual(a.job, planned);
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities),
    copy = restored.traffic.get(a.ship.id)!;
  assert.deepEqual(copy.job, planned);
  for (let n = 0; n < 70; n++) {
    boundary(g, a);
    boundary(restored, copy);
    assert.deepEqual(copy.job, a.job);
  }
});

/** Upgrade old stock purposes at load without teleporting a moving freighter or restarting its cargo leg. */
test('content revision five upgrades stock jobs while preserving motion, cargo, damage and retirement', () => {
  const g = game(),
    raw = JSON.parse(g.save());
  raw.contentVersion = 4;
  const actor = raw.traffic.find(
    /** Select the original Aster hauler's stable saved identity. */ (a: TrafficActor) =>
      a.ship.id === 'aster-cradle'
  );
  actor.job = {
    kind: 'freight',
    config: {
      route: [
        { systemId: 'vesper', stationId: 'vesper-station-1' },
        { systemId: 'ashen', stationId: 'haven' }
      ],
      quantity: 12,
      loadingSeconds: 5,
      unloadingSeconds: 6
    },
    state: { origin: 0, next: 'dock' }
  };
  // Use a real station ID from its existing long-haul home, independent of generated naming.
  actor.job.config.route[0] = (g.traffic.get(actor.ship.id)!.job.config as { home: unknown }).home;
  actor.ship.cargo = { rations: 7 };
  actor.ship.hull = 61;
  actor.motion = {
    kind: 'flight',
    systemId: 'vesper',
    stage: 'egress',
    gateId: g.catalog.systems.vesper.gates[0].id,
    connectionId: g.catalog.systems.vesper.gates[0].connections[0].id,
    leg: {
      from: actor.ship.position,
      to: g.catalog.systems.vesper.gates[0].position,
      startedAt: 0,
      arriveAt: 100
    },
    action: {
      kind: 'travel',
      destination: { kind: 'station', systemId: 'ashen', stationId: 'haven' },
      activity: 'Legacy delivery'
    }
  };
  const liner = raw.traffic.find(
    /** Preserve a stock liner already heading for its old scenic stop. */ (a: TrafficActor) =>
      a.ship.id === 'ashen-liner'
  );
  liner.job = {
    kind: 'liner',
    config: {
      passengers: 80,
      stopSeconds: 9,
      stops: [
        { kind: 'point', systemId: 'ashen', position: position(1300, 700), label: 'Old panorama' },
        { kind: 'station', systemId: 'ashen', stationId: 'haven' }
      ]
    },
    state: { index: 0, next: 'visit' }
  };
  liner.motion = g.traffic.navigation.start(
    g.traffic.get(liner.ship.id)!,
    { kind: 'travel', destination: liner.job.config.stops[0], activity: 'Legacy sightseeing' },
    0
  );
  const retired = raw.traffic.find(
    /** A captured stock freighter must remain historical, with its original job. */ (
      a: TrafficActor
    ) => a.ship.id === 'drift-003-freight-1'
  );
  retired.job = structuredClone(actor.job);
  retired.motion = { kind: 'captured', systemId: 'vesper' };
  retired.ship.owner = 'player';
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities),
    a = restored.traffic.get(actor.ship.id)!;
  assert.equal(a.job.kind, 'long-haul');
  assert.deepEqual(a.motion, actor.motion);
  assert.deepEqual(a.ship.cargo, { rations: 7 });
  assert.equal(a.ship.hull, 61);
  assert.deepEqual((a.job.state as LongHaulState).destination, {
    systemId: 'ashen',
    stationId: 'haven'
  });
  assert.deepEqual(
    (restored.traffic.get(liner.ship.id)!.job.state as RoamingLinerState).destination,
    liner.job.config.stops[0]
  );
  assert.deepEqual(restored.traffic.get(liner.ship.id)!.motion, liner.motion);
  assert.equal(restored.traffic.get(retired.ship.id)!.job.kind, 'freight');
  assert.equal(JSON.parse(restored.save()).contentVersion, 5);
  assert.deepEqual(
    loadSession(restored.save(), g.catalog, g.services, g.activities).traffic.get(a.ship.id)!.job,
    a.job
  );
});

/** Validate future generated traffic uses registered factories rather than hardcoded current-system destinations. */
test('system generation supports roaming freighters and liners with their home culture retained', () => {
  const source = readContent('content'),
    presets = JSON.parse(readFileSync('content/presets.json', 'utf8'));
  presets.presets['long-haul'].traffic.push({
    kind: 'liner',
    shipKind: 'merchant',
    owner: 'tourism',
    factionId: 'civilian',
    count: 1
  });
  const result = expandUniverse(
    source,
    {
      schemaVersion: 1,
      systems: [
        {
          id: 'new-tour-port',
          name: 'New Tour Port',
          seed: 890,
          preset: 'long-haul',
          chart: { x: 10, y: 4 }
        }
      ],
      connections: [{ from: 'vesper', to: 'new-tour-port' }]
    },
    presets
  );
  const catalog = catalogFromData(result.bundle.definition, result.bundle.systems),
    jobs = createTrafficJobs();
  jobs.validateCatalog(catalog);
  const spawns = catalog.systems['new-tour-port'].traffic;
  assert.deepEqual(
    spawns.map(
      /** Inspect the registered purposes produced by the content factories. */ (s) => s.job.kind
    ),
    ['long-haul', 'liner']
  );
  const ctx = context();
  ctx.catalog = catalog;
  ctx.routes = new RouteResolver(catalog);
  ctx.homeSystemId = ctx.systemId = 'new-tour-port';
  const haul = jobs.get('long-haul').create(spawns[0].job.config, ctx),
    step = jobs.get('long-haul').next(ctx, haul);
  assert.notEqual((step.state as LongHaulState).destination!.systemId, 'new-tour-port');
  assert.equal(spawns[1].job.config.routing, 'roaming');
});
