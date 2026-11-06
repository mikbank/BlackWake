import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, makeShip } from './content/universe';
import { assignShipDesign, stableIndex } from './content/identity';
import { startTrading } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { actorSystemId } from './game/traffic';
import { createRadioTemplates } from './game/radio-templates';
const idle = { turn: 0, thrust: 0, brake: true, fire: false };
/**
 * Create a fresh free-standing trading session for cultural fleet and radio integration
 * checks.
 */
const game = () => startTrading(createCatalog(), createServices(), createActivities());

/**
 * Verify the scenario: culture role pools select appropriate hulls without overriding
 * explicit foreign designs.
 */
test('culture role pools select appropriate hulls without overriding explicit foreign designs', () => {
  const c = createCatalog();
  for (const [role, kind, design] of [
    ['freight', 'merchant', 'aster-freighter'],
    ['passenger', 'cutter', 'aster-transit'],
    ['liner', 'merchant', 'aster-liner'],
    ['patrol', 'cutter', 'aster-patrol']
  ] as const) {
    const s = makeShip(`test-${role}`, role, kind, 'civilian', 0, 0);
    assignShipDesign(c, s, 'aster', 42, role);
    assert.equal(s.designId, design);
    s.designId = `industrial-${kind}`;
    assignShipDesign(c, s, 'aster', 42, role);
    assert.equal(s.designId, `industrial-${kind}`);
  }
  const c2 = createCatalog();
  c2.cultures.aster.roleDesigns!.passenger = ['aster-liner'];
  assert.throws(
    /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
    () => c2.validate(),
    /compatible hull/
  );
  c2.cultures.aster.roleDesigns!.passenger = ['missing'];
  assert.throws(
    /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
    () => c2.validate(),
    /role design pool/
  );
});

/**
 * Verify the scenario: an actual Aster commuter visits both cultures and retains identity
 * through journeys and reload.
 */
test('an actual Aster commuter visits both cultures and retains identity through journeys and reload', () => {
  let g = game();
  g.dispatch({ type: 'undock' });
  const visited = new Set<string>();
  const topics = new Set<string>();
  for (let i = 0; i < 240 * 60; i++) {
    g.step(1 / 60, idle);
    const a = g.traffic.get('aster-thread')!;
    const system = actorSystemId(a);
    if (system) visited.add(system);
    for (const e of g.traffic.events) if (e.actorId === a.ship.id) topics.add(e.topic);
    if (i === 60 * 60) g = loadSession(g.save(), g.catalog, g.services, g.activities);
    assert.equal(a.cultureId, 'aster');
    assert.equal(a.ship.designId, 'aster-transit');
  }
  assert.ok(visited.has('ashen') && visited.has('vesper'));
  assert.ok(topics.has('passenger.depart') && topics.has('navigation.arrival'));
  const a = g.traffic.get('aster-thread')!;
  const text = createRadioTemplates(g.catalog).format(
    { topic: 'patrol.clear', values: { sector: 'test lane' }, id: 'same-event' },
    { id: a.ship.id, name: a.ship.name, cultureId: a.cultureId }
  );
  assert.ok(
    g.catalog.radioProfiles.aster.templates['patrol.clear'].some(
      /**
       * Check whether a fixture entry satisfies the presence or behavior condition asserted
       * here.
       */
      (t) => t.replace('{sector}', 'test lane') === text
    )
  );
  assert.equal(g.traffic.get('vesper-freight-1')!.cultureId, 'frontier');
  assert.equal(g.captain.cultureId, 'frontier');
});

/**
 * Verify the scenario: every Aster phrase resolves through the real formatter using its
 * topic facts.
 */
test('every Aster phrase resolves through the real formatter using its topic facts', () => {
  const c = createCatalog(),
    radio = createRadioTemplates(c);
  const facts: Record<string, Record<string, string | number>> = {
    'freight.depart': { destination: 'Haven', cargo: '12 rations' },
    'freight.dock': { destination: 'Haven' },
    'freight.complete': {},
    'navigation.charging': { destination: 'Ashen Reach', finalDestination: 'Relay' },
    'navigation.transfer': { system: 'Ashen Reach', destination: 'Relay' },
    'navigation.arrival': { system: 'Vesper', destination: 'Lantern Anchorage' },
    'passenger.board': { destination: 'Haven' },
    'passenger.depart': { passengers: 30, destination: 'Haven' },
    'passenger.dock': { destination: 'Haven' },
    'liner.depart': { passengers: 96, destination: 'Lantern dusk' },
    'liner.view': { destination: 'Lantern dusk' },
    'patrol.clear': { sector: 'Anchorage approach' },
    'patrol.respond': { target: 'Raider' },
    'ship.attacked': {},
    'ship.disabled': {}
  };
  assert.deepEqual(Object.keys(c.radioProfiles.aster.templates).sort(), Object.keys(facts).sort());
  for (const [topic, variants] of Object.entries(c.radioProfiles.aster.templates)) {
    const seen = new Set<number>();
    for (let i = 0; i < 256; i++) {
      const id = `event-${i}`,
        index = stableIndex(`speaker:${id}`, variants.length);
      const values = { ...facts[topic], speaker: 'Shared Horizon', culture: 'Aster Compact' };
      const expected = variants[index].replace(
        /\{(\w+)\}/g,
        /**
         * Resolve a phrase placeholder from the scenario facts and fail the assertion if the key
         * is unknown.
         */
        (_, key: string) => {
          assert.ok(Object.hasOwn(values, key), `${topic}: unknown ${key}`);
          return String(values[key as keyof typeof values]);
        }
      );
      assert.equal(
        radio.format(
          { topic, id, values: facts[topic] },
          { id: 'speaker', name: 'Shared Horizon', cultureId: 'aster' }
        ),
        expected
      );
      assert.doesNotMatch(expected, /[{}\n]/);
      assert.ok(variants[index].length <= 110);
      seen.add(index);
    }
    assert.equal(seen.size, variants.length);
  }
});

/**
 * Verify the scenario: content v1 saves upgrade stock role art once while preserving
 * progress and adding new traffic once.
 */
test('content v1 saves upgrade stock role art once while preserving progress and adding new traffic once', () => {
  const g = game(),
    raw = JSON.parse(g.save());
  raw.contentVersion = 1;
  raw.traffic = raw.traffic.filter(
    /** Select the fixture identities required for this persistence or uniqueness check. */
    (a: any) => !a.ship.id.startsWith('aster-') && !a.ship.id.startsWith('drift-')
  );
  for (const a of raw.traffic)
    if (['reach-transit', 'ashen-liner', 'kepler-patrol'].includes(a.ship.id))
      a.ship.designId = `industrial-${a.ship.kind}`;
  const before = structuredClone(
    raw.traffic.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (a: any) => a.ship.id === 'reach-transit'
    )
  );
  before.ship.hull = 43;
  raw.traffic[
    raw.traffic.findIndex(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (a: any) => a.ship.id === before.ship.id
    )
  ] = before;
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  const actual = structuredClone(restored.traffic.get(before.ship.id)!);
  assert.equal(actual.ship.designId, 'frontier-transit');
  actual.ship.designId = before.ship.designId;
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), before);
  assert.equal(
    restored.traffic.actors.length,
    Object.values(g.catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  const again = loadSession(restored.save(), g.catalog, g.services, g.activities);
  assert.equal(
    again.traffic.actors.length,
    Object.values(g.catalog.systems).flatMap(
      /** Collect authored NPC spawns so population assertions remain valid as the content grows. */
      (s) => s.traffic
    ).length
  );
  assert.equal(JSON.parse(again.save()).contentVersion, 5);
});

/**
 * Verify the scenario: art migration preserves captured, foreign and explicitly retained
 * current-content hulls.
 */
test('art migration preserves captured, foreign and explicitly retained current-content hulls', () => {
  for (const mode of ['captured', 'foreign', 'current'] as const) {
    const g = game(),
      raw = JSON.parse(g.save());
    raw.contentVersion = mode === 'current' ? 2 : 1;
    const a = raw.traffic.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (x: any) => x.ship.id === 'reach-transit'
    );
    a.ship.designId = mode === 'foreign' ? 'aster-transit' : 'industrial-cutter';
    if (mode === 'captured') {
      a.ship.owner = 'salvage';
      a.motion = { kind: 'captured', systemId: 'ashen' };
    }
    const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
    assert.equal(restored.traffic.get(a.ship.id)!.ship.designId, a.ship.designId);
    assert.equal(restored.captain.cultureId, 'frontier');
  }
});
