import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCatalog, position } from './content/universe';
import { catalogFromData } from './content/data';
import { RouteResolver } from './content/routes';
import { expandUniverse } from './content/generation/generate';
import { readContent, writeContent } from '../tools/content-files';
import { runUniverse } from '../tools/universe';
import { startTrading } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { followTarget } from './game/follow';
import { suggestedContact } from './ui/guidance';
import { Navigation } from './navigation';
import { approachPoint } from './hud';
import { universeChart } from './ui/universe-chart';
import type { Input } from './simulation';
const root = resolve('content'),
  systemCount = readContent(root).systems.length,
  presets = JSON.parse(readFileSync(join(root, 'presets.json'), 'utf8')),
  idle: Input = { turn: 0, thrust: 0, brake: true, fire: false };
const blueprint = {
  schemaVersion: 1,
  systems: [{ id: 'nova', name: 'Nova', seed: 83, preset: 'frontier', chart: { x: 2, y: 1 } }],
  connections: [{ from: 'ashen', to: 'nova' }]
};
/**
 * Create an undocked trading session for file-content, routing and universe-growth
 * integration checks.
 */
function game() {
  const g = startTrading(createCatalog(), createServices(), createActivities());
  g.dispatch({ type: 'undock' });
  return g;
}
/** Advance the active world and background traffic with a neutral fixed-step player input. */
function tick(g: ReturnType<typeof game>, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) g.step(1 / 60, idle);
}
/**
 * Take the next graph hop toward a requested system through its exact physical gate and
 * validated session command.
 */
function jump(g: ReturnType<typeof game>, to: string) {
  const hop = g.routes.find(g.systemId, to)?.hops[0];
  assert.ok(hop);
  g.world.player.position = { ...g.gateById(hop.gateId)!.position };
  g.world.player.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'jump', connectionId: hop.connectionId }).ok);
  finishTransit(g);
}
/**
 * Use real autopilot and braking to reach a contact's approach point within a bounded test
 * duration.
 */
function fly(g: ReturnType<typeof game>, point: { x: number; y: number; z: number }) {
  const nav = new Navigation();
  nav.radius = g.definition.radius;
  nav.moveTo(approachPoint(g.world.player.position, point, 50));
  nav.toggleCruise();
  for (let i = 0; i < 9000 && nav.destination; i++) g.step(1 / 60, nav.input(g.world));
  assert.equal(nav.destination, null);
}
/**
 * Copy the authored universe to a temporary directory and generate its matching import
 * index for safe CLI tests.
 */
function tempContent() {
  const temp = mkdtempSync(join(tmpdir(), 'blackwake-universe-')),
    content = join(temp, 'content');
  cpSync(root, content, { recursive: true });
  mkdirSync(join(temp, 'src', 'content'), { recursive: true });
  writeContent(content, readContent(content));
  return { temp, content };
}

/**
 * Verify the scenario: runtime catalog loads the same editable definitions as command-line
 * validation.
 */
test('runtime catalog loads the same editable definitions as command-line validation', () => {
  const files = readContent(root),
    c = createCatalog();
  assert.deepEqual(Object.values(c.systems), files.systems);
  assert.deepEqual(c.markets, files.definition.markets);
  assert.equal(runUniverse('validate', ['--root', root, '--check-index']).systems, systemCount);
});
/**
 * Verify the scenario: Ashen has two separated exits with distinct paired destinations and
 * original IDs intact.
 */
test('Ashen has two separated exits with distinct paired destinations and original IDs intact', () => {
  const c = createCatalog(),
    ashen = c.systems.ashen;
  assert.equal(ashen.gates.length, 2);
  assert.equal(ashen.gates[0].id, 'ashen-egress');
  assert.equal(ashen.gates[0].connections[0].id, 'ashen-to-kepler');
  assert.deepEqual(
    new Set(
      ashen.gates.flatMap(
        /** Collect the destinations exposed by each physical gate for graph-link assertions. */
        (g) =>
          g.connections.map(
            /** Build the comparison values used by this scenario's assertions. */
            (l) => l.systemId
          )
      )
    ),
    new Set(['kepler', 'vesper'])
  );
  for (const gate of ashen.gates)
    for (const link of gate.connections) {
      const arrival = c.systems[link.systemId].gates.find(
        /** Locate the fixture record matching the identity or state required by the assertion. */
        (g) => g.id === link.gateId
      )!;
      assert.ok(
        arrival.connections.some(
          /**
           * Check whether a fixture entry satisfies the presence or behavior condition asserted
           * here.
           */
          (l) => l.systemId === 'ashen' && l.gateId === gate.id
        )
      );
    }
  assert.ok(
    Math.hypot(
      ashen.gates[0].position.x - ashen.gates[1].position.x,
      ashen.gates[0].position.y - ashen.gates[1].position.y
    ) > 500
  );
});
/**
 * Verify the scenario: route resolver finds stable shortest paths, same-system routes and
 * unreachable systems.
 */
test('route resolver finds stable shortest paths, same-system routes and unreachable systems', () => {
  const c = createCatalog(),
    routes = new RouteResolver(c);
  assert.deepEqual(
    routes.find('kepler', 'vesper')!.hops.map(
      /** Build the comparison values used by this scenario's assertions. */
      (h) => h.toSystemId
    ),
    ['ashen', 'vesper']
  );
  assert.deepEqual(routes.find('ashen', 'ashen')!.hops, []);
  assert.equal(routes.find('missing', 'ashen'), null);
  /**
   * Apply a test-only connection restriction to exercise routing independently of the
   * authored graph.
   */
  routes.policy = (hop) =>
    hop.toSystemId === 'vesper' ? { allowed: false, reason: 'Fixture closure' } : { allowed: true };
  assert.equal(routes.find('kepler', 'vesper'), null);
  assert.equal(routes.find('vesper', 'kepler')!.hops.length, 2);
});
/**
 * Verify the scenario: player jump commands enforce the correct physical gate for each
 * connected system.
 */
test('player jump commands enforce the correct physical gate for each connected system', () => {
  const g = game(),
    kepler = g.routes.find('ashen', 'kepler')!.hops[0],
    vesper = g.routes.find('ashen', 'vesper')!.hops[0];
  g.world.player.position = { ...g.gateById(kepler.gateId)!.position };
  assert.equal(g.canJumpConnection(kepler.connectionId), true);
  assert.equal(g.canJumpConnection(vesper.connectionId), false);
  assert.equal(g.dispatch({ type: 'jump', connectionId: vesper.connectionId }).ok, false);
  assert.equal(g.systemId, 'ashen');
  jump(g, 'vesper');
  assert.equal(g.systemId, 'vesper');
});
/**
 * Verify the scenario: player can fly a plotted two-hop route, reload between jumps, dock
 * and trade in the generated system.
 */
test('player can fly a plotted two-hop route, reload between jumps, dock and trade in the generated system', () => {
  let g = game();
  jump(g, 'kepler');
  assert.ok(g.dispatch({ type: 'plot-route', systemId: 'vesper' }).ok);
  assert.equal(g.selection!.id, 'kepler-egress');
  fly(g, g.gateById(g.selection!.id)!.position);
  assert.ok(g.dispatch({ type: 'jump', connectionId: 'kepler-to-ashen' }).ok);
  finishTransit(g);
  assert.equal(g.routeDestinationId, 'vesper');
  assert.equal(g.selection!.id, g.routes.find('ashen', 'vesper')!.hops[0].gateId);
  g = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(g.routeDestinationId, 'vesper');
  assert.equal(suggestedContact(g)!.id, g.selection!.id);
  const hop = g.routes.find(g.systemId, 'vesper')!.hops[0];
  fly(g, g.gateById(hop.gateId)!.position);
  assert.ok(g.dispatch({ type: 'jump', connectionId: hop.connectionId }).ok);
  finishTransit(g);
  assert.equal(g.routeDestinationId, null);
  const station = g.definition.stations[0];
  fly(g, station.position);
  assert.ok(g.dispatch({ type: 'dock', stationId: station.id }).ok);
  assert.ok(
    g.dispatch({
      type: 'service',
      kind: 'market',
      payload: { direction: 'buy', commodityId: 'rations', quantity: 2 }
    }).ok
  );
  assert.equal(g.world.player.cargo.rations, 2);
  assert.equal(g.station!.name, 'Lantern Anchorage');
});
/**
 * Verify the scenario: generated freighter completes multi-hop deliveries without
 * unloading at intermediate systems.
 */
test('generated freighter completes multi-hop deliveries without unloading at intermediate systems', () => {
  const g = game(),
    a = g.traffic.get('vesper-freight-1')!,
    seen = new Set<string>();
  let transfers = 0,
    manifest: string | undefined;
  for (let i = 0; i < 2500 * 60 && a.journeys < 2; i++) {
    g.step(1 / 60, idle);
    if (a.motion.systemId) seen.add(a.motion.systemId);
    if (a.motion.kind === 'flight' || a.motion.kind === 'charging' || a.motion.kind === 'transit') {
      const current = JSON.stringify(a.ship.cargo);
      assert.notEqual(current, '{}');
      if (!manifest) manifest = current;
      if (a.journeys === 0) assert.equal(current, manifest);
    }
    for (const event of g.traffic.events)
      if (event.actorId === a.ship.id && event.topic === 'navigation.transfer') transfers++;
  }
  assert.ok(a.journeys >= 2);
  assert.deepEqual(seen, new Set(['vesper', 'ashen', 'kepler']));
  assert.ok(transfers >= 2);
  assert.equal(a.homeSystemId, 'vesper');
  assert.equal(a.cultureId, 'frontier');
  assert.equal(a.ship.designId, 'industrial-merchant');
  assert.deepEqual(g.markets, {});
});
/**
 * Verify the scenario: multi-hop ship can be followed and reloaded at an intermediate
 * system without duplication.
 */
test('multi-hop ship can be followed and reloaded at an intermediate system without duplication', () => {
  let g = game();
  jump(g, 'kepler');
  const id = 'vesper-freight-1';
  g.followedActorId = id;
  const visited = new Set<string>();
  for (let i = 0; i < 1600 * 60; i++) {
    g.step(1 / 60, idle);
    const a = g.traffic.get(id)!;
    if (a.motion.systemId) visited.add(a.motion.systemId);
    if (i % 600 === 0) {
      g = loadSession(g.save(), g.catalog, g.services, g.activities);
      assert.equal(g.followedActorId, id);
      assert.equal(
        new Set(
          g.world.ships.map(
            /** Read fixture identities for uniqueness, routing or persistence comparisons. */
            (s) => s.id
          )
        ).size,
        g.world.ships.length
      );
    }
    const follow = followTarget(g);
    if (a.motion.systemId === 'ashen' && g.systemId === 'kepler') {
      assert.equal(follow?.contact?.id, 'kepler-egress');
      jump(g, 'ashen');
    }
    if (a.motion.systemId === 'kepler' && visited.has('ashen')) {
      assert.equal(g.traffic.get(id)!.ship.id, id);
      break;
    }
  }
  assert.ok(visited.has('ashen'));
  assert.ok(visited.has('kepler'));
});
/**
 * Verify the scenario: shared access policy blocks player commands and lets NPCs wait and
 * retry their existing task.
 */
test('shared access policy blocks player commands and lets NPCs wait and retry their existing task', () => {
  const g = game(),
    a = g.traffic.get('vesper-freight-1')!;
  /**
   * Close a route for the test so player commands and background traffic must wait rather
   * than bypass access rules.
   */
  g.routes.policy = (hop) =>
    hop.fromSystemId === 'vesper'
      ? { allowed: false, reason: 'Fixture closure' }
      : { allowed: true };
  tick(g, 12);
  assert.equal(a.motion.kind, 'awaiting-route');
  assert.equal(a.journeys, 0);
  const cargo = { ...a.ship.cargo };
  jump(g, 'vesper');
  const hop = g.routes.connection('vesper', 'vesper-to-ashen')!;
  g.world.player.position = { ...g.gateById(hop.gateId)!.position };
  assert.equal(g.dispatch({ type: 'jump', connectionId: hop.connectionId }).ok, false);
  /** Reopen the test route so the preserved NPC travel task can resume. */
  g.routes.policy = () => ({ allowed: true });
  tick(g, 4);
  assert.equal(a.motion.kind, 'flight');
  assert.deepEqual(a.ship.cargo, cargo);
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), g.catalog, g.services, g.activities)
  );
});
/**
 * Verify the scenario: schema-5 saves migrate the committed exit without losing cultural
 * identity, job progress or follow.
 */
test('schema-5 saves migrate the committed exit without losing cultural identity, job progress or follow', () => {
  const c = createCatalog(),
    raw = readFileSync(new URL('./fixtures/traffic-v5.json', import.meta.url), 'utf8'),
    old = JSON.parse(raw),
    g = loadSession(raw, c, createServices(), createActivities()),
    a = g.traffic.get('ashen-trader')!;
  assert.equal(JSON.parse(g.save()).version, 6);
  assert.equal(g.clock, old.clock);
  assert.equal(g.followedActorId, 'ashen-trader');
  assert.equal(a.cultureId, 'frontier');
  assert.equal(a.ship.designId, 'industrial-merchant');
  assert.deepEqual(a.ship.position, {
    x: old.traffic[0].ship.position.x * 5,
    y: old.traffic[0].ship.position.y * 5,
    z: old.traffic[0].ship.position.z * 5
  });
  assert.equal(a.motion.kind, 'flight');
  if (a.motion.kind === 'flight' && a.motion.stage === 'egress') {
    assert.equal(a.motion.gateId, 'ashen-egress');
    assert.equal(a.motion.connectionId, 'ashen-to-kepler');
  }
  assert.equal(
    g.traffic.actors.filter(
      /** Select the fixture identities required for this persistence or uniqueness check. */
      (a) => a.ship.id === 'vesper-freight-1'
    ).length,
    1
  );
  assert.doesNotThrow(
    /** Exercise save decoding and migration with a supported fixture and require it to succeed. */
    () => loadSession(g.save(), c, g.services, g.activities)
  );
});
/**
 * Verify the scenario: current saves reject missing, mismatched and invalid route
 * endpoints.
 */
test('current saves reject missing, mismatched and invalid route endpoints', () => {
  const g = game();
  tick(g, 8);
  const raw = JSON.parse(g.save());
  for (const edit of [
    /**
     * Remove a required committed gate from a current save to exercise strict exit-leg
     * validation.
     */
    (d: any) => delete d.traffic[0].motion.gateId,
    /** Give a saved flight a connection inconsistent with its recorded exit gate. */
    (d: any) => (d.traffic[0].motion.connectionId = 'ashen-to-vesper'),
    /**
     * Insert an unknown plotted destination to verify itinerary references are validated on
     * import.
     */
    (d: any) => (d.routeDestinationId = 'missing'),
    /** Point the saved departure gate at another system to test physical-endpoint validation. */
    (d: any) => (d.traffic[0].motion.gateId = 'kepler-egress')
  ]) {
    const d = structuredClone(raw);
    edit(d);
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
 * Verify the scenario: seeded generation is deterministic, preserves source content,
 * records provenance and separates layout streams.
 */
test('seeded generation is deterministic, preserves source content, records provenance and separates layout streams', () => {
  const source = readContent(root),
    before = JSON.stringify(source),
    a = expandUniverse(source, blueprint, presets),
    b = expandUniverse(source, blueprint, presets);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(source), before);
  const nova = a.bundle.systems.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (s) => s.id === 'nova'
  )!;
  assert.deepEqual(nova.generation, { generatorVersion: 2, seed: 83, presetId: 'frontier' });
  const changed = structuredClone(presets);
  changed.presets.frontier.traffic[0].count = 2;
  const more = expandUniverse(source, blueprint, changed).bundle.systems.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (s) => s.id === 'nova'
  )!;
  assert.deepEqual(more.stations, nova.stations);
  assert.deepEqual(more.landmarks, nova.landmarks);
  assert.deepEqual(more.gates, nova.gates);
  assert.equal(more.traffic.length, 2);
  catalogFromData(a.bundle.definition, a.bundle.systems);
});
/**
 * Verify the scenario: connection creation is paired and idempotent without regenerating
 * customized systems.
 */
test('connection creation is paired and idempotent without regenerating customized systems', () => {
  const source = readContent(root);
  source.systems.find(
    /** Locate the fixture record matching the identity or state required by the assertion. */
    (s) => s.id === 'ashen'
  )!.stations[0].name = 'Handwritten Haven';
  const a = expandUniverse(source, blueprint, presets),
    nova = a.bundle.systems.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'nova'
    )!;
  nova.description = 'Handwritten peculiarity';
  nova.stations[0].name = 'Private Dock';
  const b = expandUniverse(a.bundle, blueprint, presets);
  assert.deepEqual(b.bundle, a.bundle);
  assert.deepEqual(b.created, []);
  assert.deepEqual(b.retained, ['nova']);
  assert.deepEqual(b.linked, []);
  assert.equal(
    b.bundle.systems.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'ashen'
    )!.stations[0].name,
    'Handwritten Haven'
  );
  assert.throws(
    /** Attempt universe expansion so the assertion can verify that invalid input is rejected. */
    () =>
      expandUniverse(
        source,
        { ...blueprint, systems: [{ ...blueprint.systems[0], id: 'ashen' }] },
        presets,
        { rejectExisting: true }
      ),
    /already exists/
  );
});
/**
 * Verify the scenario: CLI creation, dry-run, connection and replay preserve hand-edited
 * files on disk.
 */
test('CLI creation, dry-run, connection and replay preserve hand-edited files on disk', () => {
  const { temp, content } = tempContent();
  try {
    const ashenPath = join(content, 'systems/ashen.json'),
      original = JSON.parse(readFileSync(ashenPath, 'utf8'));
    original.stations[0].description = 'KEEP THIS NOTE';
    writeFileSync(ashenPath, JSON.stringify(original, null, 3));
    const args = [
      '--root',
      content,
      '--id',
      'nova',
      '--name',
      'Nova',
      '--seed',
      '83',
      '--preset',
      'frontier',
      '--connect',
      'ashen',
      '--x',
      '2',
      '--y',
      '1'
    ];
    const dry = runUniverse('create', [...args, '--dry-run']);
    assert.deepEqual(dry.created, ['nova']);
    assert.equal(readContent(content).systems.length, systemCount);
    runUniverse('create', args);
    assert.equal(readContent(content).systems.length, systemCount + 1);
    assert.equal(
      JSON.parse(readFileSync(ashenPath, 'utf8')).stations[0].description,
      'KEEP THIS NOTE'
    );
    const path = join(content, 'systems/nova.json'),
      custom = JSON.parse(readFileSync(path, 'utf8'));
    custom.stations[0].name = 'Custom Dock';
    writeFileSync(path, JSON.stringify(custom, null, 4));
    const before = readFileSync(path, 'utf8');
    runUniverse('generate', ['--root', content, '--blueprint', writeBlueprint(temp, blueprint)]);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(
      /**
       * Attempt the real authoring CLI so the assertion can verify that invalid input is
       * rejected.
       */
      () => runUniverse('create', args),
      /already exists/
    );
    assert.equal(
      runUniverse('validate', ['--root', content, '--check-index']).systems,
      systemCount + 1
    );
    const connected = runUniverse('connect', [
      '--root',
      content,
      '--from',
      'nova',
      '--to',
      'kepler'
    ]);
    assert.equal(connected.connections!.length, 1);
    assert.equal(
      runUniverse('connect', ['--root', content, '--from', 'nova', '--to', 'kepler']).files.length,
      0
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
/**
 * Write a blueprint into the temporary authoring workspace and return its path for the
 * real CLI.
 */
function writeBlueprint(temp: string, value: unknown) {
  const p = join(temp, 'blueprint.json');
  writeFileSync(p, JSON.stringify(value));
  return p;
}
/**
 * Verify the scenario: batch command expands a seeded tree and extends it without
 * overwriting earlier edits.
 */
test('batch command expands a seeded tree and extends it without overwriting earlier edits', () => {
  const { temp, content } = tempContent();
  try {
    const args = [
      '--root',
      content,
      '--seed',
      '42',
      '--prefix',
      'test-sector',
      '--anchor',
      'ashen'
    ];
    runUniverse('generate', [...args, '--count', '5']);
    const first = join(content, 'systems/test-sector-001.json'),
      custom = JSON.parse(readFileSync(first, 'utf8'));
    custom.name = 'CUSTOM NAME';
    writeFileSync(first, JSON.stringify(custom, null, 2));
    runUniverse('generate', [...args, '--count', '8']);
    const files = readContent(content),
      c = catalogFromData(files.definition, files.systems);
    assert.equal(files.systems.length, systemCount + 8);
    assert.equal(c.systems['test-sector-001'].name, 'CUSTOM NAME');
    assert.ok(new RouteResolver(c).find('test-sector-008', 'kepler'));
    assert.equal(runUniverse('generate', [...args, '--count', '8']).files.length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
/**
 * Verify the scenario: invalid generation validates everything before writing and protects
 * authored files.
 */
test('invalid generation validates everything before writing and protects authored files', () => {
  const { temp, content } = tempContent();
  try {
    const before = readFileSync(join(content, 'universe.json'), 'utf8'),
      bad = { ...blueprint, connections: [{ from: 'nova', to: 'unknown' }] };
    assert.throws(
      /**
       * Attempt the real authoring CLI so the assertion can verify that invalid input is
       * rejected.
       */
      () => runUniverse('generate', ['--root', content, '--blueprint', writeBlueprint(temp, bad)])
    );
    assert.equal(readFileSync(join(content, 'universe.json'), 'utf8'), before);
    assert.equal(readContent(content).systems.length, systemCount);
    assert.throws(
      /**
       * Attempt the real authoring CLI so the assertion can verify that invalid input is
       * rejected.
       */
      () =>
        runUniverse('create', [
          '--root',
          content,
          '--id',
          '../escape',
          '--seed',
          '2',
          '--name',
          'Bad',
          '--connect',
          'ashen',
          '--x',
          '0',
          '--y',
          '2'
        ])
    );
    assert.throws(
      /**
       * Attempt the real authoring CLI so the assertion can verify that invalid input is
       * rejected.
       */
      () =>
        runUniverse('generate', [
          '--root',
          content,
          '--count',
          '-1',
          '--seed',
          '1',
          '--prefix',
          'bad',
          '--anchor',
          'ashen'
        ])
    );
    assert.throws(
      /**
       * Attempt the real authoring CLI so the assertion can verify that invalid input is
       * rejected.
       */
      () => runUniverse('validate', ['--root', content, '--typo', 'x'])
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
/**
 * Verify the scenario: authored Vesper peculiarity survives rerunning its original
 * generation blueprint.
 */
test('authored Vesper peculiarity survives rerunning its original generation blueprint', () => {
  const source = readContent(root),
    input = JSON.parse(readFileSync(join(root, 'expansions/vesper.json'), 'utf8')),
    result = expandUniverse(source, input, presets);
  assert.deepEqual(result.bundle, source);
  assert.equal(
    result.bundle.systems.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'vesper'
    )!.landmarks[0].name,
    'The Lantern'
  );
  assert.equal(
    result.bundle.systems.find(
      /** Locate the fixture record matching the identity or state required by the assertion. */
      (s) => s.id === 'vesper'
    )!.stations[0].name,
    'Lantern Anchorage'
  );
});
/**
 * Verify the scenario: universe graph includes authored connections and a plotted
 * multi-hop path.
 */
test('universe graph includes authored connections and a plotted multi-hop path', () => {
  const g = game();
  jump(g, 'kepler');
  g.dispatch({ type: 'plot-route', systemId: 'vesper' });
  const svg = universeChart(g);
  assert.match(svg, /Kepler Drift/);
  assert.match(svg, /Vesper/);
  const edges = new Set(
    Object.values(g.catalog.systems).flatMap(
      /**
       * Collect all authored gate connections before comparing them with the rendered universe
       * graph.
       */
      (system) =>
        system.gates.flatMap(
          /**
           * Normalize each outgoing link into an undirected edge key for the graph's
           * one-edge-per-pair check.
           */
          (gate) =>
            gate.connections.map(
              /** Build the comparison values used by this scenario's assertions. */
              (link) => [system.id, link.systemId].sort().join('|')
            )
        )
    )
  );
  assert.equal((svg.match(/<line /g) ?? []).length, edges.size);
  assert.equal((svg.match(/class="plotted"/g) ?? []).length, 2);
});
