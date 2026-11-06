import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { shipModelVariants } from './ship-model-variants';
import { disposeShipModel } from './ship-model';
import { definitions, pointDefenceMounts, type Ship } from './simulation';

/** Create a minimal hull record of the gameplay class required by a model provider. */
function fixture(id: string): Ship {
  return {
    id,
    name: id,
    kind: /freighter|liner/.test(id) ? 'merchant' : 'cutter',
    owner: 'civilian',
    factionId: 'guild',
    role: 'trader',
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    heading: 0,
    hull: 100,
    engines: 100,
    crew: 12,
    cargo: {},
    reload: [0, 0]
  };
}

for (const [id, build] of shipModelVariants) {
  /** Verify the scenario: the generated provider or state variant. */
  test(`${id}: finite batched geometry and simulation-compatible attachments`, () => {
    const ship = fixture(id),
      model = build(ship);
    model.updateMatrixWorld(true);
    const ring = model.getObjectByName('ring');
    assert.ok(ring instanceof THREE.Mesh);
    assert.ok(ring.material instanceof THREE.MeshBasicMaterial);
    assert.ok(model.getObjectByName('flame') instanceof THREE.Group);
    for (const [index, m] of pointDefenceMounts.entries()) {
      const mount = model.getObjectByName(`pdc-${index}`);
      assert.ok(mount instanceof THREE.Group);
      const actual = mount.getWorldPosition(new THREE.Vector3());
      const expected = new THREE.Vector3(m.x, m.y, m.z).multiplyScalar(
        definitions[ship.kind].length
      );
      assert.ok(actual.distanceTo(expected) < 1e-10, `mount ${index} matches simulation`);
    }
    const geometry = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    let meshes = 0,
      triangles = 0;
    const hullBounds = new THREE.Box3();
    model.traverse(
      /**
       * Inspect each model node for the geometry, transform or resource invariant asserted by
       * this scenario.
       */
      (object) => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        geometry.add(object.geometry);
        for (const mat of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(mat);
        const positions = object.geometry.getAttribute('position');
        assert.ok(positions && positions.count > 0);
        for (const value of positions.array) assert.ok(Number.isFinite(value), 'finite vertices');
        triangles += (object.geometry.index?.count ?? positions.count) / 3;
        if (object.name.startsWith(id)) {
          object.geometry.computeBoundingBox();
          hullBounds.union(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld));
        }
      }
    );
    assert.ok(meshes < 40, `${meshes} meshes fit mobile budget`);
    assert.ok(triangles < 50000, `${triangles} triangles fit procedural budget`);
    const size = hullBounds.getSize(new THREE.Vector3());
    assert.ok(size.x > definitions[ship.kind].length * 0.8);
    assert.ok(size.x < definitions[ship.kind].length * 1.5);
    assert.ok(size.z > 5, 'volumetric hull');
    const flame = model.getObjectByName('flame')!;
    const exhaustPlane = flame.position.x * model.scale.x;
    for (const scale of [0.45, 2]) {
      flame.scale.x = scale;
      model.updateMatrixWorld(true);
      for (const plume of flame.children) {
        assert.ok(plume instanceof THREE.Mesh);
        plume.geometry.computeBoundingBox();
        const bounds = plume.geometry.boundingBox!.clone().applyMatrix4(plume.matrixWorld);
        assert.ok(
          Math.abs(bounds.max.x - exhaustPlane) < 1e-5,
          'exhaust front stays at its drive root during thrust animation'
        );
      }
    }
    let disposedGeometry = 0,
      disposedMaterials = 0;
    geometry.forEach(
      /** Attach a disposal counter to each distinct resource before releasing the model. */
      (g) =>
        g.addEventListener(
          'dispose',
          /** Count geometry releases so the test detects missing or duplicate disposal. */
          () => disposedGeometry++
        )
    );
    materials.forEach(
      /** Attach a disposal counter to each distinct resource before releasing the model. */
      (m) =>
        m.addEventListener(
          'dispose',
          /** Count material releases so the test detects missing or duplicate disposal. */
          () => disposedMaterials++
        )
    );
    disposeShipModel(model);
    assert.equal(disposedGeometry, geometry.size);
    assert.equal(disposedMaterials, materials.size);
    console.log(
      `${id}: ${meshes} meshes, ${triangles} triangles, hull ${size
        .toArray()
        .map(
          /** Build the comparison values used by this scenario's assertions. */
          (n) => n.toFixed(1)
        )
        .join(' × ')}`
    );
  });
}

/** Verify the scenario: variants have seven different static silhouette geometries. */
test('variants have seven different static silhouette geometries', () => {
  const signatures = shipModelVariants.map(
    /** Construct the graphics fixture used to compare registered model providers. */
    ([id, build]) => {
      const model = build(fixture(id));
      const positions: string[] = [];
      model.traverse(
        /**
         * Inspect each model node for the geometry, transform or resource invariant asserted by
         * this scenario.
         */
        (object) => {
          if (object instanceof THREE.Mesh && object.name.startsWith(id)) {
            positions.push(Array.from(object.geometry.getAttribute('position').array).join(','));
          }
        }
      );
      disposeShipModel(model);
      return positions.join('|');
    }
  );
  assert.equal(new Set(signatures).size, 7);
});

/**
 * Verify the scenario: known liveries change accent materials without replacing culture
 * geometry or ceramic shields.
 */
test('known liveries change accent materials without replacing culture geometry or ceramic shields', () => {
  for (const [id, build] of shipModelVariants) {
    const original = build(fixture(id));
    const dressed = build({ ...fixture(id), livery: 'police' });
    /** Locate the batched hull mesh so livery material and geometry can be compared. */
    const hull = (model: THREE.Group) =>
      model.getObjectByName(`${id}-hull`) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshStandardMaterial
      >;
    /**
     * Locate the ceramic shielding mesh so a paint overlay cannot silently replace cultural
     * construction detail.
     */
    const ceramic = (model: THREE.Group) =>
      model.getObjectByName(`${id}-ceramic`) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshStandardMaterial
      >;
    assert.notEqual(hull(original).material.color.getHex(), hull(dressed).material.color.getHex());
    assert.equal(
      ceramic(original).material.color.getHex(),
      ceramic(dressed).material.color.getHex()
    );
    assert.deepEqual(
      hull(original).geometry.getAttribute('position').array,
      hull(dressed).geometry.getAttribute('position').array
    );
    disposeShipModel(original);
    disposeShipModel(dressed);
  }
});
