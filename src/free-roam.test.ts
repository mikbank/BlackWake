import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, position } from './content/universe';
import { startFreeRoam, startRaid } from './game/start';
import { createServices, cargoUsed } from './game/services';
import { createActivities } from './game/activities';
import { cargoTransferPlan } from './game/boarding';
import { loadSession } from './game/persistence';
import { sessionHud, suggestedContact } from './ui/guidance';
import type { Ship } from './simulation';
const idle = { turn: 0, thrust: 0, brake: true, fire: false };
/** Create a neutral free-roam session with authored traffic and no required mission. */
const game = () =>
  startFreeRoam(createCatalog(), createServices(), createActivities(), { trafficWarmup: false });
/**
 * Prepare an eligible disabled local prize near the player so boarding outcomes can be
 * tested in isolation.
 */
function disabledTarget(g: ReturnType<typeof game>, id = 'ashen-trader') {
  g.dispatch({ type: 'undock' });
  const target = g.world.ships.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (s) => s.id === id
  )!;
  target.engines = 0;
  target.position = position(g.world.player.position.x + 80, g.world.player.position.y);
  target.velocity = position(0, 0);
  g.world.player.velocity = position(0, 0);
  g.dispatch({ type: 'select', target: { kind: 'ship', id } });
  return target;
}
/**
 * Sum cargo across hulls so tests can detect duplicated goods or lost overflow during
 * boarding.
 */
const totals = (ships: Ship[]) => {
  const result: Record<string, number> = {};
  for (const ship of ships)
    for (const [id, q] of Object.entries(ship.cargo)) result[id] = (result[id] ?? 0) + q;
  return result;
};

/**
 * Verify the scenario: new free roam has active multi-culture traffic, no assigned mission
 * and no hostilities.
 */
test('new free roam has active multi-culture traffic, no assigned mission and no hostilities', () => {
  const g = game();
  assert.equal(g.activity, null);
  assert.equal(g.trafficEnabled, true);
  assert.equal(
    g.traffic.actors.length,
    Object.values(g.catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  assert.deepEqual(g.world.relations.hostilePairs, []);
  assert.equal(suggestedContact(g), null);
  assert.match(sessionHud(g).objective, /Free roam/);
  assert.equal(loadSession(g.save(), g.catalog, g.services, g.activities).activity, null);
});

/**
 * Verify the scenario: selecting a neutral ship from either culture offers Attack directly
 * in the flight HUD.
 */
test('selecting a neutral ship from either culture offers Attack directly in the flight HUD', () => {
  for (const id of ['ashen-trader', 'aster-thread']) {
    const g = game();
    g.dispatch({ type: 'undock' });
    assert.ok(g.dispatch({ type: 'select', target: { kind: 'ship', id } }).ok);
    assert.equal(sessionHud(g).action, 'attack');
    assert.match(sessionHud(g).label, /^Attack /);
    assert.ok(g.dispatch({ type: 'attack', shipId: id }).ok);
    assert.equal(sessionHud(g).combat, true);
    assert.equal(sessionHud(g).action, 'none');
    assert.equal(g.world.relations.hostilePairs.length, 1);
    assert.equal(g.activity, null);
  }
});

/**
 * Verify the scenario: free roam broadsides physically damage targets from either culture
 * without a raid activity.
 */
test('free roam broadsides physically damage targets from either culture without a raid activity', () => {
  for (const id of ['ashen-trader', 'aster-thread']) {
    const g = game();
    g.dispatch({ type: 'undock' });
    const target = g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === id
    )!;
    g.world.player.position = position(0, 0);
    g.world.player.heading = 0;
    target.position = position(0, 180);
    target.velocity = position(0, 0);
    assert.ok(g.dispatch({ type: 'attack', shipId: id }).ok);
    for (let i = 0; i < 360; i++) g.step(1 / 60, { ...idle, fire: true, targetId: id });
    assert.ok(target.engines < 100 || target.hull < 100, `${id}: broadside hits`);
    assert.equal(g.activity, null);
  }
});

/**
 * Verify the scenario: attack validation rejects docked, self, dead, owned and salvage
 * targets.
 */
test('attack validation rejects docked, self, dead, owned and salvage targets', () => {
  const g = game(),
    target = g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'ashen-trader'
    )!;
  assert.equal(g.dispatch({ type: 'attack', shipId: target.id }).ok, false);
  g.dispatch({ type: 'undock' });
  for (const mutate of [
    /** Mark the target destroyed to verify the player cannot attack a dead hull. */
    (s: Ship) => (s.hull = 0),
    /** Mark the target salvage to verify it is excluded from attack eligibility. */
    (s: Ship) => (s.owner = 'salvage'),
    /**
     * Mark the target player-owned to verify friendly ownership is not offered as an attack
     * target.
     */
    (s: Ship) => (s.owner = 'player')
  ]) {
    mutate(target);
    assert.equal(g.canAttack(target.id), false);
    assert.equal(g.dispatch({ type: 'attack', shipId: target.id }).ok, false);
    target.hull = 100;
    target.owner = 'guild';
  }
  assert.equal(g.dispatch({ type: 'attack', shipId: g.world.player.id }).ok, false);
  assert.equal(g.dispatch({ type: 'attack', shipId: 'missing' }).ok, false);
  assert.deepEqual(g.world.relations.hostilePairs, []);
});

/**
 * Verify the scenario: raiding cargo respects commodity sizes, keeps the player hull and
 * conserves overflow.
 */
test('raiding cargo respects commodity sizes, keeps the player hull and conserves overflow', () => {
  const g = game(),
    target = disabledTarget(g);
  g.catalog.commodities.bulk = { id: 'bulk', name: 'Bulk cargo', unitSize: 3 };
  const player = g.world.player;
  player.cargo = { rations: 14 };
  target.cargo = { bulk: 4, parts: 5 };
  const before = totals([player, target]);
  assert.deepEqual(cargoTransferPlan(target, player, g.catalog).cargo, { bulk: 2 });
  assert.equal(sessionHud(g).action, 'board');
  const crew = player.crew,
    design = target.designId;
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' }).ok);
  assert.equal(g.world.player, player);
  assert.equal(player.crew, crew);
  assert.equal(cargoUsed(player, g.catalog), 20);
  assert.deepEqual(target.cargo, { bulk: 2, parts: 5 });
  assert.deepEqual(totals([player, target]), before);
  assert.equal(target.owner, 'guild');
  assert.equal(target.engines, 0);
  assert.equal(target.designId, design);
  assert.notEqual(g.traffic.get(target.id)!.motion.kind, 'captured');
  const again = g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' });
  assert.equal(again.ok, false);
  assert.deepEqual(totals([player, target]), before);
});

/**
 * Verify the scenario: cargo raids preserve foreign culture, inventory and the disabled
 * NPC through repeated reload.
 */
test('cargo raids preserve foreign culture, inventory and the disabled NPC through repeated reload', () => {
  let g = game();
  const target = disabledTarget(g, 'aster-thread');
  target.cargo = { rations: 8 };
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' }).ok);
  g.step(1 / 60, idle);
  for (let i = 0; i < 3; i++) g = loadSession(g.save(), g.catalog, g.services, g.activities);
  const a = g.traffic.get('aster-thread')!;
  assert.equal(g.world.player.id, 'wayward');
  assert.equal(g.world.player.cargo.rations, 8);
  assert.equal(a.cultureId, 'aster');
  assert.equal(a.ship.designId, 'aster-transit');
  assert.equal(a.ship.cargo.rations, 0);
  assert.equal(a.motion.kind, 'disabled');
  assert.equal(
    g.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
  assert.equal(g.dispatch({ type: 'board', shipId: a.ship.id, outcome: 'cargo' }).ok, false);
});

/**
 * Verify the scenario: Take ship captures a foreign hull and its cargo while retaining
 * captain culture.
 */
test('Take ship captures a foreign hull and its cargo while retaining captain culture', () => {
  const g = game(),
    target = disabledTarget(g, 'aster-thread'),
    old = g.world.player;
  target.cargo = { parts: 18 };
  old.cargo = { rations: 10 };
  const before = totals([old, target]);
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, outcome: 'capture' }).ok);
  assert.equal(g.world.player, target);
  assert.equal(g.captain.cultureId, 'frontier');
  assert.equal(target.designId, 'aster-transit');
  assert.equal(target.cargo.parts, 18);
  assert.equal(target.cargo.rations, 2);
  assert.equal(old.cargo.rations, 8);
  assert.equal(old.owner, 'salvage');
  assert.equal(g.canBoard(old.id), false);
  assert.deepEqual(totals([old, target]), before);
  const loaded = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(loaded.world.player.id, target.id);
  assert.equal(loaded.traffic.get(target.id)!.motion.kind, 'captured');
  assert.deepEqual(totals(loaded.world.ships), totals(g.world.ships));
});

/**
 * Verify the scenario: invalid boarding, empty holds and insufficient crew leave ships and
 * inventories unchanged.
 */
test('invalid boarding, empty holds and insufficient crew leave ships and inventories unchanged', () => {
  const g = game(),
    target = disabledTarget(g),
    old = g.world.player;
  target.cargo = {};
  const before = JSON.parse(g.save());
  assert.equal(g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' }).ok, false);
  assert.equal(g.dispatch({ type: 'board', shipId: 'missing', outcome: 'capture' }).ok, false);
  assert.deepEqual(JSON.parse(g.save()), before);
  old.crew = 2;
  target.cargo = { parts: 2 };
  assert.equal(g.dispatch({ type: 'board', shipId: target.id, outcome: 'capture' }).ok, false);
  assert.equal(g.world.player.id, old.id);
  assert.equal(target.owner, 'guild');
  target.position.x += 1000;
  assert.equal(g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' }).ok, false);
});

/**
 * Verify the scenario: boarding counts as fresh aggression and police pursue the player
 * across a hull capture.
 */
test('boarding counts as fresh aggression and police pursue the player across a hull capture', () => {
  for (const outcome of ['cargo', 'capture'] as const) {
    const g = game();
    g.dispatch({ type: 'undock' });
    const gate = g.definition.gates[0];
    g.world.player.position = { ...gate.position };
    assert.ok(g.dispatch({ type: 'jump', connectionId: 'ashen-to-kepler' }).ok);
    finishTransit(g);
    const target = disabledTarget(g, 'kepler-trader');
    const patrol = g.traffic.get('kepler-patrol')!;
    patrol.ship.position = position(target.position.x + 100, target.position.y);
    target.cargo = { parts: 4 };
    // An earlier fight is already hostile; boarding is still a new witnessed action.
    g.world.relations.declareHostile(g.world.player.id, target.id);
    assert.ok(g.dispatch({ type: 'board', shipId: target.id, outcome }).ok);
    assert.ok(g.world.relations.isHostile(g.world.player, patrol.ship));
    assert.ok(patrol.hostileTo.includes(g.world.player.id));
    const loaded = loadSession(g.save(), g.catalog, g.services, g.activities);
    assert.ok(
      loaded.world.relations.isHostile(
        loaded.world.player,
        loaded.traffic.get(patrol.ship.id)!.ship
      )
    );
  }
});

/**
 * Verify the scenario: native Aster traffic in Vesper can be attacked and its own patrol
 * responds.
 */
test('native Aster traffic in Vesper can be attacked and its own patrol responds', () => {
  const g = game();
  g.dispatch({ type: 'undock' });
  const gate = g.definition.gates.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (x) =>
      x.connections.some(
        /**
         * Check whether a fixture entry satisfies the presence or behavior condition asserted
         * here.
         */
        (c) => c.systemId === 'vesper'
      )
  )!;
  g.world.player.position = { ...gate.position };
  assert.ok(g.dispatch({ type: 'jump', connectionId: 'ashen-to-vesper' }).ok);
  finishTransit(g);
  assert.equal(g.definition.cultureId, 'aster');
  const target = g.traffic.get('aster-cradle')!,
    patrol = g.traffic.get('aster-warden')!;
  assert.ok(g.dispatch({ type: 'select', target: { kind: 'ship', id: target.ship.id } }).ok);
  assert.equal(sessionHud(g).action, 'attack');
  assert.ok(g.dispatch({ type: 'attack', shipId: target.ship.id }).ok);
  assert.ok(g.world.relations.isHostile(g.world.player, target.ship));
  assert.ok(g.world.relations.isHostile(g.world.player, patrol.ship));
});

/**
 * Verify the scenario: the optional raid supports cargo plunder as a complete alternative
 * to capture.
 */
test('the optional raid supports cargo plunder as a complete alternative to capture', () => {
  const base = game(),
    g = startRaid(base.catalog, base.services, base.activities);
  const target = disabledTarget(g);
  assert.ok(g.dispatch({ type: 'board', shipId: target.id, outcome: 'cargo' }).ok);
  assert.equal(g.activity!.state.raided, true);
  assert.equal(g.activity!.state.captured, undefined);
  assert.equal(g.world.player.id, 'wayward');
  g.world.player.position = { ...g.stationById('haven')!.position };
  assert.ok(g.dispatch({ type: 'dock', stationId: 'haven' }).ok);
  assert.equal(g.activity!.state.complete, true);
});
