import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createCatalog, makeShip, position } from './content/universe';
import {
  currentSpatialVersion,
  legacyDistanceScale,
  stationSizeChange,
  stationFootprintRadius
} from './content/spatial-scale';
import { stationApproachDistance, stationBerth } from './game/station-approach';
import { startFreeRoam, startRaid } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { migrateSpatialSave } from './game/spatial-migration';
import { canDock, canJump } from './game/interactions';
import { buildSystemModels, disposeSystemModels } from './ui/system-model';
import { definitions, distance } from './core/model';
import { FlightCamera } from './flight-camera';
import { View } from './view';
import { Navigation } from './navigation';
import { approachPoint } from './hud';
import { readContent } from '../tools/content-files';
import { expandUniverse } from './content/generation/generate';

/** Build a current-coordinate voyage with its real station sizes and persistent traffic ledger. */
function game() {
  return startFreeRoam(createCatalog(), createServices(), createActivities(), {
    trafficWarmup: false
  });
}
/** Express a current save in the previous coordinate revision without altering physical velocities or timers. */
function oldCoordinates(value: any) {
  if (Array.isArray(value)) {
    for (const item of value) oldCoordinates(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'velocity') continue;
    if (['position', 'from', 'to'].includes(key) && child && typeof child === 'object') {
      for (const axis of ['x', 'y', 'z'])
        if (typeof (child as any)[axis] === 'number') (child as any)[axis] /= legacyDistanceScale;
    } else if (key === 'responseRange' && typeof child === 'number')
      value[key] = child / legacyDistanceScale;
    else oldCoordinates(child);
  }
}

/** Verify canonical system positions and bounds are physically expanded without changing hull dimensions. */
test('authored layouts are five times larger while stations grow three times and ships keep their handling', () => {
  const g = game(),
    s = g.definition,
    station = s.stations[0];
  assert.equal(s.radius, 1600 * legacyDistanceScale);
  assert.deepEqual(
    station.position,
    position(-340 * legacyDistanceScale, -260 * legacyDistanceScale)
  );
  assert.equal(s.landmarks[0].radius, 170 * legacyDistanceScale);
  assert.equal(g.catalog.stationSizes.small.scale, stationSizeChange);
  assert.equal(g.catalog.stationSizes.small.dockRadius, 165 * stationSizeChange);
  assert.equal(definitions.cutter.length, 46);
  assert.equal(definitions.cutter.speed, 115);
  assert.equal(definitions.merchant.speed, 65);
  assert.equal(g.catalog.spatialVersion, currentSpatialVersion);
});

/** Verify every station class offers exterior berths and a useful physical docking envelope for both hull classes. */
test('scaled station approaches keep ships outside structural geometry and inside docking range', () => {
  const catalog = createCatalog();
  for (const size of Object.values(catalog.stationSizes))
    for (const kind of ['cutter', 'merchant'] as const) {
      const station = { ...catalog.systems.ashen.stations[0], size: size.id };
      const ship = makeShip('visitor', 'Visitor', kind, 'guild', 0, 0);
      ship.position = stationBerth(station, size, ship, catalog.systems.ashen.radius);
      assert.ok(
        distance(ship.position, station.position) >
          stationFootprintRadius * size.scale + definitions[kind].length / 2
      );
      assert.ok(canDock(ship, station, size));
      assert.ok(stationApproachDistance(size, kind) < size.dockRadius);
    }
});

/** Verify the larger station model's actual bounds dominate the unchanged ship scale and touch projection follows its depth. */
test('station geometry scales independently of ship dimensions', () => {
  const catalog = createCatalog(),
    definition = catalog.systems.ashen,
    root = buildSystemModels({
      definition,
      theme: catalog.themes.frontier,
      sizes: catalog.stationSizes,
      key: 'scale',
      dockedAt: null
    });
  const station = root.getObjectByName('haven')!;
  station.updateMatrixWorld(true);
  assert.equal(station.scale.x, 3);
  const bounds = new THREE.Box3().setFromObject(station),
    extent = bounds.getSize(new THREE.Vector3());
  assert.ok(extent.x > definitions.cutter.length * 8);
  assert.ok(extent.z > definitions.cutter.length * 5);
  disposeSystemModels(root);
});

/** Verify normal autopilot can stop beside the larger structure and offer docking without entering the hub. */
test('station autopilot arrives at a safe exterior point with normal ship speeds', () => {
  const g = game();
  g.dispatch({ type: 'undock' });
  const station = g.definition.stations[0],
    size = g.catalog.stationSizes[station.size],
    ship = g.world.player;
  ship.position = position(station.position.x + 1700, station.position.y);
  ship.velocity = position(0, 0);
  const nav = new Navigation();
  nav.radius = g.definition.radius;
  nav.moveTo(
    approachPoint(ship.position, station.position, stationApproachDistance(size, ship.kind))
  );
  for (let i = 0; i < 5000 && nav.destination; i++) g.step(1 / 60, nav.input(g.world));
  assert.equal(nav.destination, null);
  assert.ok(g.canDock(station));
  assert.ok(distance(ship.position, station.position) > stationFootprintRadius * size.scale);
});

/** Verify legacy voyages move spatial data once while retaining identities, cargo, health, velocities and the game clock. */
test('old voyage coordinates migrate once without multiplying velocities or losing persistent state', () => {
  const g = game();
  g.dispatch({ type: 'undock' });
  g.world.player.position = position(-2100, 800);
  g.world.player.velocity = position(17, -8);
  const actor = g.traffic.get('ashen-trader')!;
  actor.ship.hull = 43;
  actor.ship.cargo = { rations: 7 };
  actor.ship.velocity = position(12, 3);
  const raw = JSON.parse(g.save()),
    expectedPlayer = { ...g.world.player.position },
    expectedNpc = { ...actor.ship.position };
  oldCoordinates(raw);
  delete raw.spatialVersion;
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.deepEqual(restored.world.player.position, expectedPlayer);
  assert.deepEqual(restored.world.player.velocity, position(17, -8));
  const npc = restored.traffic.get(actor.ship.id)!;
  assert.deepEqual(npc.ship.position, expectedNpc);
  assert.deepEqual(npc.ship.velocity, position(12, 3));
  assert.equal(npc.ship.hull, 43);
  assert.deepEqual(npc.ship.cargo, { rations: 7 });
  assert.equal(npc.cultureId, actor.cultureId);
  assert.equal(restored.clock, g.clock);
  const saved = restored.save();
  assert.equal(JSON.parse(saved).spatialVersion, currentSpatialVersion);
  const twice = loadSession(saved, g.catalog, g.services, g.activities);
  assert.deepEqual(twice.world.player.position, expectedPlayer);
  assert.deepEqual(twice.traffic.get(actor.ship.id)!.ship.position, expectedNpc);
});

/** Verify local waypoint configurations and active leg targets migrate before strict gate-link validation. */
test('legacy patrol routes and egress legs resolve against enlarged gate coordinates', () => {
  const g = game(),
    actor = g.traffic.get('ashen-trader')!,
    gate = g.definition.gates[0],
    hop = g.routes.connection(g.systemId, gate.connections[0].id)!;
  const action = {
    kind: 'travel' as const,
    destination: {
      kind: 'station' as const,
      systemId: hop.toSystemId,
      stationId: g.catalog.systems[hop.toSystemId].stations[0].id
    },
    activity: 'Freight'
  };
  actor.motion = {
    kind: 'flight',
    systemId: g.systemId,
    stage: 'egress',
    gateId: gate.id,
    connectionId: hop.connectionId,
    leg: g.traffic.navigation.leg(actor, g.clock, gate.position),
    action
  };
  const raw = JSON.parse(g.save());
  oldCoordinates(raw);
  delete raw.spatialVersion;
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities),
    motion = restored.traffic.get(actor.ship.id)!.motion;
  assert.equal(motion.kind, 'flight');
  if (motion.kind === 'flight') {
    assert.deepEqual(motion.leg.to, gate.position);
    assert.ok(motion.leg.arriveAt > g.clock);
  }
  const patrol = restored.traffic.get('kepler-patrol')!;
  assert.equal((patrol.job.config as any).responseRange, 5500);
  assert.deepEqual((patrol.job.config as any).waypoints[0].position, position(-2400, 900));
});

/** Verify transiting NPCs retain their shared four-second journey deadline instead of multiplying clocks with distances. */
test('spatial upgrades leave transit and waiting deadlines unchanged', () => {
  const raw: any = {
    version: 6,
    clock: 100,
    spatialVersion: 0,
    traffic: [
      {
        ship: { position: position(12, 8), velocity: position(20, 0) },
        motion: { kind: 'transit', until: 104, action: { kind: 'wait', duration: 9 } },
        job: { config: { responseRange: 1100 } }
      }
    ]
  };
  assert.equal(migrateSpatialSave(raw, 1), true);
  assert.equal(raw.clock, 100);
  assert.equal(raw.traffic[0].motion.until, 104);
  assert.equal(raw.traffic[0].motion.action.duration, 9);
  assert.deepEqual(raw.traffic[0].ship.position, position(60, 40));
  assert.deepEqual(raw.traffic[0].ship.velocity, position(20, 0));
  assert.equal(migrateSpatialSave(raw, 1), false);
  assert.deepEqual(raw.traffic[0].ship.position, position(60, 40));
});

/** Verify old unmanaged salvage survives spatial migration without acquiring new ownership or duplicate ledger entries. */
test('unmanaged system snapshot positions migrate alongside the controlled hull and traffic ledger', () => {
  const g = game(),
    salvage = makeShip('old-salvage', 'Old salvage', 'merchant', 'salvage', 1300, -800);
  salvage.engines = 0;
  salvage.designId = 'industrial-merchant';
  g.world.addShip(salvage);
  const raw = JSON.parse(g.save());
  oldCoordinates(raw);
  delete raw.spatialVersion;
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities),
    found = restored.world.ships.filter(
      /** Count unmanaged salvage copies after world materialization. */ (ship) =>
        ship.id === salvage.id
    );
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].position, salvage.position);
  assert.equal(found[0].owner, 'salvage');
  assert.equal(restored.traffic.get(salvage.id), undefined);
});

/** Verify docking and gateway coordinates stay aligned after loading a save from before the scale change. */
test('old docked and gate-position saves remain physically meaningful after migration', () => {
  const g = game();
  let raw = JSON.parse(g.save());
  oldCoordinates(raw);
  delete raw.spatialVersion;
  let restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.equal(restored.dockedAt, 'haven');
  assert.deepEqual(restored.world.player.position, g.definition.stations[0].position);
  g.dispatch({ type: 'undock' });
  const gate = g.definition.gates[0];
  g.world.player.position = { ...gate.position };
  g.world.player.velocity = position(0, 0);
  raw = JSON.parse(g.save());
  oldCoordinates(raw);
  delete raw.spatialVersion;
  restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.ok(canJump(restored.world.player, restored.definition.gates[0]));
  assert.equal(restored.traffic.actors.length, g.traffic.actors.length);
});

/** Verify old schema-1 raid saves gain the same spatial revision without changing their encounter ownership. */
test('legacy raid coordinates convert into the current scale and remain loadable', () => {
  const g = startRaid(createCatalog(), createServices(), createActivities()),
    ships = structuredClone(g.world.ships);
  oldCoordinates(ships);
  const raw = { version: 1, ships, stage: 'raid', elapsed: 0, disable: true };
  const restored = loadSession(JSON.stringify(raw), g.catalog, g.services, g.activities);
  assert.equal(restored.world.player.id, g.world.player.id);
  assert.deepEqual(restored.world.ships[1].position, g.world.ships[1].position);
  assert.equal(JSON.parse(restored.save()).spatialVersion, currentSpatialVersion);
});

/** Verify unknown or reverse coordinate revisions fail explicitly rather than silently corrupting positions. */
test('unsupported spatial revisions are rejected', () => {
  assert.throws(
    /** Reject a future coordinate revision that this game cannot decode. */ () =>
      migrateSpatialSave({ spatialVersion: 99 }, 1)
  );
  assert.throws(
    /** Prevent a scaled save from loading against an older unscaled catalog. */ () =>
      migrateSpatialSave({ spatialVersion: 1 }, 0)
  );
});

/** Verify new systems inherit the expanded size ranges and use current station clearance without increasing hull sizes. */
test('creator defaults and size presets match the larger universe', () => {
  const source = readContent('content'),
    presets = JSON.parse(readFileSync('content/presets.json', 'utf8'));
  const result = expandUniverse(
    source,
    {
      schemaVersion: 1,
      systems: [
        {
          id: 'large-trial',
          name: 'Large Trial',
          seed: 89,
          preset: 'frontier',
          size: 'large',
          chart: { x: 4, y: 3 }
        }
      ],
      connections: [{ from: 'ashen', to: 'large-trial' }]
    },
    presets
  );
  const created = result.bundle.systems.at(-1)!;
  assert.ok(created.radius >= 20000 && created.radius <= 30000);
  assert.ok(created.landmarks[0].radius >= 750);
  assert.equal(created.generation?.generatorVersion, 2);
  assert.equal(result.bundle.definition.stationSizes.small.scale, 3);
});

/** Verify the camera supports larger authored worlds while preserving ship framing and touch coordinates. */
test('camera far planes and projected station targets adapt to enlarged worlds', () => {
  const rig = new FlightCamera();
  rig.resize(390, 844);
  rig.setSystemRadius(40000);
  const ship = makeShip('p', 'Pilot', 'cutter', 'player', 0, 0);
  rig.update(ship, undefined, 0);
  assert.ok(rig.chase.far >= 83000);
  assert.ok(rig.tactical.far >= 83000);
  const fake = { camera: rig.camera, width: 390, height: 844 } as View;
  const near = View.prototype.screenRadius.call(fake, position(0, 100), 240),
    far = View.prototype.screenRadius.call(fake, position(0, 4000), 240);
  assert.ok(near > far);
  assert.ok(far > 0);
  assert.ok(near <= 390 * 0.4);
});

/** Verify exterior NPC berths remain clear when a station sits near a system boundary. */
test('station berths turn inward at sector edges rather than clamping ships inside the station', () => {
  const catalog = createCatalog(),
    size = catalog.stationSizes.medium,
    station = { ...catalog.systems.ashen.stations[0], position: position(0, 1750), size: 'medium' };
  for (const id of ['alpha', 'beta', 'gamma']) {
    const ship = makeShip(id, id, 'merchant', 'guild', 0, 0),
      berth = stationBerth(station, size, ship, 1800);
    assert.ok(Math.hypot(berth.x, berth.y) < 1800);
    assert.ok(distance(berth, station.position) > stationFootprintRadius * size.scale);
  }
});

/** Verify explicit compact systems still generate valid clearance even though default size presets are larger. */
test('numeric radius overrides retain usable small-system authoring', () => {
  const source = readContent('content'),
    presets = JSON.parse(readFileSync('content/presets.json', 'utf8'));
  const result = expandUniverse(
    source,
    {
      schemaVersion: 1,
      systems: [
        {
          id: 'compact-trial',
          name: 'Compact Trial',
          seed: 19,
          preset: 'frontier',
          radius: 1200,
          chart: { x: 4, y: 4 }
        }
      ],
      connections: [{ from: 'ashen', to: 'compact-trial' }]
    },
    presets
  );
  const system = result.bundle.systems.at(-1)!;
  assert.equal(system.radius, 1200);
  assert.equal(system.gates.length, 1);
  assert.ok(system.stations.length > 0);
});
