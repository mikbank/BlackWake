import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { definitions, pointDefenceMounts, type Ship } from './simulation';

type Culture = 'aster' | 'frontier';
type Role = 'freighter' | 'transit' | 'liner' | 'patrol';
type Finish = 'ceramic' | 'hull' | 'dark' | 'metal' | 'trim' | 'glass' | 'light';
type Engine = { x: number; y: number; z: number; r: number };

/**
 * Construct a role-specific Frontier or Aster hull along +X, merging static materials
 * while keeping PDC mounts and exhaust independently animated.
 */
function buildVariant(ship: Ship, culture: Culture, role: Role): THREE.Group {
  const aster = culture === 'aster';
  const model = new THREE.Group();
  const liveries: Record<string, { hull: string; trim: string }> = aster
    ? {
        police: { hull: '#4e7176', trim: '#6cb6c7' },
        transit: { hull: '#497d71', trim: '#62bba4' },
        liner: { hull: '#909988', trim: '#bca773' }
      }
    : {
        police: { hull: '#355776', trim: '#73b5ea' },
        transit: { hull: '#477c72', trim: '#a4dac1' },
        liner: { hull: '#aaac9b', trim: '#d6bb7a' }
      };
  const livery = liveries[ship.livery ?? ''];
  const palette: Record<Finish, THREE.MeshStandardMaterial> = {
    ceramic: new THREE.MeshStandardMaterial({
      color: aster ? '#e0ddd0' : '#b4bbaa',
      roughness: 0.8,
      metalness: 0.18
    }),
    hull: new THREE.MeshStandardMaterial({
      color:
        livery?.hull ??
        (aster
          ? '#697772'
          : role === 'patrol'
            ? '#395776'
            : role === 'transit'
              ? '#527c6d'
              : '#8e978b'),
      roughness: 0.68,
      metalness: 0.48
    }),
    dark: new THREE.MeshStandardMaterial({
      color: aster ? '#242a2d' : '#293940',
      roughness: 0.75,
      metalness: 0.6
    }),
    metal: new THREE.MeshStandardMaterial({
      color: aster ? '#a67751' : '#667f89',
      roughness: 0.5,
      metalness: 0.7
    }),
    trim: new THREE.MeshStandardMaterial({
      color: livery?.trim ?? (aster ? '#338b83' : role === 'patrol' ? '#87c4ea' : '#cf9150'),
      roughness: 0.65,
      metalness: 0.3
    }),
    glass: new THREE.MeshStandardMaterial({
      color: aster ? '#4aaea7' : '#81baca',
      emissive: aster ? '#307c7c' : '#487f9c',
      emissiveIntensity: 1.2,
      roughness: 0.22,
      metalness: 0.4
    }),
    light: new THREE.MeshStandardMaterial({
      color: '#efbf70',
      emissive: '#b47630',
      emissiveIntensity: 1.5
    })
  };
  const bins = new Map<Finish, THREE.BufferGeometry[]>();
  const engines: Engine[] = [];
  /**
   * Transform one detail into model-local coordinates and collect its geometry in a material
   * batch.
   */
  function part(
    g: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    finish: Finish,
    rotation = new THREE.Euler()
  ) {
    if (g.index) {
      const source = g;
      g = source.toNonIndexed();
      source.dispose();
    }
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(rotation),
        new THREE.Vector3(1, 1, 1)
      )
    );
    const list = bins.get(finish) ?? [];
    list.push(g);
    bins.set(finish, list);
  }
  /** Add a rectangular structural, shielding or cabin component to the static hull batch. */
  function box(x: number, y: number, z: number, l: number, w: number, h: number, finish: Finish) {
    part(new THREE.BoxGeometry(l, w, h), x, y, z, finish);
  }
  /**
   * Add a capped cylindrical component aligned along the hull or perpendicular to its flight
   * plane.
   */
  function cylinder(
    x: number,
    y: number,
    z: number,
    r: number,
    l: number,
    finish: Finish,
    alongX = true
  ) {
    part(
      new THREE.CylinderGeometry(r, r, l, 12),
      x,
      y,
      z,
      finish,
      new THREE.Euler(alongX ? 0 : Math.PI / 2, 0, alongX ? Math.PI / 2 : 0)
    );
  }
  /**
   * Add a retaining or docking ring with the orientation needed by the surrounding
   * spacecraft module.
   */
  function hoop(
    x: number,
    y: number,
    z: number,
    r: number,
    tube: number,
    finish: Finish,
    alongX = true
  ) {
    part(
      new THREE.TorusGeometry(r, tube, 5, 16),
      x,
      y,
      z,
      finish,
      new THREE.Euler(0, alongX ? Math.PI / 2 : 0, 0)
    );
  }
  /** Build a cylindrical support between two local-space attachment points. */
  function strut(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r = 0.8,
    finish: Finish = 'metal'
  ) {
    const a = new THREE.Vector3(ax, ay, az),
      b = new THREE.Vector3(bx, by, bz);
    const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6);
    g.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        b.clone().sub(a).normalize()
      )
    );
    const mid = a.add(b).multiplyScalar(0.5);
    part(g, mid.x, mid.y, mid.z, finish);
  }
  /** Extrude a polygon into a beveled armor panel centered on the requested elevation. */
  function plate(points: number[][], z: number, h: number, finish: Finish) {
    const shape = new THREE.Shape();
    points.forEach(
      /** Trace the planar polygon used to extrude a beveled hull panel. */
      ([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y))
    );
    shape.closePath();
    part(
      new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: true,
        bevelSize: 0.9,
        bevelThickness: 0.7,
        bevelSegments: 1,
        steps: 1
      }),
      0,
      0,
      z - h / 2,
      finish
    );
  }
  /**
   * Build a clipped-corner armored block from dimensions rather than reuse a nautical hull
   * silhouette.
   */
  function block(x: number, y: number, z: number, l: number, w: number, h: number, finish: Finish) {
    const a = l / 2,
      b = w / 2,
      c = Math.min(l, w) * 0.17;
    plate(
      [
        [x + a - c, y + b],
        [x - a + c, y + b],
        [x - a, y + b - c],
        [x - a, y - b + c],
        [x - a + c, y - b],
        [x + a - c, y - b],
        [x + a, y - b + c],
        [x + a, y + b - c]
      ],
      z,
      h,
      finish
    );
  }
  // Capsules use domed pressure ends under discrete shielding tiles. The dark joints
  // and exposed copper retaining hoops remain visible between ceramic sections.
  /**
   * Build a rounded pressure cell with retaining hoops and optional separate ceramic
   * shielding tiles.
   */
  function capsule(x: number, y: number, z: number, l: number, r: number, shield = true) {
    cylinder(x, y, z, r, l, 'dark');
    for (const s of [-1, 1]) {
      part(new THREE.SphereGeometry(r, 12, 8), x + (s * l) / 2, y, z, 'dark');
      hoop(x + s * l * 0.38, y, z, r + 0.5, 0.65, 'metal');
    }
    if (shield) {
      for (const side of [-1, 1]) {
        block(x, y + side * r * 0.54, z + r * 0.69, l * 0.82, r * 0.8, 2.4, 'ceramic');
        box(x + l * 0.22, y + side * r * 0.53, z + r * 0.69 + 1.5, 2.5, r * 0.68, 0.6, 'trim');
      }
    }
  }
  /** Add a thin thermal panel with repeated cooling-fin detail. */
  function radiator(x: number, y: number, z: number, l: number, w: number) {
    box(x, y, z, l, w, 1.1, 'dark');
    for (let i = 0; i < 7; i++)
      box(x - l * 0.42 + i * l * 0.14, y, z + 0.8, 0.8, w - 1, 0.65, 'metal');
  }
  /**
   * Assemble an engine housing and bell and record the aft plane used to anchor its animated
   * exhaust.
   */
  function drive(x: number, y: number, z: number, r: number, l: number) {
    cylinder(x, y, z, r + 1.8, l, 'dark');
    if (aster) {
      for (const side of [-1, 1])
        block(x + 1, y + side * r * 0.58, z + r * 0.72, l * 0.65, r * 0.8, 2, 'ceramic');
    } else block(x + 1, y, z + r * 0.25, l * 0.68, r * 1.7, r * 1.5, 'hull');
    const rear = x - l / 2;
    part(
      new THREE.CylinderGeometry(r, r * 0.65, 6, 12, 1, true),
      rear - 1,
      y,
      z,
      'metal',
      new THREE.Euler(0, 0, Math.PI / 2)
    );
    hoop(rear - 4, y, z, r, 0.7, 'dark');
    cylinder(rear - 3.6, y, z, r * 0.66, 0.5, 'glass');
    engines.push({ x: rear - 4.5, y, z, r });
  }
  /** Add a docking socket and retaining ring to the model's static structure. */
  function docking(x: number, y: number, z: number) {
    cylinder(x, y, z, 4.5, 3, 'dark', false);
    hoop(x, y, z + 2, 3.4, 0.8, 'metal', false);
    cylinder(x, y, z + 2, 2.5, 0.5, 'trim', false);
  }

  if (aster && role === 'freighter') {
    // An open, offset cargo cradle: six shielded removable pods flank a vacant
    // loading channel. The small control capsule occupies only the starboard corner.
    for (const side of [-1, 1]) {
      strut(-39, side * 16, -7, 34, side * 16, -7, 1.5, 'dark');
      strut(-39, side * 16, 8, 34, side * 16, 8, 1.2);
      for (const x of [-25, 0, 25]) {
        const px = x + (side === 1 ? -4 : 3);
        capsule(px, side * 30, 0, 15, 9);
        for (const z of [-6, 6]) strut(px, side * 16, z, px, side * 30, z, 1);
        strut(px - 8, side * 16, -7, px + 8, side * 16, 8, 0.7);
      }
    }
    block(-40, 0, 0, 16, 41, 22, 'hull');
    block(38, 0, -4, 9, 40, 9, 'ceramic');
    capsule(38, 10, 7, 13, 8);
    box(48, 10, 9, 1, 9, 3, 'glass');
    docking(35, -10, 4);
    radiator(-31, -42, -5, 21, 10);
    strut(-31, -16, -5, -31, -42, -5);
    drive(-45, -11, -1, 7, 18);
    drive(-45, 11, -1, 7, 18);
  } else if (aster && role === 'transit') {
    // A short articulated orbital bus: three separately shielded pressure cells,
    // flexible dark couplers, a side docking vestibule and a compact single drive.
    cylinder(1, 0, 0, 5, 72, 'metal');
    for (const [x, y, r] of [
      [-23, -2, 11],
      [1, 1, 12],
      [26, -1, 11]
    ]) {
      capsule(x, y, 0, 12, r);
      for (let i = 0; i < 3; i++) box(x - 4 + i * 4, y - r - 0.3, 2, 2.2, 0.8, 2.3, 'glass');
      block(x, y, -r + 0.5, 12, 10, 3, 'ceramic');
    }
    block(7, 18, 0, 16, 13, 13, 'dark');
    block(7, 22, 2, 12, 6, 11, 'ceramic');
    docking(7, 21, 9);
    box(39, -1, 2, 1, 10, 4, 'glass');
    radiator(-25, -22, -4, 17, 9);
    strut(-25, -9, -4, -25, -22, -4);
    drive(-43, 0, -1, 8, 15);
    block(23, 12, 2, 8, 4, 5, 'trim');
  } else if (aster && role === 'liner') {
    // A broad mobile habitat: twin capsule clusters support an elliptical communal
    // observation ring. Negative space through its centre keeps the ring readable.
    for (const side of [-1, 1]) {
      capsule(-8, side * 31, 0, 45, 10);
      capsule(21, side * 24, -4, 20, 8);
      strut(-30, side * 31, -5, 30, side * 15, -5, 1.5);
      for (const x of [-21, -1, 19]) {
        strut(x, side * 29, 5, x, side * 12, 8, 1);
        block(x, side * 31, 10, 14, 12, 2, 'ceramic');
        box(x, side * 39, 2, 9, 0.9, 2, 'glass');
      }
      drive(-44, side * 27, -2, 7, 19);
    }
    const ring = new THREE.TorusGeometry(21, 5.6, 8, 32);
    ring.scale(1.35, 1, 0.85);
    part(ring, 10, 0, 8, 'ceramic');
    const windows = new THREE.TorusGeometry(21, 1.2, 5, 32);
    windows.scale(1.35, 1, 1);
    part(windows, 10, 0, 12.8, 'glass');
    // Radial lifeboats and a forward observation pod, separate from the habitat ring.
    capsule(39, 0, 7, 10, 9);
    block(46, 0, 8, 3, 13, 7, 'glass');
    block(-25, 0, 0, 17, 22, 17, 'dark');
    docking(-25, 0, 10);
    for (const side of [-1, 1]) {
      capsule(-5, side * 45, -1, 12, 4, false);
      box(-5, side * 45, 4, 13, 5, 1.5, 'trim');
      radiator(-34, side * 42, -9, 18, 9);
    }
  } else if (aster && role === 'patrol') {
    // Twin cylindrical drive outriggers surround a compact diamond pressure cell.
    // Short ceramic armor petals leave dark joints, copper ties and a sensor fork exposed.
    plate(
      [
        [-25, 0],
        [-7, -17],
        [28, -12],
        [40, 0],
        [28, 12],
        [-7, 17]
      ],
      0,
      17,
      'dark'
    );
    plate(
      [
        [-16, 0],
        [1, -13],
        [29, -9],
        [34, 0],
        [29, 9],
        [1, 13]
      ],
      7,
      7,
      'ceramic'
    );
    for (const side of [-1, 1]) {
      strut(-25, side * 7, 0, -25, side * 24, 0, 2, 'metal');
      strut(1, side * 11, 0, -8, side * 24, 0, 1.5, 'dark');
      drive(-27, side * 24, 0, 8, 40);
      block(-12, side * 24, 7, 15, 12, 3, 'ceramic');
      block(7, side * 17, -3, 18, 7, 8, 'hull');
      cylinder(20, side * 17, -3, 1.4, 12, 'metal');
      box(15, side * 9, 12, 10, 4, 1, 'trim');
    }
    box(35, 0, 2, 1, 10, 4, 'glass');
    strut(18, -10, 6, 34, -24, 6, 0.8);
    block(36, -25, 6, 9, 6, 6, 'dark');
    box(41, -25, 6, 0.8, 4, 3, 'glass');
    radiator(-29, 0, -10, 15, 18);
    docking(-8, 0, 13);
  } else if (role === 'transit') {
    // Frontier passenger conversion: a long rectangular pressure bus with repeated
    // rib frames, flush cabin glazing and a conspicuous lateral boarding airlock.
    block(0, 0, 0, 80, 26, 23, 'dark');
    for (const x of [-23, 0, 23]) {
      block(x, 0, 2, 20, 29, 23, 'hull');
      block(x, 0, 13, 17, 24, 3, 'ceramic');
      for (const side of [-1, 1]) {
        box(x, side * 15, 5, 14, 1, 3, 'glass');
        box(x, side * 15, -6, 16, 1.5, 2, 'trim');
      }
    }
    block(39, 0, 0, 10, 24, 20, 'ceramic');
    box(45, 0, 4, 1, 16, 4, 'glass');
    block(5, -21, 0, 16, 12, 16, 'ceramic');
    box(5, -28, 0, 9, 1, 11, 'dark');
    box(5, -28.6, 2, 7, 0.6, 2, 'light');
    docking(5, -21, 10);
    radiator(-28, 22, -6, 20, 13);
    strut(-28, 10, -6, -28, 22, -6, 1.3);
    drive(-44, 0, -1, 10, 17);
    for (const side of [-1, 1]) cylinder(-38, side * 17, -4, 4, 14, 'metal');
  } else if (role === 'liner') {
    // Frontier liner: a broad, solid multi-cell accommodation raft, framed in
    // utilitarian rectangular spars, with a shallow forward panorama gallery.
    block(-5, 0, -3, 82, 64, 20, 'dark');
    for (const side of [-1, 1]) {
      block(-8, side * 22, 4, 71, 21, 23, 'ceramic');
      for (const x of [-29, -11, 7, 25]) {
        box(x, side * 22, 17, 14, 19, 2, 'hull');
        box(x, side * 33, 6, 12, 1, 4, 'glass');
        box(x, side * 33, -3, 12, 1, 2, 'trim');
      }
      block(-7, side * 39, -3, 42, 10, 12, 'hull');
      radiator(-33, side * 42, -11, 21, 10);
      drive(-45, side * 22, -3, 8, 19);
    }
    block(35, 0, 1, 23, 61, 24, 'hull');
    block(47, 0, 4, 4, 52, 13, 'dark');
    box(49.5, 0, 6, 1, 44, 6, 'glass');
    block(20, 0, 14, 20, 22, 10, 'ceramic');
    for (const x of [-23, -6]) docking(x, 0, 10);
    box(28, 0, 20, 5, 14, 1, 'trim');
    drive(-45, 0, -7, 7, 19);
  } else {
    // Frontier patrol: a short, heavy six-sided armor raft with rectangular
    // armored drive shoulders and an exposed fore sensor rake, unlike the player cutter.
    plate(
      [
        [-36, -24],
        [0, -34],
        [31, -17],
        [38, 0],
        [31, 17],
        [0, 34],
        [-36, 24]
      ],
      0,
      20,
      'hull'
    );
    plate(
      [
        [-27, -18],
        [4, -24],
        [30, -12],
        [33, 12],
        [4, 24],
        [-27, 18]
      ],
      10,
      5,
      'ceramic'
    );
    for (const side of [-1, 1]) {
      block(-27, side * 29, -1, 37, 16, 23, 'dark');
      block(-24, side * 29, 3, 26, 16, 19, 'hull');
      for (const x of [-31, -20, -9]) box(x, side * 29, 14, 7, 13, 2, 'ceramic');
      drive(-42, side * 29, -2, 7, 15);
      box(12, side * 21, 14, 14, 5, 1, 'trim');
      block(30, side * 18, -5, 15, 7, 8, 'dark');
      cylinder(40, side * 18, -5, 1.5, 11, 'metal');
    }
    block(14, 0, 16, 17, 19, 9, 'dark');
    box(23, 0, 17, 1, 13, 3, 'glass');
    strut(32, -9, 2, 45, -9, 2, 1);
    strut(32, 9, 2, 45, 9, 2, 1);
    box(46, 0, 2, 3, 23, 5, 'dark');
    box(48, 0, 2, 1, 17, 2, 'glass');
    radiator(-19, 0, -12, 28, 21);
    docking(-18, 0, 15);
  }

  // All models share simulation attachment coordinates, independent of role silhouette.
  pointDefenceMounts.forEach(
    /** Add structural sockets at the exact PDC hardpoint coordinates used by the simulation. */
    (m) => {
      const x = m.x * 100,
        y = m.y * 100,
        z = m.z * 100;
      strut(x, y, 0, x, y, z - 2, 1.8, 'dark');
      block(x, y, z - 3, 9, 8, 4, 'hull');
    }
  );
  // RCS clusters and service markings are deliberately sparse at the gameplay scale.
  for (const side of [-1, 1]) {
    block(32, side * 11, -8, 5, 4, 5, 'dark');
    box(32, side * 13.5, -8, 2, 0.8, 2, 'metal');
  }
  for (const [finish, geometries] of bins) {
    const merged = mergeGeometries(geometries, false);
    if (!merged) throw Error(`Cannot merge ${culture}-${role} geometry`);
    const mesh = new THREE.Mesh(merged, palette[finish]);
    mesh.name = `${culture}-${role}-${finish}`;
    model.add(mesh);
    geometries.forEach(
      /**
       * Release temporary source geometries after they have been merged into the static material
       * batch.
       */
      (g) => g.dispose()
    );
  }
  // Two batched turret meshes each, with barrels authored towards +X. View rotates
  // the parent mount about Z without disturbing their simulation muzzle origins.
  pointDefenceMounts.forEach(
    /** Build each independently rotating PDC mount at its simulation-defined hardpoint. */
    (m, index) => {
      const mount = new THREE.Group();
      mount.name = `pdc-${index}`;
      mount.position.set(m.x * 100, m.y * 100, m.z * 100);
      const turret = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), palette.ceramic);
      turret.position.set(0.5, 0, 2);
      mount.add(turret);
      const pieces: THREE.BufferGeometry[] = [];
      for (const y of [-0.9, 0.9]) {
        const barrel = new THREE.CylinderGeometry(0.45, 0.45, 7, 6);
        barrel.rotateZ(Math.PI / 2);
        barrel.translate(5, y, 2.1);
        pieces.push(barrel);
      }
      const barrels = mergeGeometries(pieces, false)!;
      pieces.forEach(
        /** Release temporary barrel pieces after merging them into one turret mesh. */
        (g) => g.dispose()
      );
      mount.add(new THREE.Mesh(barrels, palette.metal));
      model.add(mount);
    }
  );
  const flame = new THREE.Group();
  flame.name = 'flame';
  flame.position.x = engines[0].x;
  const plumeMaterial = new THREE.MeshBasicMaterial({
    color: aster ? '#77dfd3' : '#8bcfee',
    transparent: true,
    opacity: 0.65,
    depthWrite: false
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: '#d7fbff',
    transparent: true,
    opacity: 0.8,
    depthWrite: false
  });
  for (const engine of engines) {
    for (const [r, l, material] of [
      [engine.r * 0.66, 22, plumeMaterial],
      [engine.r * 0.34, 14, coreMaterial]
    ] as const) {
      const plume = new THREE.Mesh(new THREE.ConeGeometry(r, l, 10), material);
      plume.rotation.z = Math.PI / 2;
      plume.position.set(engine.x - flame.position.x - l / 2, engine.y, engine.z);
      flame.add(plume);
    }
  }
  model.add(flame);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(76, 77, 64),
    new THREE.MeshBasicMaterial({
      color: ship.owner === 'player' ? '#80c5bc' : '#d5ac6b',
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    })
  );
  ring.name = 'ring';
  ring.position.z = -3;
  model.add(ring);
  // Dispose palette entries that this particular silhouette never attached.
  for (const finish of Object.keys(palette) as Finish[])
    if (!bins.has(finish) && finish !== 'ceramic' && finish !== 'metal') palette[finish].dispose();
  model.scale.setScalar(definitions[ship.kind].length / 100);
  model.userData.modelKind = ship.kind;
  model.userData.culture = culture;
  model.userData.variantRole = role;
  return model;
}

/** Complete provider models in simulation units; imported by the central registry. */
export const shipModelVariants: Array<[string, (ship: Ship) => THREE.Group]> = [
  [
    'aster-freighter',
    /** Build the Aster Compact's modular cargo-cradle freighter. */
    (ship) => buildVariant(ship, 'aster', 'freighter')
  ],
  [
    'aster-transit',
    /** Build the Aster Compact's segmented commuter transport. */
    (ship) => buildVariant(ship, 'aster', 'transit')
  ],
  [
    'aster-liner',
    /** Build the Aster Compact's twin-habitat observation liner. */
    (ship) => buildVariant(ship, 'aster', 'liner')
  ],
  [
    'aster-patrol',
    /** Build the Aster Compact's separated-drive patrol hull. */
    (ship) => buildVariant(ship, 'aster', 'patrol')
  ],
  [
    'frontier-transit',
    /** Build the Frontier commuter's cabin-bus silhouette. */
    (ship) => buildVariant(ship, 'frontier', 'transit')
  ],
  [
    'frontier-liner',
    /** Build the Frontier leisure liner's broad accommodation silhouette. */
    (ship) => buildVariant(ship, 'frontier', 'liner')
  ],
  [
    'frontier-patrol',
    /** Build the Frontier patrol cutter's compact armored silhouette. */
    (ship) => buildVariant(ship, 'frontier', 'patrol')
  ]
];
