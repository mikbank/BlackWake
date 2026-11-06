import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, definitions, distance, type Input, type Ship } from './simulation';
import { Navigation } from './navigation';
import { makeShip, position, createCatalog } from './content/universe';
import { cruiseApproachRange } from './core/cruise';
import { startTrading } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { approachPoint } from './hud';
const idle: Input = { turn: 0, thrust: 0, brake: true, fire: false },
  burn: Input = { ...idle, heading: 0, thrust: 1, cruise: true };
/**
 * Create an isolated hull-and-world fixture so cruise physics can be tested independently
 * of browser controls.
 */
function world(kind: Ship['kind'] = 'cutter') {
  const p = makeShip('pilot', 'Pilot', kind, 'player', -1500, 0);
  p.heading = 0;
  return new World([p], p.id, 10000);
}
/** Advance a fixed number of simulated seconds using the supplied flight input. */
function run(w: World, seconds: number, input: Input) {
  for (let i = 0; i < seconds * 60; i++) w.step(1 / 60, input);
}
/**
 * Run the navigation controller toward a destination and return measured travel state for
 * cruise comparisons.
 */
function travel(kind: Ship['kind'], cruise: boolean) {
  const w = world(kind),
    nav = new Navigation();
  nav.radius = 10000;
  nav.moveTo(position(1500, 0));
  if (cruise) assert.ok(nav.toggleCruise());
  let maxX = w.player.position.x;
  let peak = 0,
    active = false,
    time = 0;
  for (let i = 0; i < 15000 && nav.destination; i++) {
    w.step(1 / 60, nav.input(w));
    time += 1 / 60;
    maxX = Math.max(maxX, w.player.position.x);
    peak = Math.max(peak, Math.hypot(w.player.velocity.x, w.player.velocity.y));
    active ||= w.cruise.forShip(w.player).phase === 'active';
  }
  assert.equal(nav.destination, null);
  return { w, nav, peak, active, time, maxX };
}

/**
 * Verify the scenario: cruise spools at normal speed before reaching the configured 4x
 * speed.
 */
test('cruise spools at normal speed before reaching the configured 4x speed', () => {
  const w = world();
  run(w, 1, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'charging');
  assert.ok(Math.hypot(w.player.velocity.x, w.player.velocity.y) <= definitions.cutter.speed);
  run(w, 4, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
  assert.ok(w.player.velocity.x > definitions.cutter.speed * 3.9);
  assert.ok(w.player.velocity.x <= definitions.cutter.speed * 4);
  assert.ok(w.cruise.suppressesBroadsides(w.player));
});
/**
 * Verify the scenario: both existing hull classes travel substantially faster and arrive
 * slowly without overshooting.
 */
test('both existing hull classes travel substantially faster and arrive slowly without overshooting', () => {
  for (const kind of ['cutter', 'merchant'] as const) {
    const normal = travel(kind, false),
      fast = travel(kind, true);
    assert.ok(
      fast.time < normal.time * 0.65,
      `${kind}: normal ${normal.time.toFixed(2)}s, cruise ${fast.time.toFixed(2)}s`
    );
    assert.ok(fast.active);
    assert.ok(fast.maxX < 1510);
    assert.ok(fast.peak > definitions[kind].speed * 3.8);
    assert.ok(distance(fast.w.player.position, position(1500, 0)) < 10);
    assert.ok(Math.hypot(fast.w.player.velocity.x, fast.w.player.velocity.y) < 7);
    assert.equal(fast.nav.cruiseRequested, false);
  }
});
/**
 * Verify the scenario: short courses never engage cruise and are handled at approach
 * speed.
 */
test('short courses never engage cruise and are handled at approach speed', () => {
  const w = world(),
    nav = new Navigation();
  nav.radius = 10000;
  nav.moveTo(position(-1300, 0));
  nav.toggleCruise();
  let active = false;
  for (let i = 0; i < 1500 && nav.destination; i++) {
    w.step(1 / 60, nav.input(w));
    active ||= w.cruise.forShip(w.player).phase === 'active';
    assert.ok(Math.hypot(w.player.velocity.x, w.player.velocity.y) <= definitions.cutter.speed);
  }
  assert.equal(active, false);
  assert.equal(nav.destination, null);
  assert.ok(cruiseApproachRange(w.player) > 300);
});
/**
 * Verify the scenario: Stop cancels the course and cruise request, then brakes the ship
 * physically.
 */
test('Stop cancels the course and cruise request, then brakes the ship physically', () => {
  const w = world(),
    nav = new Navigation();
  nav.radius = 10000;
  nav.moveTo(position(3000, 0));
  nav.toggleCruise();
  for (let i = 0; i < 240; i++) w.step(1 / 60, nav.input(w));
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
  nav.stop();
  w.cruise.cancel(w.player);
  run(w, 2, nav.input(w));
  assert.equal(nav.cruiseRequested, false);
  assert.equal(nav.destination, null);
  assert.equal(w.cruise.forShip(w.player).phase, 'off');
  assert.ok(Math.hypot(w.player.velocity.x, w.player.velocity.y) < 1);
  assert.equal(nav.toggleCruise(), false);
});
/**
 * Verify the scenario: a sharp course change disengages cruise and the pilot still reaches
 * the new destination.
 */
test('a sharp course change disengages cruise and the pilot still reaches the new destination', () => {
  const w = world(),
    nav = new Navigation();
  nav.radius = 10000;
  nav.moveTo(position(3000, 0));
  nav.toggleCruise();
  for (let i = 0; i < 240; i++) w.step(1 / 60, nav.input(w));
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
  const dest = position(w.player.position.x - 900, w.player.position.y + 50);
  nav.moveTo(dest);
  w.step(1 / 60, nav.input(w));
  assert.notEqual(w.cruise.forShip(w.player).phase, 'active');
  for (let i = 0; i < 4000 && nav.destination; i++) w.step(1 / 60, nav.input(w));
  assert.equal(nav.destination, null);
  assert.ok(distance(w.player.position, dest) < 10);
});
/** Verify the scenario: neutral traffic does not lock cruise while nearby hostiles do. */
test('neutral traffic does not lock cruise while nearby hostiles do', () => {
  const w = world(),
    other = makeShip('other', 'Other', 'merchant', 'guild', w.player.position.x + 300, 200);
  other.engines = 0;
  w.addShip(other);
  run(w, 2, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
  other.position = { x: w.player.position.x + 300, y: w.player.position.y, z: 0 };
  w.relations.declareHostile(w.player.id, other.id);
  w.step(1 / 60, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'blocked');
  assert.equal(w.cruise.forShip(w.player).reason, 'Hostiles nearby');
});
/**
 * Verify the scenario: incoming hostile projectiles block spool-up even when the attacker
 * is outside combat range.
 */
test('incoming hostile projectiles block spool-up even when the attacker is outside combat range', () => {
  for (const incoming of [true, false]) {
    const w = world(),
      enemy = makeShip('enemy', 'Enemy', 'merchant', 'guild', w.player.position.x + 1200, 0);
    enemy.engines = 0;
    w.addShip(enemy);
    w.relations.declareHostile(w.player.id, enemy.id);
    w.shots.push({
      owner: enemy.id,
      position: position(w.player.position.x + 200, 0),
      velocity: position(incoming ? -390 : 390, 0),
      life: 1,
      disable: false
    });
    w.step(1 / 60, burn);
    assert.equal(w.cruise.forShip(w.player).phase, incoming ? 'blocked' : 'charging');
  }
});
/**
 * Verify the scenario: damage disrupts cruise and imposes a lockout even after the
 * attacker leaves.
 */
test('damage disrupts cruise and imposes a lockout even after the attacker leaves', () => {
  const w = world(),
    enemy = makeShip('enemy', 'Enemy', 'merchant', 'guild', 1000, 0);
  enemy.engines = 0;
  w.addShip(enemy);
  w.relations.declareHostile(w.player.id, enemy.id);
  w.combat.defenceFor(w.player).cooldown = 100;
  w.shots.push({
    owner: enemy.id,
    position: position(w.player.position.x + 5, 0),
    velocity: position(-390, 0),
    life: 1,
    disable: false
  });
  w.step(1 / 60, burn);
  assert.ok(w.player.hull < 100);
  w.ships = w.ships.filter(
    /** Select the fixture identities required for this persistence or uniqueness check. */
    (s) => s.id !== enemy.id
  );
  w.step(1 / 60, burn);
  assert.equal(w.cruise.forShip(w.player).reason, 'Taking fire');
  run(w, 2, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'blocked');
  run(w, 3, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
});
/** Verify the scenario: PDCs continue defending while cruise is requested or interrupted. */
test('PDCs continue defending while cruise is requested or interrupted', () => {
  const w = world(),
    enemy = makeShip('enemy', 'Enemy', 'merchant', 'guild', w.player.position.x + 1200, 0);
  enemy.engines = 0;
  w.addShip(enemy);
  w.relations.declareHostile(w.player.id, enemy.id);
  w.shots.push({
    owner: enemy.id,
    position: position(w.player.position.x + 150, 0),
    velocity: position(-390, 0),
    life: 1,
    disable: false
  });
  run(w, 1, burn);
  assert.ok(w.defenceFor(w.player).interceptions > 0);
  assert.equal(w.player.hull, 100);
});
/** Verify the scenario: combat arrival drops cruise before automatic broadsides fire. */
test('combat arrival drops cruise before automatic broadsides fire', () => {
  const w = world(),
    enemy = makeShip('enemy', 'Enemy', 'merchant', 'guild', 1000, 0);
  w.addShip(enemy);
  /** Hold unrelated NPC movement steady so the test can isolate the player's drive behavior. */
  w.npcOrder = () => idle;
  w.relations.declareHostile(w.player.id, enemy.id);
  run(w, 3, burn);
  assert.equal(w.cruise.forShip(w.player).phase, 'active');
  enemy.position = { x: w.player.position.x, y: w.player.position.y + 200, z: 0 };
  w.step(1 / 60, { ...burn, fire: true, targetId: enemy.id });
  assert.equal(w.cruise.forShip(w.player).phase, 'blocked');
  assert.ok(
    w.shots.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (s) => s.owner === w.player.id
    )
  );
});
/** Verify the scenario: disabled engines and salvage cannot activate cruise. */
test('disabled engines and salvage cannot activate cruise', () => {
  for (const mode of ['engines', 'salvage']) {
    const w = world();
    if (mode === 'engines') w.player.engines = 0;
    else w.player.owner = 'salvage';
    run(w, 3, burn);
    assert.equal(w.cruise.forShip(w.player).phase, 'blocked');
    assert.equal(w.player.velocity.x, 0);
  }
});
/**
 * Verify the scenario: cruise changes only the requesting ship, not game time or neutral
 * NPC simulation.
 */
test('cruise changes only the requesting ship, not game time or neutral NPC simulation', () => {
  const a = world(),
    b = world(),
    npc = makeShip('npc', 'NPC', 'merchant', 'guild', 1000, 500);
  a.addShip(structuredClone(npc));
  b.addShip(structuredClone(npc));
  run(a, 5, burn);
  run(b, 5, { ...burn, cruise: false });
  assert.equal(a.elapsed, b.elapsed);
  assert.deepEqual(a.ships[1].position, b.ships[1].position);
  assert.deepEqual(a.ships[1].velocity, b.ships[1].velocity);
  assert.ok(a.player.position.x > b.player.position.x + 700);
});
/**
 * Verify the scenario: the shared simulation input can support an NPC drive without a
 * separate movement implementation.
 */
test('the shared simulation input can support an NPC drive without a separate movement implementation', () => {
  const w = world(),
    npc = makeShip('npc', 'NPC', 'merchant', 'guild', 1000, 1000);
  npc.heading = 0;
  w.addShip(npc);
  /** Hold unrelated NPC movement steady so the test can isolate the player's drive behavior. */
  w.npcOrder = () => burn;
  run(w, 5, idle);
  assert.equal(w.cruise.forShip(npc).phase, 'active');
  assert.ok(npc.velocity.x > definitions.merchant.speed * 3.9);
  assert.equal(w.cruise.forShip(w.player).phase, 'off');
});
/**
 * Verify the scenario: cruise approach makes a real jump eligible, while high speed
 * remains ineligible.
 */
test('cruise approach makes a real jump eligible, while high speed remains ineligible', () => {
  const g = startTrading(createCatalog(), createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  const gate = g.definition.gates[0],
    nav = new Navigation();
  nav.radius = g.definition.radius;
  nav.moveTo(approachPoint(g.world.player.position, gate.position, 60));
  nav.toggleCruise();
  let active = false;
  for (let i = 0; i < 6000 && nav.destination; i++) {
    g.step(1 / 60, nav.input(g.world));
    active ||= g.world.cruise.forShip(g.world.player).phase === 'active';
    if (Math.hypot(g.world.player.velocity.x, g.world.player.velocity.y) >= 75)
      assert.equal(g.canJumpConnection(gate.connections[0].id), false);
  }
  assert.ok(active);
  assert.equal(nav.destination, null);
  assert.ok(g.canJumpConnection(gate.connections[0].id));
  assert.ok(g.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(g);
  assert.equal(g.world.cruise.forShip(g.world.player).phase, 'off');
  assert.equal(g.world.player.velocity.x, 0);
});
/**
 * Verify the scenario: saving during cruise preserves the voyage while drive activation
 * resets on reload.
 */
test('saving during cruise preserves the voyage while drive activation resets on reload', () => {
  const g = startTrading(createCatalog(), createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  const nav = new Navigation();
  nav.radius = g.definition.radius;
  nav.moveTo(g.definition.gates[0].position);
  nav.toggleCruise();
  for (let i = 0; i < 240; i++) g.step(1 / 60, nav.input(g.world));
  assert.equal(g.world.cruise.forShip(g.world.player).phase, 'active');
  const loaded = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.deepEqual(loaded.world.player.position, g.world.player.position);
  assert.equal(loaded.world.cruise.forShip(loaded.world.player).phase, 'off');
  for (let i = 0; i < 120; i++) loaded.step(1 / 60, idle);
  assert.ok(
    Math.hypot(loaded.world.player.velocity.x, loaded.world.player.velocity.y) <
      definitions.cutter.speed
  );
});
