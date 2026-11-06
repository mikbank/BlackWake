import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCatalog, position } from './content/universe';
import { expandUniverse } from './content/generation/generate';
import { readContent, writeContent } from '../tools/content-files';
import { runUniverse } from '../tools/universe';
import { startFreeRoam } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { jumpDestinations } from './ui/navigation-menu';
const names = ['Lacuna', 'Halcyon', 'Nacre', 'Ilex', 'Meridian', 'Brume'];
/**
 * Create the current authored free-roam universe for region, jump and save-migration
 * checks.
 */
const game = () =>
  startFreeRoam(createCatalog(), createServices(), createActivities(), { trafficWarmup: false });
/**
 * Copy content into an isolated authoring workspace so generator tests cannot modify the
 * real playable universe.
 */
function temporaryContent() {
  const temp = mkdtempSync(join(tmpdir(), 'blackwake-regions-')),
    root = join(temp, 'content');
  cpSync(resolve('content'), root, { recursive: true });
  mkdirSync(join(temp, 'src/content'), { recursive: true });
  writeContent(root, readContent(root));
  return { temp, root };
}
/** Build the shared seeded batch options used by name-list and region-inheritance tests. */
const args = (root: string) => [
  '--root',
  root,
  '--seed',
  '81',
  '--prefix',
  'named',
  '--anchor',
  'vesper'
];

/**
 * Verify the scenario: the Lantern Marches share Aster defaults while system IDs and
 * visitor culture remain stable.
 */
test('the Lantern Marches share Aster defaults while system IDs and visitor culture remain stable', () => {
  const g = game();
  assert.equal(g.definition.regionId, 'ashen-frontier');
  assert.equal(g.catalog.systems.vesper.regionId, 'lantern-marches');
  for (let i = 1; i <= 6; i++) {
    const system = g.catalog.systems[`drift-${String(i).padStart(3, '0')}`];
    assert.equal(system.name, names[i - 1]);
    assert.equal(system.cultureId, 'aster');
    assert.equal(system.regionId, 'lantern-marches');
    assert.equal(g.traffic.get(system.traffic[0].ship.id)!.cultureId, 'aster');
  }
  assert.equal(g.traffic.get('vesper-freight-1')!.cultureId, 'frontier');
});

/**
 * Verify the scenario: named batches infer count, inherit the anchor region and preserve
 * existing names on replay.
 */
test('named batches infer count, inherit the anchor region and preserve existing names on replay', () => {
  const { temp, root } = temporaryContent();
  try {
    const options = [...args(root), '--names', JSON.stringify(['First Light', 'Quiet Harbour'])];
    assert.equal(runUniverse('generate', options).created.length, 2);
    let systems = readContent(root).systems;
    const first = systems.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'named-001'
    )!;
    assert.equal(first.name, 'First Light');
    assert.equal(first.stations[0].name, 'First Light Anchorage');
    assert.equal(first.regionId, 'lantern-marches');
    assert.equal(first.cultureId, 'aster');
    assert.equal(runUniverse('generate', options).files.length, 0);
    runUniverse('generate', [...args(root), '--names', 'Different Name,Other Name']);
    systems = readContent(root).systems;
    assert.equal(
      systems.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (s) => s.id === first.id
      )!.name,
      'First Light'
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * Verify the scenario: explicit regions override an anchor and single-system creation
 * inherits its neighbour region.
 */
test('explicit regions override an anchor and single-system creation inherits its neighbour region', () => {
  const { temp, root } = temporaryContent();
  try {
    runUniverse('generate', [
      ...args(root),
      '--region',
      'ashen-frontier',
      '--names',
      'Border Haven'
    ]);
    let systems = readContent(root).systems;
    assert.equal(
      systems.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (s) => s.id === 'named-001'
      )!.cultureId,
      'frontier'
    );
    runUniverse('create', [
      '--root',
      root,
      '--id',
      'new-local',
      '--name',
      'New Local',
      '--seed',
      '4',
      '--connect',
      'vesper',
      '--x',
      '2',
      '--y',
      '3'
    ]);
    systems = readContent(root).systems;
    assert.equal(
      systems.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (s) => s.id === 'new-local'
      )!.cultureId,
      'aster'
    );
    assert.equal(
      systems.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (s) => s.id === 'new-local'
      )!.regionId,
      'lantern-marches'
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * Verify the scenario: invalid name lists and unknown regions fail before any content is
 * written.
 */
test('invalid name lists and unknown regions fail before any content is written', () => {
  const { temp, root } = temporaryContent();
  try {
    const before = readFileSync(join(root, 'universe.json'), 'utf8');
    for (const options of [
      ['--count', '2', '--names', 'Only One'],
      ['--names', 'Same,same'],
      ['--names', 'Good,'],
      ['--names', '[1,"Valid"]'],
      ['--names', '[]'],
      ['--names', 'One', '--region', 'missing']
    ]) {
      assert.throws(
        /**
         * Attempt the real authoring CLI so the assertion can verify that invalid input is
         * rejected.
         */
        () => runUniverse('generate', [...args(root), ...options])
      );
      assert.equal(readFileSync(join(root, 'universe.json'), 'utf8'), before);
    }
    const c = createCatalog();
    c.regions['lantern-marches'].cultureId = 'missing';
    assert.throws(
      /** Attempt catalog validation so the assertion can verify that invalid input is rejected. */
      () => c.validate(),
      /region/
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * Verify the scenario: blueprints can author a cultural enclave without conflating region,
 * environment or crew identity.
 */
test('blueprints can author a cultural enclave without conflating region, environment or crew identity', () => {
  const source = readContent(resolve('content'));
  const presets = JSON.parse(readFileSync(resolve('content/presets.json'), 'utf8'));
  const result = expandUniverse(
    source,
    {
      schemaVersion: 1,
      systems: [
        {
          id: 'enclave',
          name: 'Enclave',
          seed: 5,
          preset: 'frontier',
          regionId: 'lantern-marches',
          cultureId: 'frontier',
          chart: { x: 3, y: 4 }
        }
      ],
      connections: [{ from: 'vesper', to: 'enclave' }]
    },
    presets
  );
  const system = result.bundle.systems.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (s) => s.id === 'enclave'
  )!;
  assert.equal(system.regionId, 'lantern-marches');
  assert.equal(system.cultureId, 'frontier');
  assert.equal(system.themeId, 'frontier');
});

/**
 * Verify the scenario: jump choices are local direct connections and route plotting never
 * executes a jump.
 */
test('jump choices are local direct connections and route plotting never executes a jump', () => {
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
  g.world.player.velocity = position(0, 0);
  assert.deepEqual(
    jumpDestinations(g, gate.id).map(
      /** Read fixture identities for uniqueness, routing or persistence comparisons. */
      (x) => x.system.id
    ),
    ['vesper']
  );
  assert.ok(g.dispatch({ type: 'plot-route', systemId: 'drift-006' }).ok);
  assert.equal(g.systemId, 'ashen');
  assert.deepEqual(
    jumpDestinations(g, gate.id).map(
      /** Read fixture identities for uniqueness, routing or persistence comparisons. */
      (x) => x.system.id
    ),
    ['vesper']
  );
  /**
   * Override route access for this test so jump choices can be checked against a closed
   * connection.
   */
  g.routes.policy = () => ({ allowed: false, reason: 'Closed' });
  assert.equal(jumpDestinations(g, gate.id).length, 0);
  /** Restore permissive access after the test's closure case. */
  g.routes.policy = () => ({ allowed: true });
  g.world.player.velocity.x = 80;
  assert.equal(jumpDestinations(g, gate.id).length, 0);
  g.world.player.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(g);
  assert.equal(g.systemId, 'vesper');
  assert.equal(g.routeDestinationId, 'drift-006');
});

/**
 * Verify the scenario: revision 3 corrects the six misgenerated native crews without
 * changing their simulation progress.
 */
test('revision 3 corrects the six misgenerated native crews without changing their simulation progress', () => {
  const g = game(),
    raw = JSON.parse(g.save());
  raw.contentVersion = 2;
  const expected = new Map<string, unknown>();
  for (let i = 1; i <= 6; i++) {
    const id = `drift-${String(i).padStart(3, '0')}-freight-1`;
    const a = raw.traffic.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (x: any) => x.ship.id === id
    );
    a.cultureId = 'frontier';
    a.ship.designId = 'industrial-merchant';
    a.ship.name = `Drift ${i} Runner 1`;
    a.ship.hull = 71;
    if (a.job.kind === 'long-haul') {
      // Pre-region saves only had assigned freight. Revision five later changes the
      // future job while retaining this old delivery and all its physical progress.
      a.job = {
        kind: 'freight',
        config: {
          route: [a.job.config.home, { systemId: 'kepler', stationId: 'relay' }],
          quantity: 12,
          loadingSeconds: 5,
          unloadingSeconds: 6
        },
        state: { origin: 0, next: 'depart' }
      };
    }
    expected.set(id, structuredClone(a));
  }
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  for (const [id, before] of expected) {
    const actual = JSON.parse(JSON.stringify(restored.traffic.get(id)!));
    assert.equal(actual.cultureId, 'aster');
    assert.equal(actual.ship.designId, 'aster-freighter');
    const previous = before as typeof actual;
    if (actual.job.kind === 'long-haul') {
      assert.equal(previous.job.kind, 'freight');
      assert.deepEqual(actual.job.state.origin, previous.job.config.route[0]);
      assert.deepEqual(actual.job.state.destination, previous.job.config.route[1]);
      assert.equal(actual.job.state.next, previous.job.state.next);
      actual.job = previous.job;
    }
    actual.cultureId = previous.cultureId;
    actual.ship.designId = previous.ship.designId;
    actual.ship.name = previous.ship.name;
    assert.deepEqual(actual, before);
  }
  assert.equal(JSON.parse(restored.save()).contentVersion, 5);
  assert.equal(restored.traffic.get('vesper-freight-1')!.cultureId, 'frontier');
});

/**
 * Verify the scenario: regional correction preserves captured hulls, custom designs and
 * current-revision visitor choices.
 */
test('regional correction preserves captured hulls, custom designs and current-revision visitor choices', () => {
  for (const mode of ['captured', 'custom', 'current']) {
    const g = game(),
      raw = JSON.parse(g.save());
    raw.contentVersion = mode === 'current' ? 3 : 2;
    const a = raw.traffic.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (x: any) => x.ship.id === 'drift-001-freight-1'
    );
    a.cultureId = 'frontier';
    a.ship.designId = mode === 'custom' ? 'frontier-liner' : 'industrial-merchant';
    if (mode === 'captured') {
      a.ship.owner = 'salvage';
      a.motion = { kind: 'captured', systemId: 'drift-001' };
    }
    const loaded = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
    assert.equal(loaded.traffic.get(a.ship.id)!.cultureId, 'frontier');
    assert.equal(loaded.traffic.get(a.ship.id)!.ship.designId, a.ship.designId);
  }
});
