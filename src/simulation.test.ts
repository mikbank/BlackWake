import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  World,
  definitions,
  distance,
  contactTime,
  mountPosition,
  type Input,
  type Shot
} from './simulation';
import { makeShip, createCatalog, position } from './content/universe';
import { createServices, cargoUsed } from './game/services';
import { createActivities, ActivityRegistry } from './game/activities';
import { startTrading, startRaid } from './game/start';
import { loadSession } from './game/persistence';
import { GameSession } from './game/session';
import { Navigation } from './navigation';
import { approachPoint, edgeGuide } from './hud';
import { sessionHud } from './ui/guidance';
const idle: Input = { turn: 0, thrust: 0, brake: true, fire: false };
/**
 * Create the standard guided trading fixture used to exercise general session and
 * simulation rules.
 */
function trading() {
  const catalog = createCatalog(),
    services = createServices(),
    activities = createActivities();
  return startTrading(catalog, services, activities);
}
/** Create an isolated player/merchant combat world with predictable initial geometry. */
function pair() {
  const p = makeShip('player', 'Player', 'cutter', 'player', 0, 0),
    e = makeShip('other', 'Other', 'merchant', 'guild', 1000, 0);
  e.engines = 0;
  const w = new World([p, e], p.id);
  w.relations.declareHostile(p.id, e.id);
  return { w, p, e };
}
/** Create an incoming shell with a known trajectory for physical PDC and swept-hit checks. */
function incoming(owner: string, x = 150, y = 0): Shot {
  return { position: position(x, y), velocity: position(-390, 0), life: 2, owner, disable: false };
}
/**
 * Drive the real navigation controller until it reaches an approach point, failing when
 * physical arrival does not happen.
 */
function fly(game: GameSession, target: { x: number; y: number; z: number }) {
  const nav = new Navigation();
  nav.radius = game.definition.radius;
  nav.moveTo(approachPoint(game.world.player.position, target));
  nav.toggleCruise();
  for (let i = 0; i < 6000 && nav.destination; i++) game.step(1 / 60, nav.input(game.world));
  assert.equal(nav.destination, null, 'Navigation must arrive');
}
/**
 * Fly to the first local exit and execute a jump only after normal physical eligibility is
 * satisfied.
 */
function jump(game: GameSession) {
  const gate = game.definition.gates[0];
  fly(game, gate.position);
  assert.ok(game.canJump(gate));
  assert.ok(game.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(game);
}
/** Fly to a named local station and invoke the validated docking command. */
function dock(game: GameSession, id: string) {
  const station = game.stationById(id)!;
  fly(game, station.position);
  assert.ok(game.dispatch({ type: 'dock', stationId: id }).ok);
}
/**
 * Dispatch a market operation through the station service boundary using the supplied
 * commodity, direction and quantity.
 */
function trade(
  game: GameSession,
  direction: 'buy' | 'sell',
  commodityId: string,
  quantity: number
) {
  return game.dispatch({
    type: 'service',
    kind: 'market',
    payload: { direction, commodityId, quantity }
  });
}

/** Verify the scenario: file-based content includes every registered system and the existing theme. */
test('file-based content includes every registered system and the existing theme', () => {
  const c = createCatalog();
  const ids = JSON.parse(readFileSync('content/universe.json', 'utf8')).systemIds;
  assert.deepEqual(Object.keys(c.systems).sort(), [...ids].sort());
  assert.equal(Object.keys(c.themes).length, 1);
  c.validate();
  createServices().validate(c);
});
/** Verify the scenario: broken jump links and duplicate content IDs are rejected. */
test('broken jump links and duplicate content IDs are rejected', () => {
  const c = createCatalog();
  c.systems.ashen.gates[0].connections[0].gateId = 'missing';
  assert.throws(
    /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
    () => c.validate()
  );
  const d = createCatalog();
  d.systems.kepler.stations[0].id = 'haven';
  assert.throws(
    /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
    () => d.validate()
  );
  assert.throws(
    /**
     * Attempt the scenario operation so the assertion can verify that invalid input is
     * rejected.
     */
    () => d.addSystem(d.systems.ashen)
  );
});
/**
 * Verify the scenario: neutral ownership and faction differences do not create hostility
 * or damage.
 */
test('neutral ownership and faction differences do not create hostility or damage', () => {
  const game = trading();
  game.dispatch({ type: 'undock' });
  const other = game.world.ships[1];
  for (let i = 0; i < 1200; i++) game.step(1 / 60, { ...idle, fire: true, targetId: other.id });
  assert.equal(game.world.player.hull, 100);
  assert.equal(other.hull, 100);
  assert.equal(game.world.shots.length, 0);
});
/**
 * Verify the scenario: explicit attack creates hostility without changing ownership or
 * faction.
 */
test('explicit attack creates hostility without changing ownership or faction', () => {
  const g = trading();
  g.dispatch({ type: 'undock' });
  const target = g.world.ships[1],
    faction = target.factionId;
  assert.ok(g.dispatch({ type: 'attack', shipId: target.id }).ok);
  assert.ok(g.world.relations.isHostile(g.world.player, target));
  assert.equal(target.factionId, faction);
  assert.equal(target.owner, 'guild');
});
/** Verify the scenario: broadside arcs and separate port/starboard reloads remain intact. */
test('broadside arcs and separate port/starboard reloads remain intact', () => {
  const { w, p, e } = pair();
  p.heading = 0;
  e.position = position(200, 0);
  w.combat.fire(p, e, true);
  assert.equal(w.shots.length, 0);
  e.position = position(0, 200);
  w.combat.fire(p, e, true);
  assert.equal(w.shots.length, 3);
  assert.ok(p.reload[0] > 0);
  assert.equal(p.reload[1], 0);
  w.combat.fire(p, e, true);
  assert.equal(w.shots.length, 3);
  e.position.y = -200;
  w.combat.fire(p, e, true);
  assert.equal(w.shots.length, 6);
});
/** Verify the scenario: PDC rounds travel before physically intercepting a shell. */
test('PDC rounds travel before physically intercepting a shell', () => {
  const { w, p, e } = pair();
  w.shots.push(incoming(e.id));
  w.step(1 / 60, idle);
  assert.equal(w.shots.length, 1);
  assert.equal(w.defenceRounds.length, 1);
  assert.equal(w.defenceFor(p).interceptions, 0);
  for (let i = 0; i < 60; i++) w.step(1 / 60, idle);
  assert.equal(w.defenceFor(p).interceptions, 1);
  assert.equal(p.hull, 100);
});
/** Verify the scenario: both vessels can be overwhelmed by dense salvos. */
test('both vessels can be overwhelmed by dense salvos', () => {
  for (const kind of ['cutter', 'merchant'] as const) {
    const { w, p, e } = pair();
    p.kind = kind;
    for (let i = 0; i < 9; i++) w.shots.push(incoming(e.id, 150, (i - 4) * 2));
    for (let i = 0; i < 120; i++) w.step(1 / 60, idle);
    assert.ok(w.defenceFor(p).interceptions > 0);
    assert.ok(w.defenceFor(p).interceptions < 9);
    assert.ok(p.hull < 100);
  }
});
/** Verify the scenario: PDC bursts alternate mounts and pause after three rounds. */
test('PDC bursts alternate mounts and pause after three rounds', () => {
  const { w, p, e } = pair();
  for (let i = 0; i < 9; i++) w.shots.push(incoming(e.id, 150, (i - 4) * 2));
  const mounts: number[] = [];
  for (let i = 0; i < 30; i++) {
    w.step(1 / 60, idle);
    for (const event of w.events) if (event.type === 'pdc-fire') mounts.push(event.mount!);
  }
  assert.deepEqual(mounts, [0, 1, 0]);
  assert.ok(w.defenceFor(p).cooldown > 0);
});
/** Verify the scenario: PDC ignores friendly, departing and non-threatening trajectories. */
test('PDC ignores friendly, departing and non-threatening trajectories', () => {
  for (const mode of ['friendly', 'departing', 'missing']) {
    const { w, p, e } = pair(),
      shot = incoming(e.id);
    if (mode === 'friendly') shot.owner = p.id;
    if (mode === 'departing') shot.velocity.x = 390;
    if (mode === 'missing') shot.position.y = 100;
    w.shots.push(shot);
    w.step(1 / 60, idle);
    assert.equal(w.defenceFor(p).roundsFired, 0);
  }
});
/** Verify the scenario: swept collision prevents tunneling and duplicate interceptions. */
test('swept collision prevents tunneling and duplicate interceptions', () => {
  const { w, p, e } = pair();
  w.defenceFor(p).cooldown = 10;
  w.shots.push(incoming(e.id, 100), incoming(e.id, 100));
  w.defenceRounds.push({
    position: position(80, 0),
    velocity: position(900, 0),
    life: 0.32,
    owner: p.id,
    mount: 0
  });
  w.step(1 / 60, idle);
  assert.equal(w.defenceFor(p).interceptions, 1);
  assert.equal(w.shots.length, 1);
  assert.equal(w.defenceRounds.length, 0);
  assert.ok(contactTime(position(-10, 0), position(10, 0), 1)! < 1);
});
/** Verify the scenario: destroying another ship does not freeze the world. */
test('destroying another ship does not freeze the world', () => {
  const { w, p, e } = pair();
  e.hull = 0;
  w.step(1 / 60, { ...idle, thrust: 1 });
  const before = w.elapsed;
  w.step(1 / 60, { ...idle, thrust: 1 });
  assert.ok(w.elapsed > before);
  assert.ok(p.velocity.y > 0);
});
/**
 * Verify the scenario: navigation arrives from behind and brakes after overshoot without a
 * scenario.
 */
test('navigation arrives from behind and brakes after overshoot without a scenario', () => {
  const { w, p } = pair(),
    nav = new Navigation();
  p.velocity = position(90, 0);
  p.heading = 0;
  nav.moveTo(position(-250, -120));
  for (let i = 0; i < 2400; i++) w.step(1 / 60, nav.input(w));
  assert.equal(nav.destination, null);
  assert.ok(distance(p.position, position(-250, -120)) < 10);
  assert.ok(Math.hypot(p.velocity.x, p.velocity.y) < 1);
});
/**
 * Verify the scenario: navigation bounds come from the active system rather than a fixed
 * sector.
 */
test('navigation bounds come from the active system rather than a fixed sector', () => {
  const nav = new Navigation();
  nav.radius = 3500;
  nav.moveTo(position(5000, 0));
  assert.ok(Math.abs(nav.destination!.x - 3470) < 0.000001);
});
/**
 * Verify the scenario: docking is allowed before any raid and undocking does not end the
 * session.
 */
test('docking is allowed before any raid and undocking does not end the session', () => {
  const g = trading();
  assert.ok(g.dispatch({ type: 'undock' }).ok);
  g.world.player.position = { ...g.stationById('haven')!.position };
  assert.ok(g.dispatch({ type: 'dock', stationId: 'haven' }).ok);
  const credit = g.captain.credits;
  assert.ok(g.dispatch({ type: 'undock' }).ok);
  g.step(1 / 60, idle);
  assert.equal(g.captain.credits, credit);
  assert.ok(g.world.elapsed > 0);
});
/** Verify the scenario: remote, fast and missing-station docking requests are rejected. */
test('remote, fast and missing-station docking requests are rejected', () => {
  const g = trading();
  g.dispatch({ type: 'undock' });
  g.world.player.position = position(1000, 1000);
  assert.equal(g.dispatch({ type: 'dock', stationId: 'haven' }).ok, false);
  g.world.player.position = { ...g.stationById('haven')!.position };
  g.world.player.velocity = position(100, 0);
  assert.equal(g.dispatch({ type: 'dock', stationId: 'haven' }).ok, false);
  assert.equal(g.dispatch({ type: 'dock', stationId: 'missing' }).ok, false);
});
/**
 * Verify the scenario: market validates credits, capacity, stock, quantity and goods
 * atomically.
 */
test('market validates credits, capacity, stock, quantity and goods atomically', () => {
  const g = trading(),
    initial = g.captain.credits;
  for (const q of [0, -1, 1.5, NaN, Infinity])
    assert.equal(trade(g, 'buy', 'rations', q).ok, false);
  assert.equal(trade(g, 'buy', 'missing', 1).ok, false);
  assert.equal(trade(g, 'sell', 'rations', 1).ok, false);
  assert.equal(trade(g, 'buy', 'rations', 21).ok, false);
  assert.equal(trade(g, 'buy', 'parts', 15).ok, false);
  assert.equal(g.captain.credits, initial);
  assert.equal(cargoUsed(g.world.player, g.catalog), 0);
});
/**
 * Verify the scenario: market transactions require a docked station with the declared
 * service.
 */
test('market transactions require a docked station with the declared service', () => {
  const g = trading();
  g.dispatch({ type: 'undock' });
  assert.equal(trade(g, 'buy', 'rations', 1).ok, false);
  g.world.player.position = { ...g.stationById('haven')!.position };
  g.dispatch({ type: 'dock', stationId: 'haven' });
  g.station!.services = [];
  assert.equal(trade(g, 'buy', 'rations', 1).ok, false);
});
/** Verify the scenario: buy/sell updates stock and credits without local arbitrage. */
test('buy/sell updates stock and credits without local arbitrage', () => {
  const g = trading();
  assert.ok(trade(g, 'buy', 'rations', 10).ok);
  assert.equal(g.captain.credits, 380);
  assert.equal(g.markets.haven.stock.rations, 70);
  assert.ok(trade(g, 'sell', 'rations', 10).ok);
  assert.equal(g.captain.credits, 500);
  assert.equal(g.markets.haven.stock.rations, 80);
});
/**
 * Verify the scenario: jumping requires the correct link, zone, low speed and an undocked
 * ship.
 */
test('jumping requires the correct link, zone, low speed and an undocked ship', () => {
  const g = trading();
  assert.equal(g.dispatch({ type: 'jump', connectionId: 'ashen-to-kepler' }).ok, false);
  g.dispatch({ type: 'undock' });
  assert.equal(g.dispatch({ type: 'jump', connectionId: 'ashen-to-kepler' }).ok, false);
  g.world.player.position = { ...g.definition.gates[0].position };
  g.world.player.velocity = position(100, 0);
  assert.equal(g.dispatch({ type: 'jump', connectionId: 'ashen-to-kepler' }).ok, false);
  g.world.player.velocity = position(0, 0);
  assert.equal(g.dispatch({ type: 'jump', connectionId: 'missing' }).ok, false);
  assert.ok(g.dispatch({ type: 'jump', connectionId: 'ashen-to-kepler' }).ok);
  finishTransit(g);
  assert.equal(g.systemId, 'kepler');
});
/**
 * Verify the scenario: full trading circuit flies, jumps, sells, returns and earns a net
 * profit.
 */
test('full trading circuit flies, jumps, sells, returns and earns a net profit', () => {
  const g = trading();
  assert.ok(trade(g, 'buy', 'rations', 10).ok);
  g.dispatch({ type: 'undock' });
  jump(g);
  assert.equal(g.world.player.cargo.rations, 10);
  dock(g, 'relay');
  assert.ok(trade(g, 'sell', 'rations', 10).ok);
  assert.ok(trade(g, 'buy', 'parts', 10).ok);
  g.dispatch({ type: 'undock' });
  jump(g);
  dock(g, 'haven');
  assert.ok(trade(g, 'sell', 'parts', 10).ok);
  assert.equal(g.captain.credits, 790);
  assert.equal(cargoUsed(g.world.player, g.catalog), 0);
  assert.ok(g.activity!.state.exportSold && g.activity!.state.importSold);
  assert.equal(g.systemId, 'ashen');
  assert.equal(g.markets.haven.stock.rations, 70);
  assert.equal(g.markets.relay.stock.parts, 70);
});
/**
 * Verify the scenario: inactive system ships and damage persist while the player and
 * equipment travel.
 */
test('inactive system ships and damage persist while the player and equipment travel', () => {
  const g = trading();
  g.dispatch({ type: 'undock' });
  g.world.ships[1].hull = 42;
  const shipId = g.world.player.id;
  g.world.defenceFor(g.world.player).interceptions = 8;
  jump(g);
  assert.equal(g.world.player.id, shipId);
  assert.equal(g.world.defenceFor(g.world.player).interceptions, 8);
  jump(g);
  assert.equal(
    g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'ashen-trader'
    )!.hull,
    42
  );
  assert.equal(
    g.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === shipId
    ).length,
    1
  );
});
/**
 * Verify the scenario: save/load preserves balances, cargo, market stock, visits, dock and
 * activity.
 */
test('save/load preserves balances, cargo, market stock, visits, dock and activity', () => {
  const g = trading();
  trade(g, 'buy', 'rations', 10);
  g.dispatch({ type: 'undock' });
  jump(g);
  dock(g, 'relay');
  trade(g, 'sell', 'rations', 5);
  g.world.disable = false;
  const loaded = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(loaded.systemId, 'kepler');
  assert.equal(loaded.world.disable, false);
  assert.equal(loaded.dockedAt, 'relay');
  assert.equal(loaded.captain.credits, g.captain.credits);
  assert.deepEqual(loaded.world.player.cargo, g.world.player.cargo);
  assert.deepEqual(loaded.markets, g.markets);
  assert.deepEqual(loaded.activity, g.activity);
  assert.deepEqual(loaded.visits, g.visits);
});
/** Verify the scenario: invalid save values and broken references are rejected. */
test('invalid save values and broken references are rejected', () => {
  const g = trading(),
    raw = JSON.parse(g.save());
  for (const mutate of [
    /** Corrupt saved credits with a negative balance to exercise import validation. */
    (d: any) => (d.captain.credits = -1),
    /** Corrupt a saved cargo quantity to verify inventory validation rejects negative goods. */
    (d: any) => (d.player.cargo.rations = -4),
    /** Point the save at an unknown system to verify broken content references are rejected. */
    (d: any) => (d.systemId = 'unknown'),
    /** Point docking state at an unknown station to exercise location validation. */
    (d: any) => (d.dockedAt = 'unknown'),
    /** Insert an invalid PDC cooldown to verify equipment-state validation during import. */
    (d: any) => (d.systems.ashen.defences = { wayward: { cooldown: -1 } }),
    /**
     * Insert a non-finite hull value to verify JSON save input cannot enter the simulation
     * unchecked.
     */
    (d: any) => (d.player.hull = NaN)
  ]) {
    const d = structuredClone(raw);
    mutate(d);
    assert.throws(
      /**
       * Attempt save decoding and migration so the assertion can verify that invalid input is
       * rejected.
       */
      () => loadSession(JSON.stringify(d), g.catalog, g.services, g.activities)
    );
  }
});
/** Verify the scenario: the original raid save migrates into a playable optional raid. */
test('the original raid save migrates into a playable optional raid', () => {
  const g = trading(),
    raw = readFileSync(new URL('./fixtures/legacy-v1.json', import.meta.url), 'utf8'),
    m = loadSession(raw, g.catalog, g.services, g.activities);
  assert.equal(m.activity!.type, 'raid');
  assert.equal(m.world.player.id, 'wayward');
  assert.ok(
    m.world.ships.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (s) => s.id === 'gull'
    )
  );
  assert.ok(m.world.relations.isHostile(m.world.player, m.world.ships[1]));
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(m.save(), m.catalog, m.services, m.activities)
  );
});
/**
 * Verify the scenario: trading and travel still work when all activity observers are
 * removed.
 */
test('trading and travel still work when all activity observers are removed', () => {
  const base = trading(),
    g = new GameSession(
      base.catalog,
      base.services,
      new ActivityRegistry(),
      'ashen',
      makeShip('pilot', 'Pilot', 'cutter', 'player', -340, -260)
    );
  g.dockedAt = 'haven';
  assert.ok(trade(g, 'buy', 'rations', 2).ok);
  g.dispatch({ type: 'undock' });
  jump(g);
  dock(g, 'relay');
  assert.ok(trade(g, 'sell', 'rations', 2).ok);
  assert.equal(g.activity, null);
});
/**
 * Verify the scenario: a third data-defined system and new station size require no
 * simulation changes.
 */
test('a third data-defined system and new station size require no simulation changes', () => {
  const g = trading(),
    c = g.catalog;
  c.stationSizes.testsize = {
    id: 'testsize',
    scale: 2,
    dockRadius: 310,
    description: 'Test station'
  };
  const extra = structuredClone(c.systems.kepler);
  extra.id = 'extra';
  extra.name = 'Generated test';
  extra.seed = 99;
  extra.stations[0].id = 'extra-port';
  extra.stations[0].size = 'testsize';
  // This isolated extension has one new exit; cloned expansion gates belong to Kepler.
  extra.gates = [extra.gates[0]];
  extra.gates[0].id = 'extra-gate';
  extra.gates[0].connections = [{ id: 'extra-home', systemId: 'ashen', gateId: 'ashen-egress' }];
  extra.landmarks[0].id = 'extra-body';
  extra.traffic = [];
  c.addSystem(extra);
  c.systems.ashen.gates[0].connections.push({
    id: 'extra-link',
    systemId: 'extra',
    gateId: 'extra-gate'
  });
  c.validate();
  g.services.validate(c);
  g.dispatch({ type: 'undock' });
  fly(g, g.definition.gates[0].position);
  assert.ok(g.dispatch({ type: 'jump', connectionId: 'extra-link' }).ok);
  finishTransit(g);
  assert.equal(g.systemId, 'extra');
  dock(g, 'extra-port');
  assert.ok(trade(g, 'buy', 'parts', 1).ok);
});
/** Verify the scenario: station services can be added by registration and content alone. */
test('station services can be added by registration and content alone', () => {
  const g = trading();
  g.station!.services.push({ kind: 'inspection', config: { fee: 3 } });
  g.services.register({
    kind: 'inspection',
    title: 'Inspection',
    /**
     * Provide a test-only station capability to verify services can be extended by
     * registration.
     */
    execute(ctx) {
      ctx.captain.credits -= Number(ctx.spec.config.fee);
      return { ok: true, message: 'Inspection complete.' };
    }
  });
  assert.ok(
    g.services.available(g.station!).some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (s) => s.kind === 'inspection'
    )
  );
  assert.ok(g.dispatch({ type: 'service', kind: 'inspection', payload: {} }).ok);
  assert.equal(g.captain.credits, 497);
});
/** Verify the scenario: station scale and theme do not determine available services. */
test('station scale and theme do not determine available services', () => {
  const g = trading();
  g.station!.size = 'large';
  g.station!.services = g.station!.services.filter(
    /** Keep the fixture values satisfying this scenario's selection condition. */
    (s) => s.kind !== 'market'
  );
  assert.equal(trade(g, 'buy', 'rations', 1).ok, false);
  g.world.player.hull = 90;
  assert.ok(g.dispatch({ type: 'service', kind: 'repair', payload: {} }).ok);
  assert.equal(g.world.player.hull, 100);
});
/**
 * Verify the scenario: boarding any disabled target transfers control, equipment and
 * fitting cargo.
 */
test('boarding any disabled target transfers control, equipment and fitting cargo', () => {
  const g = trading();
  trade(g, 'buy', 'rations', 10);
  g.dispatch({ type: 'undock' });
  const target = g.world.ships[1];
  target.engines = 0;
  target.position = { x: g.world.player.position.x + 80, y: g.world.player.position.y, z: 0 };
  target.velocity = position(0, 0);
  g.world.player.velocity = position(0, 0);
  g.world.defenceFor(target).interceptions = 7;
  assert.ok(g.canBoard(target.id));
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, tactic: 'intimidate' }).ok);
  assert.equal(g.world.player.id, target.id);
  assert.equal(g.world.player.cargo.rations, 10);
  assert.equal(g.world.defenceFor(g.world.player).interceptions, 7);
  assert.equal(
    g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'wayward'
    )!.owner,
    'salvage'
  );
  assert.equal(g.world.defenceRounds.length, 0);
  assert.equal(g.activity!.type, 'trade-route');
});
/**
 * Verify the scenario: the optional raid can disable and capture a target using the
 * general simulation.
 */
test('the optional raid can disable and capture a target using the general simulation', () => {
  const base = trading(),
    g = startRaid(base.catalog, base.services, base.activities),
    nav = new Navigation(),
    target = g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === g.activity!.config.target
    )!;
  nav.targetId = target.id;
  for (let i = 0; i < 7200 && !g.failed && target.engines > 0; i++) {
    if (i % 20 === 0) {
      const p = g.world.player.position,
        t = target.position,
        r = distance(p, t),
        a = Math.atan2(t.y - p.y, t.x - p.x) + (r > 320 ? 0.65 : Math.PI / 2);
      nav.moveTo(position(p.x + Math.cos(a) * 160, p.y + Math.sin(a) * 160));
    }
    g.step(1 / 60, nav.input(g.world));
  }
  assert.equal(g.failed, false);
  assert.equal(target.engines, 0);
  fly(g, target.position);
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, tactic: 'intimidate' }).ok);
  assert.ok(g.activity!.state.captured);
  dock(g, 'haven');
  assert.ok(g.activity!.state.complete);
  assert.ok(g.dispatch({ type: 'undock' }).ok);
  const time = g.world.elapsed;
  g.step(1 / 60, idle);
  assert.ok(g.world.elapsed > time);
});
import * as THREE from 'three';
import { createShipModel, disposeShipModel } from './ship-model';
import { View } from './view';
/**
 * Verify the scenario: ship geometry remains finite and PDC models match the simulation
 * mounts.
 */
test('ship geometry remains finite and PDC models match the simulation mounts', () => {
  const g = trading();
  for (const ship of g.world.ships) {
    const model = createShipModel(ship);
    let draws = 0;
    model.traverse(
      /**
       * Inspect each model node for the geometry, transform or resource invariant asserted by
       * this scenario.
       */
      (part) => {
        if (part instanceof THREE.Mesh) {
          draws++;
          for (const n of part.geometry.getAttribute('position').array)
            assert.ok(Number.isFinite(n));
        }
      }
    );
    assert.ok(draws < 40);
    model.position.set(ship.position.x, ship.position.y, 0);
    model.rotation.z = ship.heading;
    model.updateMatrixWorld();
    const p = model.getObjectByName('pdc-0')!.getWorldPosition(new THREE.Vector3()),
      m = mountPosition(ship, 0);
    assert.ok(p.distanceTo(new THREE.Vector3(m.x, m.y, m.z)) < 0.001);
    disposeShipModel(model);
  }
});
/**
 * Verify the scenario: screen clicks still resolve to world coordinates at mobile viewport
 * offsets.
 */
test('screen clicks still resolve to world coordinates at mobile viewport offsets', () => {
  const camera = new THREE.OrthographicCamera(-400, 400, 500, -500, 0.1, 3000);
  camera.position.set(210, -140, 1500);
  camera.updateMatrixWorld();
  const rect = { left: 12, top: 58, width: 390, height: 786 },
    fake = {
      camera,
      /** Provide a no-op renderer hook for the camera-only coordinate-conversion test double. */
      resize() {},
      renderer: {
        domElement: {
          /**
           * Return a synthetic offset canvas rectangle so input-coordinate conversion is tested
           * independently of a browser.
           */
          getBoundingClientRect() {
            return rect;
          }
        }
      }
    } as unknown as View,
    point = new THREE.Vector3(260, -200, 0),
    ndc = point.clone().project(camera),
    p = View.prototype.worldPoint.call(
      fake,
      rect.left + ((ndc.x + 1) * rect.width) / 2,
      rect.top + ((1 - ndc.y) * rect.height) / 2
    );
  assert.ok(Math.hypot(p.x - point.x, p.y - point.y) < 0.001);
});
/** Verify the scenario: HUD actions use generic docking, boarding and jumping conditions. */
test('HUD actions use generic docking, boarding and jumping conditions', () => {
  const g = trading();
  assert.equal(sessionHud(g).action, 'station');
  g.dispatch({ type: 'undock' });
  g.world.player.position = { ...g.definition.gates[0].position };
  g.dispatch({ type: 'select', target: { kind: 'gate', id: g.definition.gates[0].id } });
  assert.equal(sessionHud(g).action, 'jump-map');
  g.world.player.position = position(0, 0);
  assert.equal(sessionHud(g).action, 'approach');
});
/** Verify the scenario: off-screen guidance fits portrait and landscape safe areas. */
test('off-screen guidance fits portrait and landscape safe areas', () => {
  for (const size of [
    { w: 390, h: 786, top: 230, bottom: 170 },
    { w: 844, h: 390, top: 125, bottom: 125 }
  ])
    for (const point of [
      { x: -1000, y: 100 },
      { x: 2000, y: 100 },
      { x: 200, y: -200 },
      { x: 200, y: 2000 }
    ]) {
      const guide = edgeGuide(point, size.w, size.h, size.top, size.bottom)!;
      assert.ok(guide);
      assert.ok(Number.isFinite(guide.angle));
      assert.ok(guide.x >= 79.99 && guide.x <= size.w - 79.99);
      assert.ok(
        guide.y >= Math.min(size.top, size.h / 2) - 0.01 && guide.y <= size.h - size.bottom + 0.01
      );
    }
});
/**
 * Verify the scenario: new market goods seed their stock without resetting existing
 * inventory.
 */
test('new market goods seed their stock without resetting existing inventory', () => {
  const g = trading();
  trade(g, 'buy', 'rations', 3);
  g.catalog.commodities['test-water'] = { id: 'test-water', name: 'Water', unitSize: 1 };
  g.catalog.markets.haven.goods['test-water'] = { price: 5, stock: 40 };
  assert.ok(trade(g, 'buy', 'test-water', 2).ok);
  assert.equal(g.markets.haven.stock['test-water'], 38);
  assert.equal(g.markets.haven.stock.rations, 77);
});
/**
 * Verify the scenario: content-driven model selection and scale do not change station
 * services.
 */
test('content-driven model selection and scale do not change station services', async () => {
  const { buildSystemModels, disposeSystemModels, stationModelBuilders } = await import(
    './ui/system-model'
  );
  const g = trading();
  stationModelBuilders.set(
    'test-model',
    /**
     * Provide a test graphics or policy implementation without changing production registry
     * dispatch.
     */
    () => {
      const group = new THREE.Group();
      group.userData.custom = true;
      return group;
    }
  );
  g.definition.stations[0].modelId = 'test-model';
  g.definition.stations[0].size = 'large';
  const models = buildSystemModels({
    definition: g.definition,
    theme: g.catalog.themes.frontier,
    sizes: g.catalog.stationSizes,
    key: 'test',
    dockedAt: null
  });
  const station = models.getObjectByName('haven')!;
  assert.ok(station.userData.custom);
  assert.equal(station.scale.x, 5.1);
  assert.ok(trade(g, 'buy', 'rations', 1).ok);
  disposeSystemModels(models);
  stationModelBuilders.delete('test-model');
});
/**
 * Verify the scenario: captured ship and cargo remain unique through save, jump and
 * return.
 */
test('captured ship and cargo remain unique through save, jump and return', () => {
  const g = trading();
  trade(g, 'buy', 'rations', 3);
  g.dispatch({ type: 'undock' });
  const target = g.world.ships[1];
  target.engines = 0;
  target.position = { x: g.world.player.position.x + 80, y: g.world.player.position.y, z: 0 };
  target.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, tactic: 'intimidate' }).ok);
  const loaded = loadSession(g.save(), g.catalog, g.services, g.activities);
  jump(loaded);
  jump(loaded);
  assert.equal(loaded.world.player.id, target.id);
  assert.equal(loaded.world.player.cargo.rations, 3);
  assert.equal(
    loaded.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === target.id
    ).length,
    1
  );
});
/**
 * Verify the scenario: a future vessel-exchange service can use the session capability
 * without editing the dispatcher.
 */
test('a future vessel-exchange service can use the session capability without editing the dispatcher', () => {
  const g = trading();
  trade(g, 'buy', 'rations', 4);
  g.station!.services.push({ kind: 'test-exchange', config: {} });
  g.services.register({
    kind: 'test-exchange',
    title: 'Test exchange',
    /**
     * Request a replacement hull through the session capability to verify future shipyard
     * integration.
     */
    execute(ctx) {
      return ctx.replaceControlledShip(
        makeShip('replacement', 'Replacement', 'merchant', 'player', 0, 0)
      );
    }
  });
  assert.ok(g.dispatch({ type: 'service', kind: 'test-exchange', payload: {} }).ok);
  assert.equal(g.world.player.id, 'replacement');
  assert.equal(g.captain.controlledShipId, 'replacement');
  assert.equal(g.world.player.cargo.rations, 4);
  assert.equal(g.world.player.crew, 18);
  assert.equal(
    g.world.ships.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (s) => s.id === 'wayward'
    ),
    false
  );
  assert.equal(g.dockedAt, 'haven');
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), g.catalog, g.services, g.activities)
  );
});
