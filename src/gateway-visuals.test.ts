import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCatalog } from './content/universe';
import { hyperspaceVisualState, projectHyperspaceStar } from './ui/hyperspace-motion';
import { createHyperspaceGateway, animateHyperspaceGateways } from './ui/gateway-model';
import { disposeSystemModels } from './ui/system-model';
import { hyperspaceHoldFraction } from './game/jump-travel';

/** Verify every journey visibly progresses from acceleration through a full tunnel to stopped point stars. */
test('hyperspace phases accelerate, traverse the wormhole and return to a stationary star field', () => {
  const launch = hyperspaceVisualState(0),
    acceleration = hyperspaceVisualState(0.15),
    tunnel = hyperspaceVisualState(0.5),
    exit = hyperspaceVisualState(0.9),
    arrival = hyperspaceVisualState(1);
  assert.equal(launch.phase, 'departure');
  assert.equal(launch.tunnel, 0);
  assert.ok(acceleration.speed > launch.speed);
  assert.ok(acceleration.streak > launch.streak);
  assert.equal(tunnel.phase, 'wormhole');
  assert.equal(tunnel.tunnel, 1);
  assert.equal(exit.phase, 'arrival');
  assert.ok(exit.speed < tunnel.speed);
  assert.ok(exit.streak < acceleration.streak);
  assert.equal(arrival.speed, 0);
  assert.equal(arrival.streak, 0);
  assert.equal(arrival.tunnel, 0);
});

/** Verify slow-load holds remain inside the full tunnel rather than replaying the completed exit sequence. */
test('loading hold keeps the wormhole fully visible with no premature deceleration', () => {
  const hold = hyperspaceVisualState(hyperspaceHoldFraction);
  assert.equal(hold.phase, 'wormhole');
  assert.equal(hold.tunnel, 1);
  assert.equal(hold.speed, 1);
});

/** Verify smooth visual envelopes have no discontinuity at phase boundaries or invalid numeric output. */
test('motion envelopes remain bounded and continuous throughout a journey', () => {
  for (let n = 0; n <= 1000; n++) {
    const state = hyperspaceVisualState(n / 1000);
    for (const value of [state.speed, state.streak, state.tunnel])
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
  for (const boundary of [0.18, 0.23, 0.25, 0.36, 0.69, 0.72, 0.82, 0.88, 1]) {
    const before = hyperspaceVisualState(boundary - 1e-6),
      after = hyperspaceVisualState(boundary + 1e-6);
    for (const field of ['speed', 'streak', 'tunnel'] as const)
      assert.ok(Math.abs(before[field] - after[field]) < 1e-4);
  }
});

/** Verify approaching stars expand toward the viewer in every quadrant and on both phone and landscape viewports. */
test('decreasing star depth projects outward from the vanishing point', () => {
  for (const [width, height] of [
    [390, 844],
    [1000, 600]
  ]) {
    for (const x of [-0.3, 0.3])
      for (const y of [-0.3, 0.3]) {
        const far = projectHyperspaceStar(x, y, 1, width, height),
          near = projectHyperspaceStar(x, y, 0.5, width, height);
        const centre = { x: width * 0.5, y: height * 0.43 };
        assert.ok(
          Math.hypot(near.x - centre.x, near.y - centre.y) >
            Math.hypot(far.x - centre.x, far.y - centre.y)
        );
        assert.equal(Math.sign(near.x - centre.x), Math.sign(x));
        assert.equal(Math.sign(near.y - centre.y), Math.sign(y));
      }
  }
});

/** Verify the gateway's physical-looking aperture faces the radial approach while retaining authored navigation data. */
test('gateway orientation and approach position preserve existing jump eligibility data', () => {
  const catalog = createCatalog(),
    definition = catalog.systems.ashen,
    gate = definition.gates[0],
    before = JSON.stringify(gate);
  const model = createHyperspaceGateway(gate, catalog.themes[definition.themeId]);
  model.updateMatrixWorld(true);
  const aperture = model.getObjectByName('gateway-aperture')!;
  const axis = new THREE.Vector3(0, 0, 1).transformDirection(aperture.matrixWorld);
  const expected = new THREE.Vector3(gate.position.x, gate.position.y, 0).normalize();
  assert.ok(axis.dot(expected) > 0.999999);
  assert.equal(JSON.stringify(gate), before);
  assert.equal(model.position.x, gate.position.x);
  assert.equal(model.position.y, gate.position.y);
  assert.equal(model.name, gate.id);
  disposeSystemModels(model);
});

/** Verify batching leaves a clear vessel aperture and keeps hardware draw submissions bounded. */
test('industrial gateway hardware stays outside the open flight aperture and is batched', () => {
  const catalog = createCatalog(),
    gate = catalog.systems.ashen.gates[0];
  const model = createHyperspaceGateway(gate, catalog.themes.frontier),
    body = model.children[0];
  let meshes = 0;
  for (const object of body.children) {
    if (!(object instanceof THREE.Mesh) || object.name === 'gateway-aperture') continue;
    meshes++;
    const positions = object.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++)
      assert.ok(Math.hypot(positions.getY(i), positions.getZ(i)) > 70);
  }
  assert.ok(meshes <= 5);
  disposeSystemModels(model);
});

/** Verify gateway energy animation owns no simulation state and all resulting resources can be released. */
test('gateway membrane animates through a presentation uniform and disposes normally', () => {
  const catalog = createCatalog(),
    model = createHyperspaceGateway(catalog.systems.ashen.gates[0], catalog.themes.frontier),
    root = new THREE.Group();
  root.add(model);
  animateHyperspaceGateways(root, 3.5);
  const aperture = model.getObjectByName('gateway-aperture') as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.ShaderMaterial
  >;
  assert.equal(aperture.material.uniforms.time.value, 3.5);
  let disposed = false;
  aperture.material.addEventListener(
    'dispose',
    /** Observe the gateway shader lifetime at system unload. */ () => {
      disposed = true;
    }
  );
  disposeSystemModels(root);
  assert.equal(disposed, true);
});
