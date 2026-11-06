import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlightCamera } from './flight-camera';
import { View } from './view';
import { buildSystemModels, disposeSystemModels } from './ui/system-model';
import { createCatalog, makeShip } from './content/universe';

/** Construct a browser-free view adapter for exercising the real projection and pointer methods. */
function fixture(rig: FlightCamera, width: number, height: number) {
  const rect = { left: 12, top: 58, width, height };
  const view = {
    camera: rig.camera,
    width,
    height,
    /** Coordinate tests have already sized the independent camera rig. */
    resize() {},
    renderer: {
      domElement: {
        /** Supply an offset viewport to detect client-coordinate drift. */
        getBoundingClientRect() {
          return rect;
        }
      }
    }
  } as unknown as View;
  return { view, rect };
}

/** Verify the initial camera reveals hull volume without mutating the planar simulation. */
test('3D chase is the default and keeps the player visible below screen centre', () => {
  const rig = new FlightCamera(),
    ship = makeShip('p', 'Pilot', 'cutter', 'player', 300, -200);
  ship.heading = 1.1;
  const before = structuredClone(ship);
  rig.resize(390, 844);
  rig.update(ship, undefined, 1 / 60);
  assert.equal(rig.mode, 'chase');
  assert.ok(rig.camera instanceof THREE.PerspectiveCamera);
  assert.deepEqual(ship, before);
  const ndc = new THREE.Vector3(ship.position.x, ship.position.y, 0).project(rig.camera);
  assert.ok(Math.abs(ndc.x) < 0.01 && ndc.y < 0 && ndc.y > -0.8 && ndc.z < 1);
  assert.deepEqual(rig.chase.up.toArray(), [0, 0, 1]);
});

/** Verify a wrapped heading turns the view through the short arc and remains stable at zero elapsed time. */
test('camera smoothing crosses the heading seam without a full orbit', () => {
  const rig = new FlightCamera(),
    ship = makeShip('p', 'Pilot', 'cutter', 'player', 0, 0);
  ship.heading = Math.PI - 0.01;
  rig.update(ship, undefined, 1 / 60);
  const before = rig.chase.position.clone();
  ship.heading = -Math.PI + 0.01;
  rig.update(ship, undefined, 1 / 60);
  assert.ok(before.distanceTo(rig.chase.position) < 1);
  const paused = rig.chase.position.clone();
  ship.position.x = 100;
  rig.update(ship, undefined, 0);
  assert.deepEqual(rig.chase.position.toArray(), paused.toArray());
});

/** Verify both cameras round-trip pointer coordinates under portrait, landscape and nonzero canvas offsets. */
test('perspective and tactical pointer rays recover the same world destination', () => {
  for (const mode of ['chase', 'tactical'] as const) {
    for (const [width, height] of [
      [390, 844],
      [1100, 650]
    ]) {
      const rig = new FlightCamera(),
        ship = makeShip('p', 'Pilot', 'cutter', 'player', 200, -140);
      ship.heading = 0.6;
      rig.resize(width, height);
      rig.setMode(mode);
      rig.update(ship, undefined, 1 / 60);
      const { view } = fixture(rig, width, height),
        target = { x: 250, y: -100 };
      const screen = View.prototype.project.call(view, target.x, target.y);
      assert.equal(screen.visible, true);
      const hit = View.prototype.worldPoint.call(view, screen.x, screen.y);
      assert.ok(hit && Math.hypot(hit.x - target.x, hit.y - target.y) < 1e-6);
      assert.equal(hit.z, 0);
    }
  }
});

/** Verify sky taps and objects behind the chase camera cannot masquerade as flight-plane contacts. */
test('sky rays return no course and behind-camera contacts are not selectable', () => {
  const rig = new FlightCamera(),
    ship = makeShip('p', 'Pilot', 'cutter', 'player', 0, 0);
  ship.heading = 0;
  rig.resize(390, 844);
  rig.update(ship, undefined, 1 / 60);
  const { view, rect } = fixture(rig, 390, 844);
  assert.equal(View.prototype.worldPoint.call(view, rect.left + rect.width / 2, rect.top), null);
  const behind = View.prototype.project.call(view, -3000, 0);
  assert.equal(behind.visible, false);
  assert.ok(behind.y > rect.top + rect.height);
});

/** Verify changing systems snaps the presentation to arrival instead of flying across unrelated coordinates. */
test('camera reset and tactical switching retain the correct viewport and arrival', () => {
  const rig = new FlightCamera(),
    ship = makeShip('p', 'Pilot', 'cutter', 'player', 0, 0);
  rig.resize(844, 390);
  rig.update(ship, undefined, 1 / 60);
  ship.position.x = 9000;
  rig.reset();
  rig.update(ship, undefined, 0);
  assert.ok(rig.chase.position.x > 8000);
  rig.setMode('tactical');
  rig.update(ship, undefined, 0);
  assert.equal(rig.camera, rig.tactical);
  assert.equal(rig.tactical.position.x, 9000);
  assert.ok(
    Math.abs(
      (rig.tactical.right - rig.tactical.left) / (rig.tactical.top - rig.tactical.bottom) -
        844 / 390
    ) < 1e-9
  );
  rig.setMode('chase');
  rig.update(ship, undefined, 0);
  assert.ok(rig.chase.position.x > 8000);
});

/** Verify procedural planet textures and volumetric structures build without a DOM and release all owned GPU resources. */
test('system model generation and disposal cover 3D geometry and texture ownership', () => {
  const catalog = createCatalog(),
    definition = catalog.systems['ashen'];
  const root = buildSystemModels({
    definition,
    theme: catalog.themes[definition.themeId],
    sizes: catalog.stationSizes,
    key: 'test',
    dockedAt: null
  });
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  root.traverse(
    /** Inspect resource ownership without allocating a WebGL renderer. */ (object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material))
          if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  );
  assert.equal(
    root.children.filter(
      /** Include the gateway resource bundles in disposal coverage. */ (object) =>
        object.userData.kind === 'hyperspace-gateway'
    ).length,
    definition.gates.length
  );
  assert.ok(geometries.size > 0);
  assert.ok(textures.size > 0);
  let disposed = 0;
  for (const resource of [...geometries, ...materials, ...textures])
    resource.addEventListener(
      'dispose',
      /** Count each resource release exactly once. */ () => disposed++
    );
  disposeSystemModels(root);
  assert.equal(disposed, geometries.size + materials.size + textures.size);
});
