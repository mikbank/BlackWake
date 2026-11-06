import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createCatalog, makeShip, position } from './content/universe';
import { assignShipDesign } from './content/identity';
import { startTrading } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { createRadioTemplates } from './game/radio-templates';
import { RadioDirector } from './game/radio';
import { World, type Input } from './simulation';
import {
  createShipModel,
  disposeShipModel,
  shipModelBuilders,
  validateShipModelProviders
} from './ship-model';
import { View } from './view';
import type { TrafficEvent } from './game/traffic';
const idle: Input = { turn: 0, thrust: 0, brake: true, fire: false };
/**
 * Build a second test-only culture, foreign hulls and phrase overrides to exercise
 * identity independently of geography.
 */
function fixture() {
  const c = createCatalog();
  c.shipDesigns['fixture-cutter'] = {
    id: 'fixture-cutter',
    name: 'Foreign cutter',
    kind: 'cutter',
    modelId: 'industrial-cutter'
  };
  c.shipDesigns['fixture-merchant'] = {
    id: 'fixture-merchant',
    name: 'Foreign merchant',
    kind: 'merchant',
    modelId: 'industrial-merchant'
  };
  c.radioProfiles['fixture-formal'] = {
    id: 'fixture-formal',
    templates: {
      'navigation.arrival': ['B control: {speaker} requests approach to {destination}.'],
      'freight.depart': ['B dispatch: {destination}, manifest {cargo}.']
    }
  };
  c.cultures['fixture-b'] = {
    id: 'fixture-b',
    name: 'Fixture B',
    radioProfileId: 'fixture-formal',
    shipDesigns: { cutter: ['fixture-cutter'], merchant: ['fixture-merchant'] }
  };
  c.systems.kepler.cultureId = 'fixture-b';
  c.radioProfiles.frontier.templates['navigation.arrival'] = [
    'A voice: {speaker} inbound for {destination}.'
  ];
  c.validate();
  return c;
}
/** Create and undock a session using the test identity catalog. */
function game() {
  const g = startTrading(fixture(), createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  return g;
}
/**
 * Advance the fixture in fixed physics steps so jobs, travel and radio use real simulated
 * time.
 */
function tick(g: ReturnType<typeof game>, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) g.step(1 / 60, idle);
}
/** Place the fixture at its exit and perform a validated jump to the connected system. */
function jump(g: ReturnType<typeof game>) {
  const gate = g.definition.gates[0];
  g.world.player.position = { ...gate.position };
  g.world.player.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(g);
}
/** Build a repeatable semantic arrival announcement for speaker-culture radio checks. */
function event(actorId: string, systemId: string, id = 'arrival'): TrafficEvent {
  return {
    id,
    actorId,
    systemId,
    at: 0,
    topic: 'navigation.arrival',
    values: { destination: 'Relay' }
  };
}

/**
 * Verify the scenario: current content resolves both cultures and role-specific designs
 * across registered systems.
 */
test('current content resolves both cultures and role-specific designs across registered systems', () => {
  const c = createCatalog(),
    g = startTrading(c, createServices(), createActivities());
  assert.equal(Object.keys(c.cultures).length, 2);
  assert.ok(c.systems.ashen && c.systems.kepler && c.systems.vesper);
  assert.equal(g.captain.cultureId, 'frontier');
  assert.equal(g.world.player.designId, 'industrial-cutter');
  for (const a of g.traffic.actors) {
    assert.equal(
      a.cultureId,
      c.systems[a.homeSystemId].traffic.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (t) => t.ship.id === a.ship.id
      )?.cultureId ?? c.systems[a.homeSystemId].cultureId
    );
    const culture = c.cultures[a.cultureId];
    assert.ok(
      (culture.roleDesigns?.[a.job.kind] ?? culture.shipDesigns[a.ship.kind]).includes(
        a.ship.designId!
      )
    );
  }
  validateShipModelProviders(c.shipDesigns);
});

/**
 * Verify the scenario: spawn culture and a foreign-built hull can be authored
 * independently of system, faction and job.
 */
test('spawn culture and a foreign-built hull can be authored independently of system, faction and job', () => {
  const c = fixture(),
    spawn = c.systems.ashen.traffic[0];
  spawn.cultureId = 'fixture-b';
  spawn.ship.designId = 'industrial-merchant';
  c.validate();
  const g = startTrading(c, createServices(), createActivities()),
    a = g.traffic.get(spawn.ship.id)!;
  assert.equal(a.cultureId, 'fixture-b');
  assert.equal(a.homeSystemId, 'ashen');
  assert.equal(a.ship.factionId, 'guild');
  assert.equal(a.job.kind, 'freight');
  assert.equal(a.ship.designId, 'industrial-merchant');
  assert.equal(g.definition.cultureId, 'frontier');
});

/**
 * Verify the scenario: a culture A visitor retains its hull and radio voice while
 * travelling into culture B and reloading.
 */
test('a culture A visitor retains its hull and radio voice while travelling into culture B and reloading', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!,
    design = a.ship.designId;
  g.followedActorId = a.ship.id;
  for (let i = 0; i < 450 * 60 && a.motion.kind !== 'transit'; i++) g.step(1 / 60, idle);
  assert.equal(a.motion.kind, 'transit');
  jump(g);
  assert.equal(g.definition.cultureId, 'fixture-b');
  for (let i = 0; i < 600 && a.motion.systemId !== 'kepler'; i++) g.step(1 / 60, idle);
  assert.equal(a.motion.systemId, 'kepler');
  assert.equal(a.cultureId, 'frontier');
  assert.equal(a.ship.designId, design);
  // Historical transit chatter is discarded; a fresh local event still uses the visitor's own voice.
  g.radio.update(
    g.clock,
    [{ ...event(a.ship.id, 'kepler'), at: g.clock }],
    g.traffic,
    'kepler',
    a.ship.position,
    a.ship.id
  );
  assert.match(
    g.radio.active.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (b) => b.actorId === a.ship.id
    )!.text,
    /^A voice:/
  );
  assert.equal(g.captain.cultureId, 'frontier');
  assert.equal(g.world.player.designId, 'industrial-cutter');
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities),
    r = restored.traffic.get(a.ship.id)!;
  assert.equal(r.cultureId, 'frontier');
  assert.equal(r.ship.designId, design);
  assert.equal(r.motion.systemId, 'kepler');
  const radio = new RadioDirector(restored.catalog);
  radio.update(0, [event(r.ship.id, 'kepler')], restored.traffic, 'kepler', r.ship.position);
  assert.match(radio.active[0].text, /^A voice:/);
  const model = createShipModel(r.ship, restored.catalog.shipDesigns);
  assert.equal(model.userData.designId, design);
  disposeShipModel(model);
});

/**
 * Verify the scenario: editing a home culture affects new spawns while existing identities
 * and designs stay explicit.
 */
test('editing a home culture affects new spawns while existing identities and designs stay explicit', () => {
  const g = game(),
    a = g.traffic.get('ashen-trader')!,
    raw = g.save();
  g.catalog.systems.ashen.cultureId = 'fixture-b';
  g.catalog.systems.ashen.traffic.push({
    ship: makeShip('new-visitor', 'New Visitor', 'merchant', 'guild', -200, -200),
    job: structuredClone(g.catalog.systems.ashen.traffic[0].job)
  });
  g.catalog.validate();
  const restored = loadSession(raw, g.catalog, g.services, g.activities);
  assert.equal(restored.traffic.get(a.ship.id)!.cultureId, 'frontier');
  assert.equal(restored.traffic.get(a.ship.id)!.ship.designId, 'industrial-merchant');
  assert.equal(restored.traffic.get('new-visitor')!.cultureId, 'fixture-b');
  assert.equal(restored.traffic.get('new-visitor')!.ship.designId, 'fixture-merchant');
});

/**
 * Verify the scenario: capturing a foreign ship retains its hull design and the captain
 * retains their own culture.
 */
test('capturing a foreign ship retains its hull design and the captain retains their own culture', () => {
  const g = game();
  jump(g);
  const a = g.traffic.get('kepler-trader')!;
  assert.equal(a.cultureId, 'fixture-b');
  a.ship.engines = 0;
  a.ship.position = { x: g.world.player.position.x + 80, y: g.world.player.position.y, z: 0 };
  a.ship.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'board', shipId: a.ship.id, tactic: 'intimidate' }).ok);
  assert.equal(g.world.player.designId, 'fixture-merchant');
  assert.equal(g.captain.cultureId, 'frontier');
  assert.equal(a.motion.kind, 'captured');
  assert.equal(a.cultureId, 'fixture-b');
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  jump(restored);
  assert.equal(restored.world.player.designId, 'fixture-merchant');
  assert.equal(restored.captain.cultureId, 'frontier');
  assert.equal(
    restored.world.ships.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (s) => s.id === a.ship.id
    ).length,
    1
  );
});

/**
 * Verify the scenario: vessel exchange selects local designs while keeping the captain
 * culture and inventory.
 */
test('vessel exchange selects local designs while keeping the captain culture and inventory', () => {
  const g = game();
  jump(g);
  g.dockedAt = 'relay';
  g.world.player.cargo = { rations: 3 };
  g.station!.services.push({ kind: 'fixture-exchange', config: {} });
  g.services.register({
    kind: 'fixture-exchange',
    title: 'Exchange',
    /**
     * Provide a test-only exchange service that replaces the hull through the session's public
     * capability.
     */
    execute(ctx) {
      return ctx.replaceControlledShip(
        makeShip('fixture-replacement', 'Replacement', 'merchant', 'player', 0, 0)
      );
    }
  });
  assert.ok(g.dispatch({ type: 'service', kind: 'fixture-exchange', payload: {} }).ok);
  assert.equal(g.world.player.designId, 'fixture-merchant');
  assert.equal(g.captain.cultureId, 'frontier');
  assert.equal(g.world.player.cargo.rations, 3);
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), g.catalog, g.services, g.activities)
  );
});

/**
 * Verify the scenario: older schema 4 saves backfill culture once from home and preserve
 * progress, damage and follow state.
 */
test('older schema 4 saves backfill culture once from home and preserve progress, damage and follow state', () => {
  const c = createCatalog(),
    raw = readFileSync(new URL('./fixtures/traffic-v4.json', import.meta.url), 'utf8'),
    old = JSON.parse(raw),
    g = loadSession(raw, c, createServices(), createActivities());
  assert.equal(JSON.parse(g.save()).version, 6);
  assert.equal(g.clock, old.clock);
  assert.equal(g.followedActorId, 'ashen-trader');
  assert.equal(g.traffic.get('ashen-trader')!.ship.hull, 47);
  assert.equal(g.captain.cultureId, 'frontier');
  for (const a of g.traffic.actors) {
    assert.equal(
      a.cultureId,
      c.systems[a.homeSystemId].traffic.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (t) => t.ship.id === a.ship.id
      )?.cultureId ?? c.systems[a.homeSystemId].cultureId
    );
    assert.ok(a.ship.designId);
  }
  assert.deepEqual(g.traffic.get('ashen-trader')!.ship.position, {
    x: old.traffic[0].ship.position.x * 5,
    y: old.traffic[0].ship.position.y * 5,
    z: old.traffic[0].ship.position.z * 5
  });
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), c, g.services, g.activities)
  );
});

/**
 * Verify the scenario: schema 4 migration uses NPC home culture when the NPC is already in
 * a foreign system.
 */
test('schema 4 migration uses NPC home culture when the NPC is already in a foreign system', () => {
  const c = fixture(),
    old = JSON.parse(readFileSync(new URL('./fixtures/traffic-v4.json', import.meta.url), 'utf8')),
    a = old.traffic[0];
  a.motion = {
    kind: 'flight',
    systemId: 'kepler',
    stage: 'destination',
    action: {
      kind: 'travel',
      activity: 'Delivery',
      destination: { kind: 'station', systemId: 'kepler', stationId: 'relay' }
    },
    leg: {
      from: position(-1180, -380),
      to: position(-245, 275),
      startedAt: old.clock,
      arriveAt: old.clock + 20
    }
  };
  a.ship.position = position(-1180, -380);
  const g = loadSession(JSON.stringify(old), c, createServices(), createActivities());
  assert.equal(g.traffic.get(a.ship.id)!.cultureId, 'frontier');
  assert.equal(g.traffic.get(a.ship.id)!.ship.designId, 'industrial-merchant');
  assert.equal(g.traffic.get('kepler-trader')!.cultureId, 'fixture-b');
});

/**
 * Verify the scenario: radio profiles choose stable variants from the speaker and fall
 * back for missing topics or values.
 */
test('radio profiles choose stable variants from the speaker and fall back for missing topics or values', () => {
  const c = fixture(),
    templates = createRadioTemplates(c),
    e = event('speaker', 'kepler');
  const a = { id: 'speaker', name: 'Kestrel', cultureId: 'frontier' },
    b = { ...a, cultureId: 'fixture-b' };
  assert.match(templates.format(e, a)!, /^A voice: Kestrel/);
  assert.match(templates.format(e, b)!, /^B control: Kestrel/);
  c.radioProfiles['fixture-formal'].templates['navigation.arrival'] = [
    'Formal one, {speaker}.',
    'Formal two, {speaker}.'
  ];
  const chosen = templates.format(e, b);
  for (let i = 0; i < 20; i++) assert.equal(templates.format(e, b), chosen);
  assert.equal(
    templates.format({ topic: 'ship.disabled', values: {} }, b),
    'Engines down. We cannot manoeuvre!'
  );
  c.radioProfiles['fixture-formal'].templates['navigation.arrival'] = ['Missing {nonexistent}.'];
  assert.equal(templates.format(e, b), 'Inbound for Relay. Requesting approach.');
  assert.equal(templates.format({ topic: 'not.registered', values: {} }, b), undefined);
  assert.throws(
    /**
     * Attempt the scenario operation so the assertion can verify that invalid input is
     * rejected.
     */
    () => templates.format(e, { ...a, cultureId: 'unknown' })
  );
});

/**
 * Verify the scenario: saved culture/design references are required and hull class
 * compatibility is validated.
 */
test('saved culture/design references are required and hull class compatibility is validated', () => {
  const g = game(),
    raw = JSON.parse(g.save());
  for (const change of [
    /** Remove a required NPC culture to verify current saves cannot silently invent identity. */
    (d: any) => delete d.traffic[0].cultureId,
    /** Insert an unknown NPC culture so import must reject a broken identity reference. */
    (d: any) => (d.traffic[0].cultureId = 'missing'),
    /** Remove a required hull design to exercise current-schema save validation. */
    (d: any) => delete d.traffic[0].ship.designId,
    /**
     * Give the player's cutter a merchant-only design to test gameplay-class compatibility
     * checks.
     */
    (d: any) => (d.player.designId = 'industrial-merchant'),
    /** Insert an unregistered saved hull design to verify import fails explicitly. */
    (d: any) => (d.traffic[0].ship.designId = 'unknown'),
    /**
     * Remove the captain's required culture so current saves cannot fall back to the current
     * system.
     */
    (d: any) => delete d.captain.cultureId
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
 * Verify the scenario: catalog validation rejects invalid culture, profile and design
 * references before simulation starts.
 */
test('catalog validation rejects invalid culture, profile and design references before simulation starts', () => {
  for (const change of [
    /**
     * Assign an unknown culture to an authored system to exercise catalog reference
     * validation.
     */
    (c: ReturnType<typeof fixture>) => (c.systems.ashen.cultureId = 'unknown'),
    /**
     * Break a culture's radio-profile reference so validation catches missing dialogue
     * content.
     */
    (c: ReturnType<typeof fixture>) => (c.cultures.frontier.radioProfileId = 'unknown'),
    /** Put a merchant-only design in a cutter pool to test authored hull-class validation. */
    (c: ReturnType<typeof fixture>) =>
      (c.cultures.frontier.shipDesigns.cutter = ['industrial-merchant']),
    /** Give a spawn an unknown culture override to verify catalog validation rejects it. */
    (c: ReturnType<typeof fixture>) => (c.systems.ashen.traffic[0].cultureId = 'missing'),
    /** Give an authored spawn an unregistered design to exercise visual-reference validation. */
    (c: ReturnType<typeof fixture>) => (c.systems.ashen.traffic[0].ship.designId = 'missing'),
    /** Create an empty radio-phrase pool to verify invalid authored dialogue is rejected. */
    (c: ReturnType<typeof fixture>) => (c.radioProfiles.frontier.templates.test = [])
  ]) {
    const c = fixture();
    change(c);
    assert.throws(
      /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
      () => c.validate()
    );
  }
});

/**
 * Verify the scenario: design defaults are stable per actor and hull design does not
 * change physical simulation.
 */
test('design defaults are stable per actor and hull design does not change physical simulation', () => {
  const c = fixture();
  c.cultures.frontier.shipDesigns.cutter.push('fixture-cutter');
  const a = makeShip('stable', 'Stable', 'cutter', 'player', 0, 0),
    b = structuredClone(a);
  assignShipDesign(c, a, 'frontier', 17);
  for (let i = 0; i < 50; i++)
    assignShipDesign(c, makeShip(`other-${i}`, 'Other', 'cutter', 'guild', 0, 0), 'frontier', 17);
  assignShipDesign(c, b, 'frontier', 17);
  assert.equal(a.designId, b.designId);
  a.designId = 'industrial-cutter';
  b.designId = 'fixture-cutter';
  const wa = new World([a], a.id),
    wb = new World([b], b.id);
  for (let i = 0; i < 600; i++) {
    wa.step(1 / 60, { ...idle, heading: 0.6, thrust: 0.8 });
    wb.step(1 / 60, { ...idle, heading: 0.6, thrust: 0.8 });
  }
  assert.deepEqual(a.position, b.position);
  assert.deepEqual(a.velocity, b.velocity);
  assert.equal(a.hull, b.hull);
});

/**
 * Verify the scenario: model providers and renderer caches follow design/livery,
 * independently of ownership or local culture.
 */
test('model providers and renderer caches follow design/livery, independently of ownership or local culture', () => {
  const c = fixture(),
    base = shipModelBuilders.get('industrial-merchant')!;
  c.shipDesigns['fixture-merchant'].modelId = 'fixture-provider';
  shipModelBuilders.set(
    'fixture-provider',
    /**
     * Provide a test graphics or policy implementation without changing production registry
     * dispatch.
     */
    (ship) => {
      const m = base(ship);
      m.userData.provider = 'fixture-provider';
      return m;
    }
  );
  const ship = assignShipDesign(
      c,
      makeShip('vessel', 'Vessel', 'merchant', 'guild', 0, 0),
      'frontier',
      1
    ),
    world = new World([ship], ship.id),
    fake = {
      groups: new Map<string, THREE.Group>(),
      scene: new THREE.Scene(),
      designs: c.shipDesigns,
      buildShip: View.prototype.buildShip
    } as unknown as View;
  try {
    View.prototype.syncShipModels.call(fake, world);
    const original = fake.groups.get(ship.id)!;
    ship.owner = 'player';
    View.prototype.syncShipModels.call(fake, world);
    assert.equal(fake.groups.get(ship.id), original);
    ship.designId = 'fixture-merchant';
    View.prototype.syncShipModels.call(fake, world);
    const foreign = fake.groups.get(ship.id)!;
    assert.notEqual(foreign, original);
    assert.equal(foreign.userData.provider, 'fixture-provider');
    ship.livery = 'police';
    View.prototype.syncShipModels.call(fake, world);
    assert.notEqual(fake.groups.get(ship.id), foreign);
    assert.equal(fake.groups.size, 1);
    assert.equal(fake.scene.children.length, 1);
    const previewModel = createShipModel(ship, c.shipDesigns);
    assert.equal(previewModel.userData.provider, 'fixture-provider');
    disposeShipModel(previewModel);
    validateShipModelProviders(c.shipDesigns);
  } finally {
    for (const m of fake.groups.values()) disposeShipModel(m);
    shipModelBuilders.delete('fixture-provider');
  }
});

/**
 * Verify the scenario: missing model providers and incomplete attachment contracts fail
 * explicitly.
 */
test('missing model providers and incomplete attachment contracts fail explicitly', () => {
  const c = fixture(),
    ship = makeShip('vessel', 'Vessel', 'merchant', 'guild', 0, 0);
  ship.designId = 'fixture-merchant';
  c.shipDesigns['fixture-merchant'].modelId = 'unregistered';
  assert.throws(
    /**
     * Attempt graphics-provider validation so the assertion can verify that invalid input is
     * rejected.
     */
    () => validateShipModelProviders(c.shipDesigns)
  );
  assert.throws(
    /**
     * Attempt the registered hull-model factory so the assertion can verify that invalid input
     * is rejected.
     */
    () => createShipModel(ship, c.shipDesigns)
  );
  shipModelBuilders.set(
    'unregistered',
    /**
     * Provide a test graphics or policy implementation without changing production registry
     * dispatch.
     */
    () => new THREE.Group()
  );
  try {
    assert.throws(
      /**
       * Attempt the registered hull-model factory so the assertion can verify that invalid input
       * is rejected.
       */
      () => createShipModel(ship, c.shipDesigns),
      /attachments/
    );
  } finally {
    shipModelBuilders.delete('unregistered');
  }
});
