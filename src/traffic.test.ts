import { jumpTravelSeconds } from './game/jump-travel';
import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startTrading, startRaid } from './game/start';
import { createCatalog, position, makeShip } from './content/universe';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { followTarget } from './game/follow';
import { RadioDirector } from './game/radio';
import { actorSystemId, type TrafficEvent } from './game/traffic';
import { distance, World, definitions, type Input } from './simulation';
const idle: Input = { turn: 0, thrust: 0, brake: true, fire: false };
/** Create an undocked trading fixture with the complete managed traffic ledger active. */
function game() {
  const g = startTrading(createCatalog(), createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  return g;
}
/**
 * Advance real fixed-step simulation so traffic schedules and physical motion remain
 * exercised together.
 */
function tick(g: ReturnType<typeof game>, seconds: number) {
  for (let n = 0; n < seconds * 60; n++) g.step(1 / 60, idle);
}
/**
 * Move the fixture to its current exit and issue a validated jump without spending test
 * time on the approach flight.
 */
function jumpNow(g: ReturnType<typeof game>) {
  const gate = g.definition.gates[0];
  g.world.player.position = { ...gate.position };
  g.world.player.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(g);
}
/**
 * Verify the scenario: both real freighters complete deliveries, jump, unload and reverse
 * their route.
 */
test('both real freighters complete deliveries, jump, unload and reverse their route', () => {
  const g = game(),
    seen = new Set<string>(),
    first = g.traffic.get('ashen-trader')!,
    ident = first.ship.id;
  for (
    let n = 0;
    n < 900 * 60 && (first.journeys < 2 || g.traffic.get('kepler-trader')!.journeys < 2);
    n++
  ) {
    g.step(1 / 60, idle);
    seen.add(first.motion.kind);
  }
  assert.ok(seen.has('flight'));
  assert.ok(seen.has('charging'));
  assert.ok(seen.has('transit'));
  assert.ok(seen.has('waiting'));
  assert.ok(first.journeys >= 2);
  assert.equal(first.ship.id, ident);
  assert.ok(
    g.traffic.actors
      .filter(
        /** Select the fixture identities required for this persistence or uniqueness check. */
        (a) => a.ship.id === 'ashen-trader' || a.ship.id === 'kepler-trader'
      )
      .every(
        /** Require every fixture entry to satisfy the invariant asserted by this scenario. */
        (a) => a.journeys >= 2
      )
  );
  assert.equal(g.captain.credits, 500);
  assert.deepEqual(g.markets, {});
});
/**
 * Verify the scenario: active waypoint motion visits the gate physically and carries its
 * declared manifest.
 */
test('active waypoint motion visits the gate physically and carries its declared manifest', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  tick(g, 8);
  assert.equal(a.motion.kind, 'flight');
  assert.equal(a.ship.cargo.rations, 12);
  const p = { ...a.ship.position };
  tick(g, 1);
  assert.ok(distance(p, a.ship.position) > 20);
  for (let n = 0; n < 300 * 60 && a.motion.kind !== 'charging'; n++) g.step(1 / 60, idle);
  assert.equal(a.motion.kind, 'charging');
  assert.ok(distance(a.ship.position, g.definition.gates[0].position) < 12);
  assert.ok(
    g.traffic.events.every(
      /** Require every fixture entry to satisfy the invariant asserted by this scenario. */
      (e) => e.actorId
    )
  );
});
/**
 * Verify the scenario: observed/unobserved handoff preserves exact identity, position,
 * damage and PDC state.
 */
test('observed/unobserved handoff preserves exact identity, position, damage and PDC state', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  tick(g, 12);
  a.ship.hull = 43;
  g.world.defenceFor(a.ship).interceptions = 9;
  const p = { ...a.ship.position };
  jumpNow(g);
  assert.equal(a.ship.hull, 43);
  tick(g, 1 / 60);
  assert.ok(
    distance(p, a.ship.position) <= definitions[a.ship.kind].speed * (jumpTravelSeconds + 1 / 60)
  );
  jumpNow(g);
  assert.equal(
    g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === a.ship.id
    ),
    a.ship
  );
  assert.equal(g.world.defenceFor(a.ship).interceptions, 9);
  assert.equal(
    g.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
  assert.ok(
    Object.values(g.systems).every(
      /** Require every fixture entry to satisfy the invariant asserted by this scenario. */
      (s) =>
        !s.ships.some(
          /**
           * Check whether a fixture entry satisfies the presence or behavior condition asserted
           * here.
           */
          (s) => s.id === a.ship.id
        )
    )
  );
});
/**
 * Verify the scenario: following reacquires the same freighter across a manually commanded
 * jump.
 */
test('following reacquires the same freighter across a manually commanded jump', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  g.followedActorId = a.ship.id;
  for (let n = 0; n < 400 * 60 && a.motion.kind !== 'transit'; n++) g.step(1 / 60, idle);
  assert.equal(a.motion.kind, 'transit');
  assert.equal(followTarget(g)?.contact?.kind, 'gate');
  jumpNow(g);
  assert.equal(g.followedActorId, a.ship.id);
  assert.equal(followTarget(g)?.contact?.id, a.ship.id);
  tick(g, 5);
  assert.equal(followTarget(g)?.contact?.id, a.ship.id);
  assert.equal(
    g.world.ships.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === a.ship.id
    ),
    a.ship
  );
});
/** Verify the scenario: a selected ship leaving the system still produces a loadable save. */
test('a selected ship leaving the system still produces a loadable save', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  g.selection = { kind: 'ship', id: a.ship.id };
  for (let n = 0; n < 400 * 60 && a.motion.kind !== 'transit'; n++) g.step(1 / 60, idle);
  assert.equal(a.motion.kind, 'transit');
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(restored.traffic.get(a.ship.id)!.motion.kind, 'transit');
  assert.equal(restored.selection, null);
  tick(restored, 5);
  assert.equal(actorSystemId(restored.traffic.get(a.ship.id)!), 'kepler');
});
/**
 * Verify the scenario: combat interrupts a job, separation resumes it, and disabled ships
 * stay disabled.
 */
test('combat interrupts a job, separation resumes it, and disabled ships stay disabled', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  tick(g, 8);
  g.world.player.position = { x: a.ship.position.x + 100, y: a.ship.position.y, z: 0 };
  assert.ok(g.dispatch({ type: 'attack', shipId: a.ship.id }).ok);
  tick(g, 1 / 60);
  assert.equal(a.motion.kind, 'interrupted');
  assert.ok(
    g.traffic.events.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (e) => e.topic === 'ship.attacked'
    )
  );
  g.world.player.position = position(-1200, 0);
  tick(g, 1);
  assert.equal(a.motion.kind, 'flight');
  a.ship.engines = 0;
  tick(g, 10);
  assert.equal(a.motion.kind, 'disabled');
  assert.equal(a.ship.engines, 0);
});
/**
 * Verify the scenario: capturing or destroying traffic ends its job and prevents respawn
 * after save and travel.
 */
test('capturing or destroying traffic ends its job and prevents respawn after save and travel', () => {
  for (const capture of [true, false]) {
    const g = game(),
      a = g.traffic.get('ashen-trader')!;
    if (capture) {
      a.ship.engines = 0;
      a.ship.position = { x: g.world.player.position.x + 80, y: g.world.player.position.y, z: 0 };
      a.ship.velocity = position(0, 0);
      assert.ok(g.dispatch({ type: 'board', shipId: a.ship.id, tactic: 'intimidate' }).ok);
    } else {
      a.ship.hull = 0;
      tick(g, 1 / 60);
    }
    assert.equal(a.motion.kind, capture ? 'captured' : 'destroyed');
    const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
    jumpNow(restored);
    tick(restored, 120);
    jumpNow(restored);
    assert.equal(
      restored.world.ships.filter(
        /** Select the fixture identities required for this persistence or uniqueness check. */
        (s) => s.id === a.ship.id
      ).length,
      capture ? 1 : 0
    );
  }
});
/**
 * Verify the scenario: schema 2 adopts NPC damage and positions; original raid remains
 * independent of traffic.
 */
test('schema 2 adopts NPC damage and positions; original raid remains independent of traffic', () => {
  const g = game();
  g.traffic.actors = [];
  const old = JSON.parse(g.save());
  old.version = 2;
  delete old.traffic;
  delete old.clock;
  delete old.followedActorId;
  old.systems.ashen.ships[0].hull = 37;
  const p = { ...old.systems.ashen.ships[0].position },
    restored = loadSession(JSON.stringify(old), g.catalog, g.services, g.activities);
  assert.equal(restored.traffic.get('ashen-trader')!.ship.hull, 37);
  assert.deepEqual(restored.traffic.get('ashen-trader')!.ship.position, p);
  const raid = startRaid(g.catalog, g.services, g.activities);
  assert.equal(raid.traffic.actors.length, 0);
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(raid.save(), g.catalog, g.services, g.activities)
  );
});
/**
 * Verify the scenario: invalid traffic references, duplicate ownership and malformed legs
 * are rejected.
 */
test('invalid traffic references, duplicate ownership and malformed legs are rejected', () => {
  const g = game();
  tick(g, 8);
  const raw = JSON.parse(g.save());
  for (const change of [
    /** Duplicate a saved actor to verify stable NPC identities cannot be restored twice. */
    (d: any) => d.traffic.push(d.traffic[0]),
    /** Break a saved freight station reference to exercise job-config validation. */
    (d: any) => (d.traffic[0].job.config.route[1].stationId = 'missing'),
    /** Give a flight leg an invalid arrival time to exercise motion validation. */
    (d: any) => (d.traffic[0].motion.leg.arriveAt = -1),
    /**
     * Change ownership without the required captured motion state to test ledger consistency
     * checks.
     */
    (d: any) => (d.traffic[0].ship.owner = 'player'),
    /** Duplicate a ledger-owned hull in a system snapshot to verify single ownership on import. */
    (d: any) => d.systems.ashen.ships.push(d.traffic[0].ship)
  ]) {
    const d = structuredClone(raw);
    change(d);
    assert.throws(
      /**
       * Attempt save decoding and migration so the assertion can verify that invalid input is
       * rejected.
       */
      () => loadSession(JSON.stringify(d), g.catalog, g.services, g.activities)
    );
  }
});
/**
 * Verify the scenario: radio reports real manifests, deduplicates, expires and prioritizes
 * distress over routine chatter.
 */
test('radio reports real manifests, deduplicates, expires and prioritizes distress over routine chatter', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!,
    radio = new RadioDirector(g.catalog);
  a.ship.cargo = { rations: 12 };
  /**
   * Create a deterministic traffic announcement for radio scheduling, filtering and
   * deduplication checks.
   */
  const event = (id: string, topic: TrafficEvent['topic'], at: number): TrafficEvent => ({
    id,
    actorId: a.ship.id,
    systemId: 'ashen',
    at,
    topic,
    values: { destination: 'Relay', cargo: '12 rations' },
    urgent: topic === 'ship.attacked'
  });
  const e = event('one', 'freight.depart', 0);
  radio.update(0, [e, e], g.traffic, 'ashen', a.ship.position);
  assert.equal(radio.active.length, 1);
  assert.match(radio.active[0].text, /12 rations/);
  radio.update(1, [event('two', 'ship.attacked', 1)], g.traffic, 'ashen', a.ship.position);
  assert.equal(radio.active.length, 1);
  assert.ok(radio.active[0].urgent);
  assert.match(radio.active[0].text, /Mayday/);
  radio.update(8, [], g.traffic, 'ashen', a.ship.position);
  assert.equal(radio.active.length, 0);
  radio.update(9, [event('one', 'freight.depart', 9)], g.traffic, 'ashen', a.ship.position);
  assert.equal(radio.active.length, 0);
});
/**
 * Verify the scenario: radio filters other systems and distant ships; capture removes
 * stale broadcasts.
 */
test('radio filters other systems and distant ships; capture removes stale broadcasts', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!,
    radio = new RadioDirector(g.catalog),
    e: TrafficEvent = {
      id: 'far',
      actorId: a.ship.id,
      systemId: 'ashen',
      at: 0,
      topic: 'freight.depart',
      values: { destination: 'Relay', cargo: '12 rations' }
    };
  radio.update(0, [e], g.traffic, 'ashen', position(1300, 0));
  assert.equal(radio.active.length, 0);
  radio.update(1, [], g.traffic, 'ashen', position(1300, 0), a.ship.id);
  assert.equal(radio.active.length, 1);
  a.motion = { kind: 'captured', systemId: 'ashen' };
  radio.update(2, [], g.traffic, 'ashen', a.ship.position);
  assert.equal(radio.active.length, 0);
  radio.update(3, [{ ...e, id: 'another' }], g.traffic, 'kepler', a.ship.position, a.ship.id);
  assert.equal(radio.active.length, 0);
});

/**
 * Verify the scenario: schema 2 migration removes managed actors from every old system
 * snapshot.
 */
test('schema 2 migration removes managed actors from every old system snapshot', () => {
  const g = game();
  g.traffic.actors = [];
  jumpNow(g);
  const old = JSON.parse(g.save());
  old.version = 2;
  delete old.traffic;
  delete old.clock;
  delete old.followedActorId;
  const restored = loadSession(JSON.stringify(old), g.catalog, g.services, g.activities);
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(restored.save(), restored.catalog, restored.services, restored.activities)
  );
  assert.ok(
    Object.values(restored.systems).every(
      /** Require every fixture entry to satisfy the invariant asserted by this scenario. */
      (s) =>
        !s.ships.some(
          /**
           * Check whether a fixture entry satisfies the presence or behavior condition asserted
           * here.
           */
          (s) => restored.traffic.get(s.id)
        )
    )
  );
});

/**
 * Verify the scenario: a disabled freighter announces engine loss even after combat
 * already interrupted its job.
 */
test('a disabled freighter announces engine loss even after combat already interrupted its job', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  tick(g, 8);
  g.world.player.position = { ...a.ship.position };
  g.dispatch({ type: 'attack', shipId: a.ship.id });
  tick(g, 1 / 60);
  assert.equal(a.motion.kind, 'interrupted');
  a.ship.engines = 0;
  tick(g, 1 / 60);
  assert.equal(a.motion.kind, 'disabled');
  assert.ok(
    g.traffic.events.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (e) => e.topic === 'ship.disabled'
    )
  );
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), g.catalog, g.services, g.activities)
  );
});
/**
 * Verify the scenario: docked gameplay does not advance the simulation clock or background
 * journeys.
 */
test('docked gameplay does not advance the simulation clock or background journeys', () => {
  const g = startTrading(createCatalog(), createServices(), createActivities()),
    snapshot = JSON.stringify(g.traffic.actors);
  tick(g, 20);
  assert.equal(g.clock, 0);
  assert.equal(JSON.stringify(g.traffic.actors), snapshot);
});

/** Verify the scenario: a freighter remembers vessel hostility after jumping and reloading. */
test('a freighter remembers vessel hostility after jumping and reloading', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!;
  g.dispatch({ type: 'attack', shipId: a.ship.id });
  g.world.player.position = position(-1200, 0);
  for (let n = 0; n < 450 * 60 && a.motion.kind !== 'transit'; n++) g.step(1 / 60, idle);
  assert.equal(a.motion.kind, 'transit');
  jumpNow(g);
  tick(g, 5);
  assert.ok(g.world.relations.isHostile(g.world.player, a.ship));
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.ok(
    restored.world.relations.isHostile(restored.world.player, restored.traffic.get(a.ship.id)!.ship)
  );
});

/**
 * Verify the scenario: public transport boards passengers, flies between both ports and
 * preserves its manifest on reload.
 */
test('public transport boards passengers, flies between both ports and preserves its manifest on reload', () => {
  const g = game(),
    bus = g.traffic.get('reach-transit')!;
  assert.equal(g.traffic.describe(bus).manifest, '0 passengers aboard');
  tick(g, 12);
  assert.equal(bus.motion.kind, 'flight');
  assert.equal(g.traffic.describe(bus).manifest, '24 passengers aboard');
  assert.deepEqual(bus.ship.cargo, {});
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities),
    r = restored.traffic.get(bus.ship.id)!;
  assert.equal(restored.traffic.describe(r).manifest, '24 passengers aboard');
  const seen = new Set<string>();
  for (let n = 0; n < 600 * 60 && r.journeys < 2; n++) {
    restored.step(1 / 60, idle);
    const id = actorSystemId(r);
    if (id) seen.add(id);
  }
  assert.ok(seen.has('ashen') && seen.has('kepler'));
  assert.ok(r.journeys >= 2);
  assert.deepEqual(restored.markets, {});
});
/**
 * Verify the scenario: leisure liner completes scenic stops in its home system and emits
 * relevant commentary.
 */
test('legacy local liner circuits still complete scenic stops and emit relevant commentary', () => {
  const catalog = createCatalog();
  const spawn = catalog.systems.ashen.traffic.find(
    /** Select the original liner to exercise legacy circuit config. */ (t) =>
      t.ship.id === 'ashen-liner'
  )!;
  spawn.job.config = {
    passengers: 80,
    stopSeconds: 9,
    stops: [
      { kind: 'point', systemId: 'ashen', position: position(1300, 700), label: 'Ashen panorama' },
      { kind: 'point', systemId: 'ashen', position: position(300, 2000), label: 'Northern limb' },
      { kind: 'station', systemId: 'ashen', stationId: 'haven' }
    ]
  };
  const g = startTrading(catalog, createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  const liner = g.traffic.get('ashen-liner')!,
    topics = new Set<string>();
  for (let n = 0; n < 750 * 60 && liner.journeys < 2; n++) {
    g.step(1 / 60, idle);
    assert.equal(actorSystemId(liner), 'ashen');
    for (const e of g.traffic.events) if (e.actorId === liner.ship.id) topics.add(e.topic);
  }
  assert.ok(liner.journeys >= 2);
  assert.ok(topics.has('liner.view'));
  assert.ok(topics.has('liner.depart'));
  assert.match(g.traffic.describe(liner).manifest, /80 guests/);
  assert.ok((liner.ship.cargo['fine-spirits'] ?? 0) > 0);
  assert.match(g.traffic.describe(liner).manifest, /fine spirits/);
});
/**
 * Verify the scenario: police are authored only in Kepler, patrol physically and do not
 * create hostility without aggression.
 */
test('police are authored only in Kepler, patrol physically and do not create hostility without aggression', () => {
  const g = game();
  assert.equal(
    g.world.ships.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (s) => s.factionId === 'police'
    ),
    false
  );
  jumpNow(g);
  const patrol = g.traffic.get('kepler-patrol')!,
    before = { ...patrol.ship.position };
  tick(g, 12);
  assert.ok(distance(before, patrol.ship.position) > 100);
  assert.equal(patrol.motion.kind, 'flight');
  assert.deepEqual(g.world.relations.hostilePairs, []);
  assert.equal(g.world.player.hull, 100);
  for (let i = 0; i < 450 * 60 && patrol.journeys < 2; i++) g.step(1 / 60, idle);
  assert.ok(patrol.journeys >= 2);
  assert.equal(actorSystemId(patrol), 'kepler');
});
/**
 * Verify the scenario: nearby police intervene on aggression, remember the offender, and
 * resume their patrol after separation.
 */
test('nearby police intervene on aggression, remember the offender, and resume their patrol after separation', () => {
  const g = game();
  jumpNow(g);
  const patrol = g.traffic.get('kepler-patrol')!,
    victim = g.traffic.get('kepler-trader')!;
  g.world.player.position = { x: patrol.ship.position.x + 120, y: patrol.ship.position.y, z: 0 };
  assert.ok(g.dispatch({ type: 'attack', shipId: victim.ship.id }).ok);
  assert.ok(g.world.relations.isHostile(patrol.ship, g.world.player));
  assert.equal(g.world.relations.isHostile(patrol.ship, victim.ship), false);
  tick(g, 1 / 60);
  assert.equal(patrol.motion.kind, 'interrupted');
  assert.ok(
    g.traffic.events.some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (e) => e.topic === 'patrol.respond' && e.urgent
    )
  );
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities),
    r = restored.traffic.get(patrol.ship.id)!;
  assert.ok(restored.world.relations.isHostile(r.ship, restored.world.player));
  restored.world.player.position = position(restored.definition.radius * 0.9, 0);
  tick(restored, 50);
  assert.notEqual(r.motion.kind, 'interrupted');
  assert.equal(r.ship.hull, 100);
});
/**
 * Verify the scenario: a distant patrol does not receive an attack order outside its
 * response range.
 */
test('a distant patrol does not receive an attack order outside its response range', () => {
  const g = game();
  jumpNow(g);
  const patrol = g.traffic.get('kepler-patrol')!,
    victim = g.traffic.get('kepler-trader')!;
  victim.ship.position = position(g.definition.radius * 0.9, 0);
  g.world.player.position = position(g.definition.radius * 0.9 - 100, 0);
  g.dispatch({ type: 'attack', shipId: victim.ship.id });
  assert.equal(g.world.relations.isHostile(patrol.ship, g.world.player), false);
});
/**
 * Verify the scenario: schema 3 migration preserves identity, physical progress, damage,
 * equipment and follow while adding new content once.
 */
test('schema 3 migration preserves identity, physical progress, damage, equipment and follow while adding new content once', () => {
  const catalog = createCatalog(),
    services = createServices(),
    activities = createActivities(),
    old = readFileSync(new URL('./fixtures/traffic-v3.json', import.meta.url), 'utf8'),
    raw = JSON.parse(old),
    saved = raw.traffic.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (a: any) => a.ship.id === 'ashen-trader'
    );
  const migrated = loadSession(old, catalog, services, activities),
    a = migrated.traffic.get(saved.ship.id)!;
  assert.equal(a.motion.kind, 'flight');
  assert.deepEqual(a.ship.position, {
    x: saved.ship.position.x * 5,
    y: saved.ship.position.y * 5,
    z: saved.ship.position.z * 5
  });
  assert.equal(a.ship.hull, 43);
  assert.equal(migrated.world.defenceFor(a.ship).interceptions, 7);
  assert.equal(migrated.clock, raw.clock);
  assert.equal(migrated.followedActorId, a.ship.id);
  assert.equal(
    migrated.traffic.actors.length,
    Object.values(catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  const restored = loadSession(migrated.save(), catalog, services, activities);
  assert.equal(
    restored.traffic.actors.length,
    Object.values(catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  assert.equal(
    restored.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
  assert.deepEqual(restored.traffic.get(a.ship.id)!.ship.position, {
    x: saved.ship.position.x * 5,
    y: saved.ship.position.y * 5,
    z: saved.ship.position.z * 5
  });
});
/**
 * Verify the scenario: each old freight phase migrates into a legal generic task and
 * remains playable.
 */
test('each old freight phase migrates into a legal generic task and remains playable', () => {
  const catalog = createCatalog(),
    services = createServices(),
    activities = createActivities(),
    base = JSON.parse(readFileSync(new URL('./fixtures/traffic-v3.json', import.meta.url), 'utf8'));
  for (const phase of [
    'loading',
    'outbound',
    'charging',
    'transit',
    'inbound',
    'unloading',
    'interrupted',
    'disabled',
    'captured',
    'destroyed'
  ]) {
    const d = structuredClone(base),
      a = d.traffic[0];
    a.phase = phase;
    d.followedActorId = null;
    d.selection = null;
    a.until = d.clock + 3;
    if (!['outbound', 'inbound'].includes(phase)) a.leg = null;
    if (phase === 'transit') a.systemId = null;
    else if (phase === 'inbound' || phase === 'unloading') {
      a.systemId = 'kepler';
      a.ship.position = { x: -1000, y: -200, z: 0 };
      if (a.leg) {
        a.leg.from = { ...a.ship.position };
        a.leg.to = { x: -245, y: 275, z: 0 };
      }
    }
    if (phase === 'captured') a.ship.owner = 'salvage';
    if (phase === 'destroyed') a.ship.hull = 0;
    if (phase === 'disabled') a.ship.engines = 0;
    const g = loadSession(JSON.stringify(d), catalog, services, activities);
    assert.doesNotThrow(
      /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
      () => loadSession(g.save(), catalog, services, activities)
    );
    tick(g, 1);
  }
});
/**
 * Verify the scenario: captured actors in an older save are never reseeded when new roles
 * are added.
 */
test('captured actors in an older save are never reseeded when new roles are added', () => {
  const g = game(),
    a = g.traffic.get('reach-transit')!;
  a.ship.engines = 0;
  a.ship.position = { x: g.world.player.position.x + 80, y: g.world.player.position.y, z: 0 };
  a.ship.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'board', shipId: a.ship.id, tactic: 'intimidate' }).ok);
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  tick(restored, 60);
  assert.equal(restored.traffic.get(a.ship.id)!.motion.kind, 'captured');
  assert.equal(
    restored.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
});
/**
 * Verify the scenario: unknown policies, incompatible motion fields and invalid job
 * config/state are rejected on import.
 */
test('unknown policies, incompatible motion fields and invalid job config/state are rejected on import', () => {
  const g = game();
  tick(g, 8);
  const raw = JSON.parse(g.save());
  for (const change of [
    /**
     * Replace a saved job kind with an unregistered policy to verify import fails without
     * losing behavior.
     */
    (d: any) => (d.traffic[0].job.kind = 'unregistered'),
    /** Insert an unsupported freight stage so the policy rejects its saved state. */
    (d: any) => (d.traffic[0].job.state.next = 'not-a-stage'),
    /** Break a saved job's destination system reference to exercise configuration validation. */
    (d: any) => (d.traffic[0].job.config.route[1].systemId = 'missing'),
    /** Remove a required flight leg to verify incomplete motion records are rejected. */
    (d: any) => delete d.traffic[0].motion.leg,
    /** Combine waiting motion with an incompatible action to test motion/action consistency. */
    (d: any) =>
      (d.traffic[0].motion = {
        kind: 'waiting',
        systemId: 'ashen',
        until: 2,
        action: d.traffic[0].motion.action
      }),
    /**
     * Build an inconsistent transit record to verify departure and arrival locations are
     * checked together.
     */
    (d: any) =>
      (d.traffic[0].motion = {
        kind: 'transit',
        systemId: 'ashen',
        fromSystemId: 'ashen',
        arrivalSystemId: 'kepler',
        arrivalGateId: 'bad',
        until: 2,
        action: d.traffic[0].motion.action
      })
  ]) {
    const d = structuredClone(raw);
    change(d);
    assert.throws(
      /**
       * Attempt save decoding and migration so the assertion can verify that invalid input is
       * rejected.
       */
      () => loadSession(JSON.stringify(d), g.catalog, g.services, g.activities)
    );
  }
});
/**
 * Verify the scenario: unobserved actors of every role switch to physical simulation
 * without changing their positions.
 */
test('unobserved actors of every role switch to physical simulation without changing their positions', () => {
  const g = game();
  tick(g, 15);
  const positions = new Map(
    g.traffic.actors
      .filter(
        /** Keep actors in the system whose physical/background handoff is being checked. */
        (a) => actorSystemId(a) === 'kepler'
      )
      .map(
        /** Capture fixture positions for comparison across simulation or persistence boundaries. */
        (a) => [a.ship.id, { ...a.ship.position }]
      )
  );
  const world = new World(
    [makeShip('observer', 'Observer', 'cutter', 'player', 0, 0)],
    'observer',
    g.catalog.systems.kepler.radius
  );
  g.traffic.materialize(world, 'kepler');
  for (const [id, p] of positions) assert.deepEqual(g.traffic.get(id)!.ship.position, p);
  assert.equal(
    world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === 'kepler-patrol'
    ).length,
    1
  );
});

/**
 * Verify the scenario: a police response warning is deduplicated when the same attack
 * order is repeated.
 */
test('a police response warning is deduplicated when the same attack order is repeated', () => {
  const g = game();
  jumpNow(g);
  const victim = g.traffic.get('kepler-trader')!,
    patrol = g.traffic.get('kepler-patrol')!;
  for (let i = 0; i < 5; i++) g.dispatch({ type: 'attack', shipId: victim.ship.id });
  tick(g, 1 / 60);
  assert.equal(
    g.traffic.events.filter(
      /** Select announcements belonging to the speaker exercised by this radio scenario. */
      (e) => e.actorId === patrol.ship.id && e.topic === 'patrol.respond'
    ).length,
    1
  );
});
/**
 * Verify the scenario: interruption freezes a waiting task instead of completing its timer
 * during combat.
 */
test('interruption freezes a waiting task instead of completing its timer during combat', () => {
  const g = game(),
    a = g.traffic.get('reach-transit')!;
  tick(g, 2);
  assert.equal(a.motion.kind, 'waiting');
  g.world.player.position = { ...a.ship.position };
  g.dispatch({ type: 'attack', shipId: a.ship.id });
  tick(g, 1 / 60);
  assert.equal(a.motion.kind, 'interrupted');
  a.ship.engines = 0;
  tick(g, 15);
  assert.equal(a.motion.kind, 'disabled');
  a.ship.engines = 100;
  g.world.player.position = position(1400, -500);
  tick(g, 1 / 60);
  assert.equal(a.motion.kind, 'waiting');
  assert.equal(g.traffic.describe(a).manifest, '0 passengers aboard');
  tick(g, 9);
  assert.equal(g.traffic.describe(a).manifest, '24 passengers aboard');
});

/**
 * Verify the scenario: civilian passenger and leisure policies evade rather than firing
 * broadsides at nearby hostiles.
 */
test('civilian passenger and leisure policies evade rather than firing broadsides at nearby hostiles', () => {
  for (const id of ['reach-transit', 'ashen-liner']) {
    const g = game(),
      a = g.traffic.get(id)!;
    g.world.player.position = { x: a.ship.position.x - 140, y: a.ship.position.y, z: 0 };
    g.world.relations.declareHostile(a.ship.id, g.world.player.id);
    const before = distance(g.world.player.position, a.ship.position);
    for (let i = 0; i < 300; i++) {
      g.step(1 / 60, idle);
      assert.equal(
        g.world.events.some(
          /**
           * Check whether a fixture entry satisfies the presence or behavior condition asserted
           * here.
           */
          (e) => e.type === 'fire' && distance(e.position, a.ship.position) < 5
        ),
        false
      );
    }
    assert.ok(distance(g.world.player.position, a.ship.position) > before + 120);
    assert.equal(g.world.player.hull, 100);
  }
});

/**
 * Verify the scenario: repeated save/load across every role preserves the complete ledger
 * through running journeys.
 */
test('repeated save/load across every role preserves the complete ledger through running journeys', () => {
  let g = game();
  for (let i = 0; i < 36000; i++) {
    g.step(1 / 60, idle);
    if (i % 450 === 0) {
      const raw = g.save(),
        expected = JSON.parse(raw).traffic,
        restored = loadSession(raw, g.catalog, g.services, g.activities);
      assert.deepEqual(JSON.parse(restored.save()).traffic, expected);
      assert.equal(
        new Set(
          restored.world.ships.map(
            /** Read fixture identities for uniqueness, routing or persistence comparisons. */
            (s) => s.id
          )
        ).size,
        restored.world.ships.length
      );
      g = restored;
    }
  }
  assert.equal(
    g.traffic.actors.length,
    Object.values(g.catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  assert.ok(g.traffic.get('reach-transit')!.journeys > 0);
});
