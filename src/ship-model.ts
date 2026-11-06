import type { ShipDesignDefinition } from './content/schema';
import { defaultShipDesigns, validateShipDesign } from './content/identity';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { definitions, pointDefenceMounts, type Ship } from './simulation';
import { shipModelVariants } from './ship-model-variants';

/**
 * Construct the original industrial hull in real 3D along the positive X axis, batching
 * static parts by material for mobile rendering.
 */
function buildIndustrialShip(ship: Ship): THREE.Group {
  const model = new THREE.Group(),
    merchant = ship.kind === 'merchant';
  const liveries: Record<string, { hull: string; trim: string }> = {
    police: { hull: '#355776', trim: '#73b5ea' },
    transit: { hull: '#477c72', trim: '#a4dac1' },
    liner: { hull: '#aaac9b', trim: '#d6bb7a' }
  };
  const livery = liveries[ship.livery ?? ''];
  const palette = {
    armor: new THREE.MeshStandardMaterial({
      color: livery?.hull ?? (merchant ? '#66716c' : '#4b6577'),
      metalness: 0.45,
      roughness: 0.72
    }),
    pale: new THREE.MeshStandardMaterial({
      color: merchant ? '#b4b9ab' : '#b8c7cb',
      metalness: 0.35,
      roughness: 0.64
    }),
    dark: new THREE.MeshStandardMaterial({ color: '#28343c', metalness: 0.65, roughness: 0.63 }),
    steel: new THREE.MeshStandardMaterial({ color: '#617782', metalness: 0.72, roughness: 0.52 }),
    gold: new THREE.MeshStandardMaterial({ color: '#b77c43', metalness: 0.25, roughness: 0.8 }),
    red: new THREE.MeshStandardMaterial({
      color: livery?.trim ?? (merchant ? '#8b5a38' : '#cf6b39'),
      metalness: 0.3,
      roughness: 0.85
    }),
    black: new THREE.MeshStandardMaterial({ color: '#101c25', metalness: 0.4, roughness: 0.8 }),
    window: new THREE.MeshStandardMaterial({
      color: '#83b7c5',
      emissive: '#73aabd',
      emissiveIntensity: 1.4,
      metalness: 0.4,
      roughness: 0.2
    }),
    amber: new THREE.MeshStandardMaterial({
      color: '#edb65e',
      emissive: '#e48b39',
      emissiveIntensity: 1.8
    })
  };
  type Finish = keyof typeof palette;
  const bins = new Map<Finish, THREE.BufferGeometry[]>();
  /**
   * Transform one geometry into hull-local space and queue it by finish for later material
   * batching.
   */
  function part(
    g: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    finish: Finish,
    rotation: THREE.Euler = new THREE.Euler()
  ) {
    if (g.index) {
      const nonIndexed = g.toNonIndexed();
      g.dispose();
      g = nonIndexed;
    }
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(rotation),
        new THREE.Vector3(1, 1, 1)
      )
    );
    const list = bins.get(finish) || [];
    list.push(g);
    bins.set(finish, list);
  }
  /**
   * Add a rectangular hull component to the static geometry batch, optionally rotated in the
   * flight plane.
   */
  function box(
    x: number,
    y: number,
    z: number,
    l: number,
    w: number,
    h: number,
    m: Finish,
    angle = 0
  ) {
    part(new THREE.BoxGeometry(l, w, h), x, y, z, m, new THREE.Euler(0, 0, angle));
  }
  /** Add a cylindrical component with its axis oriented for the requested hull detail. */
  function cylinder(
    x: number,
    y: number,
    z: number,
    r: number,
    h: number,
    m: Finish,
    alongX = false
  ) {
    part(
      new THREE.CylinderGeometry(r, r, h, 8),
      x,
      y,
      z,
      m,
      new THREE.Euler(alongX ? 0 : Math.PI / 2, 0, alongX ? Math.PI / 2 : 0)
    );
  }
  /** Build a narrow structural member joining two local points in the hull frame. */
  function brace(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    m: Finish
  ) {
    const a = new THREE.Vector3(ax, ay, az),
      b = new THREE.Vector3(bx, by, bz);
    const g = new THREE.CylinderGeometry(r, r, a.distanceTo(b), 5);
    g.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        b.clone().sub(a).normalize()
      )
    );
    part(g, ...(a.add(b).multiplyScalar(0.5).toArray() as [number, number, number]), m);
  }
  /** Extrude an authored planar outline into a beveled armored component. */
  function shell(points: number[][], z: number, depth: number, m: Finish) {
    const s = new THREE.Shape();
    points.forEach(
      /** Trace the hull outline before extrusion into armored geometry. */
      ([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))
    );
    s.closePath();
    part(
      new THREE.ExtrudeGeometry(s, {
        depth,
        bevelEnabled: true,
        bevelSize: 1.3,
        bevelThickness: 1,
        bevelSegments: 1,
        steps: 1
      }),
      0,
      0,
      z,
      m
    );
  }
  // Blunt, volumetric pressure bodies. No prow, deck, keel or superstructure.
  /** Assemble the layered pressure-hull body used by this industrial ship class. */
  function body(x: number, y: number, z: number, l: number, w: number, h: number, m: Finish) {
    const a = l / 2,
      b = w / 2,
      c = Math.min(4, w * 0.18);
    shell(
      [
        [x + a, y + b - c],
        [x + a - c, y + b],
        [x - a + c, y + b],
        [x - a, y + b - c],
        [x - a, y - b + c],
        [x - a + c, y - b],
        [x + a - c, y - b],
        [x + a, y - b + c]
      ],
      z - h / 2,
      h,
      m
    );
  }
  /** Add a pressure tank and its surrounding fittings to the hull's merged static detail. */
  function tank(x: number, y: number, z: number, r: number, l: number, m: Finish) {
    cylinder(x, y, z, r, l, m, true);
    for (const side of [-1, 1]) {
      part(new THREE.SphereGeometry(r, 10, 6), x + (side * l) / 2, y, z, m);
      part(
        new THREE.TorusGeometry(r + 0.4, 0.8, 4, 10),
        x + side * (l / 2 - 1),
        y,
        z,
        'steel',
        new THREE.Euler(0, Math.PI / 2, 0)
      );
    }
  }
  if (merchant) {
    // A pusher tug: separated forward pressure capsule and heavy aft drive block.
    body(-40, 0, 0, 27, 43, 31, 'dark');
    body(-38, 0, 4, 22, 38, 24, 'armor');
    body(38, 0, 0, 28, 31, 25, 'pale');
    body(50, 0, 0, 5, 25, 19, 'armor');
    box(53, 0, 3, 1, 17, 6, 'black');
    box(53.6, -3, 3, 0.5, 6, 1.2, 'window');
    // Central plumbing and an open load-bearing frame with negative space around it.
    cylinder(-1, 0, 0, 7.5, 52, 'steel', true);
    for (const y of [-11, 11])
      for (const z of [-10, 10]) {
        brace(-28, y, z, 26, y, z, 1.1, 'dark');
        for (let x = -24; x < 22; x += 14) brace(x, y, z, x + 12, -y, z, 0.65, 'steel');
      }
    // Four independent cryogenic cargo pods surround the frame.
    for (const x of [-13, 13])
      for (const side of [-1, 1]) {
        const y = side * 25;
        tank(x, y, 0, 8.5, 13, 'pale');
        box(x, y, 9, 16, 8, 1.5, 'armor');
        box(x + 3, y, 10, 3, 8, 1, 'red');
        for (const dx of [-7, 7]) {
          brace(x + dx, side * 11, -8, x + dx, y, -7, 1, 'dark');
          brace(x + dx, side * 11, 8, x + dx, y, 7, 1, 'dark');
        }
        for (let i = 0; i < 3; i++) box(x - 4 + i * 4, y - 2, 10.2, 1.2, 3, 1, 'black');
      }
    // Docking collar above the forward capsule and a compact side-mounted comms dish.
    cylinder(37, 0, 15, 6, 4, 'dark');
    part(new THREE.TorusGeometry(4.8, 1, 5, 12), 37, 0, 18, 'steel');
    cylinder(37, 0, 18, 3.4, 0.7, 'black');
    brace(-2, -13, 8, -2, -38, 12, 1, 'dark');
    cylinder(-2, -38, 14, 5.8, 1.8, 'steel');
    cylinder(-2, -38, 15, 4.3, 0.5, 'black');
    // Reactor service modules are chunky volumes, not a rising bridge tower.
    body(-39, -5, 17, 15, 21, 8, 'pale');
    box(-32, -5, 21.5, 2, 13, 1, 'red');
    for (let i = 0; i < 5; i++) box(-44 + i * 2.5, 3, 21.5, 1, 5, 1, 'black');
  } else {
    // A compact armored escort: octagonal pressure spine and flat sensor face.
    body(-3, 0, 0, 87, 26, 27, 'dark');
    body(5, 0, 3, 63, 28, 23, 'armor');
    body(36, 0, 1, 27, 32, 24, 'pale');
    body(50, 0, 0, 5, 27, 18, 'armor');
    box(53, 0, 2, 1, 21, 8, 'black');
    box(53.6, -3, 3, 0.5, 10, 1.5, 'window');
    for (const side of [-1, 1]) {
      // Offset drive nacelles and separated gun pods break the long boat silhouette.
      body(-30, side * 19, -1, 34, 12, 19, 'dark');
      body(-27, side * 19, 2, 22, 11, 17, 'pale');
      body(10, side * 19, 0, 23, 9, 16, 'armor');
      box(10, side * 24, 0, 14, 2, 6, 'black');
      for (let i = 0; i < 3; i++) box(-37 + i * 9, side * 19, 11, 6, 8, 1.5, 'armor');
      box(29, side * 9, 13.5, 5, 9, 1.3, 'red');
      // Flush armor panels and recessed access hatches.
      for (let i = 0; i < 4; i++) {
        const x = -19 + i * 12;
        box(x, side * 7, 15, 10, 9, 1.8, 'pale');
        box(x + 3, side * 7, 16.2, 1, 3, 0.7, 'dark');
      }
    }
    // Compact off-axis pressure cabin, with one narrow recessed visor.
    body(11, -3, 16, 22, 13, 9, 'dark');
    body(14, -3, 19, 15, 12, 6, 'pale');
    box(22, -3, 20, 1, 9, 2, 'black');
    box(22.6, -3, 20, 0.5, 6, 0.7, 'window');
    cylinder(-21, 0, 16, 6, 3, 'steel');
    cylinder(-21, 0, 18, 4, 1, 'black');
    brace(28, 13, 9, 39, 23, 9, 0.8, 'steel');
    box(39, 23, 9, 6, 7, 4, 'dark');
    box(42.5, 23, 9, 0.8, 5, 2, 'amber');
  }
  // Lateral gun pods remain broadside weapons, housed in compact hardpoints.
  for (const side of [-1, 1]) {
    for (const x of merchant ? [-25, 26] : [-9, 14]) {
      const y = side * (merchant ? 16 : 22);
      body(x, y, 8, 10, 7, 8, 'dark');
      box(x, y, 12.5, 8, 6, 1, 'armor');
      for (const dx of [-1.5, 1.5])
        part(new THREE.CylinderGeometry(0.8, 0.8, 7, 6), x + dx, y + side * 5, 8, 'steel');
    }
    // Louvered thermal panels; asymmetry makes the escort read as machinery in vacuum.
    const rx = merchant ? -37 : -28,
      ry = side * (merchant ? 36 : 32),
      count = merchant ? 7 : side === 1 ? 8 : 4;
    brace(rx, side * (merchant ? 20 : 20), -5, rx, ry, -5, 1, 'steel');
    box(rx, ry, -5, count * 2.6 + 2, 12, 1.8, 'black');
    for (let i = 0; i < count; i++)
      box(rx - count * 1.3 + i * 2.6, ry, -3.8, 1.4, 11, 0.9, 'steel');
    // Small RCS clusters on several faces of the pressure body.
    for (const x of [-40, 39]) {
      box(x, side * (merchant ? 17 : 14), -6, 5, 4, 5, 'dark');
      box(x, side * (merchant ? 19.5 : 16.5), -6, 2, 1, 2, 'black');
      box(x, side * (merchant ? 17 : 14), -9, 2, 2, 1, 'window');
    }
    brace(-40, side * 7, 14, 23, side * 7, 14, 0.6, 'steel');
  }
  // Recessed aft engine bells and coolant rings. All thrust points along the long axis.
  const engines = merchant ? [-14, 0, 14] : [-19, 19];
  engines.forEach(
    /** Assemble each industrial engine housing and aft bell at its class-specific mount. */
    (y) => {
      const z = merchant ? 0 : -1;
      body(-48, y, z, 16, merchant ? 13 : 12, 14, 'dark');
      part(
        new THREE.CylinderGeometry(5.8, 4.2, 8, 12, 1, true),
        -57,
        y,
        z,
        'steel',
        new THREE.Euler(0, 0, Math.PI / 2)
      );
      part(
        new THREE.TorusGeometry(5.4, 0.8, 4, 12),
        -61,
        y,
        z,
        'dark',
        new THREE.Euler(0, Math.PI / 2, 0)
      );
      cylinder(-60.5, y, z, 3.6, 0.6, 'window', true);
      for (let i = 0; i < 3; i++) box(-50 + i * 3, y, 8, 1.2, 10, 1, 'armor');
    }
  );
  // Utility markings and flush sensor plates, with no decorative crest or spire.
  for (let i = 0; i < 3; i++) box(39, 6 - i * 3, 13.5, 5, 1, 1, 'dark');
  box(-43, -9, merchant ? 21.5 : 12, 4, 5, 1, 'red');
  for (let i = 0; i < 3; i++)
    box(-44 + i * 2, -9, merchant ? 22.2 : 12.7, 1, 4, 0.5, i % 2 ? 'black' : 'gold');
  // PDC bases are structural sockets, sharing their location with the simulation.
  pointDefenceMounts.forEach(
    /** Add structural bases at the simulation's normalized PDC attachment positions. */
    (m) => {
      body(m.x * 100, m.y * 100, m.z * 100 - 3, 9, 8, 4, 'armor');
    }
  );
  // Merge only static parts. Turret rotation and engine flames stay independent.
  for (const [finish, geometries] of bins) {
    const merged = mergeGeometries(geometries, false);
    if (merged) {
      const mesh = new THREE.Mesh(merged, palette[finish]);
      mesh.name = finish;
      model.add(mesh);
    }
    for (const g of geometries) g.dispose();
  }
  pointDefenceMounts.forEach(
    /** Build the animated PDC mount and barrels around its fixed simulation hardpoint. */
    (m, index) => {
      const mount = new THREE.Group();
      mount.name = `pdc-${index}`;
      mount.position.set(m.x * 100, m.y * 100, m.z * 100);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4, 3, 10), palette.dark);
      base.rotation.x = Math.PI / 2;
      mount.add(base);
      const drum = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 4), palette.pale);
      drum.position.set(1, 0, 2);
      mount.add(drum);
      for (const y of [-0.8, 0.8])
        for (const z of [1.4, 2.8]) {
          const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 6, 5), palette.steel);
          barrel.rotation.z = Math.PI / 2;
          barrel.position.set(5, y, z);
          mount.add(barrel);
        }
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.7, 6, 4), palette.window);
      lens.position.set(1, 0, 4.4);
      mount.add(lens);
      model.add(mount);
    }
  );
  const flames = new THREE.Group();
  flames.name = 'flame';
  flames.position.set(-62, 0, merchant ? 0 : -1);
  for (const y of engines) {
    const plume = new THREE.Mesh(
      new THREE.ConeGeometry(3.7, 25, 12),
      new THREE.MeshBasicMaterial({
        color: '#87dcf2',
        transparent: true,
        opacity: 0.6,
        depthWrite: false
      })
    );
    plume.rotation.z = Math.PI / 2;
    plume.position.set(-12, y, 0);
    flames.add(plume);
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(2, 17, 10),
      new THREE.MeshBasicMaterial({
        color: '#d3f8ff',
        transparent: true,
        opacity: 0.8,
        depthWrite: false
      })
    );
    core.rotation.z = Math.PI / 2;
    core.position.set(-8, y, 0);
    flames.add(core);
  }
  model.add(flames);
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
  model.scale.setScalar(definitions[ship.kind].length / 100);
  model.userData.modelKind = ship.kind;
  return model;
}

/**
 * Visual-provider contract: return a complete hull group in simulation units with ring,
 * flame and named PDC attachments.
 */
export type ShipModelBuilder = (ship: Ship) => THREE.Group;
/** Providers build complete models in simulation units, with ring/flame/PDC attachment names. */
export const shipModelBuilders = new Map<string, ShipModelBuilder>([
  ['industrial-cutter', buildIndustrialShip],
  ['industrial-merchant', buildIndustrialShip],
  ...shipModelVariants
]);
/**
 * Build the geometry-cache identity from hull class, explicit design and livery; ownership
 * and location do not rebuild a model.
 */
export function shipAppearanceKey(ship: Ship) {
  return JSON.stringify([ship.kind, ship.designId ?? `industrial-${ship.kind}`, ship.livery ?? '']);
}
/** Fail at graphics startup if any registered design has no corresponding model builder. */
export function validateShipModelProviders(designs: Record<string, ShipDesignDefinition>) {
  for (const design of Object.values(designs))
    if (!shipModelBuilders.has(design.modelId))
      throw Error(`Missing ship model provider: ${design.modelId}`);
}
/**
 * Select and build the hull's registered visual design, validate required animated
 * attachments and record its cache identity.
 */
export function createShipModel(
  ship: Ship,
  designs: Record<string, ShipDesignDefinition> = defaultShipDesigns
): THREE.Group {
  const resolved =
      ship.designId === undefined ? { ...ship, designId: `industrial-${ship.kind}` } : ship,
    design = validateShipDesign(resolved, designs),
    build = shipModelBuilders.get(design.modelId);
  if (!build) throw Error(`Missing ship model provider: ${design.modelId}`);
  const model = build(resolved);
  if (
    [
      'ring',
      'flame',
      ...pointDefenceMounts.map(
        /** Generate the attachment names required by the shared model-provider contract. */
        (_, i) => `pdc-${i}`
      )
    ].some(
      /** Reject a model provider missing a ring, exhaust group or PDC mount. */
      (name) => !model.getObjectByName(name)
    )
  ) {
    disposeShipModel(model);
    throw Error(`Ship model lacks required attachments: ${design.modelId}`);
  }
  model.userData.modelKind = ship.kind;
  model.userData.modelKey = shipAppearanceKey(resolved);
  model.userData.designId = design.id;
  return model;
}

/**
 * Release each unique geometry and material beneath a hull once, including resources
 * shared by several model parts.
 */
export function disposeShipModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  root.traverse(
    /**
     * Collect unique mesh resources so shared geometry and materials are not disposed more
     * than once.
     */
    (o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    }
  );
  geometries.forEach(
    /** Release each distinct geometry owned by the model. */
    (g) => g.dispose()
  );
  materials.forEach(
    /** Release each distinct material owned by the model. */
    (m) => m.dispose()
  );
}

/**
 * Own an isolated rotatable inspection scene using the same ship factory as flight
 * rendering.
 */
export class ShipPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000);
  private model: THREE.Group;
  private pivot = new THREE.Group();
  private radius = 1;
  private angle = -0.6;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private dragging = false;
  private lastX = 0;
  /**
   * Create preview graphics, frame the hull and bind pointer controls; the catalog supplies
   * exactly the same design lookup as flight.
   */
  constructor(
    private canvas: HTMLCanvasElement,
    ship: Ship,
    designs: Record<string, ShipDesignDefinition> = defaultShipDesigns
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.add(new THREE.HemisphereLight('#b9dce9', '#293039', 2));
    const key = new THREE.DirectionalLight('#ffe3ae', 3);
    key.position.set(40, 10, 100);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#79bfda', 2);
    rim.position.set(-80, -50, 40);
    this.scene.add(rim);
    this.model = createShipModel(ship, designs);
    this.model.getObjectByName('ring')!.visible = false;
    this.model.getObjectByName('flame')!.visible = false;
    this.pivot.add(this.model);
    this.scene.add(this.pivot);
    this.model.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    this.model.traverseVisible(
      /** Measure visible transformed hull geometry to frame the inspection camera accurately. */
      (o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.computeBoundingBox();
          bounds.union(o.geometry.boundingBox!.clone().applyMatrix4(o.matrixWorld));
        }
      }
    );
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    this.radius = sphere.radius;
    this.model.position.sub(sphere.center);
    this.camera.up.set(0, 0, 1);
    /**
     * Begin a drag rotation and capture the pointer so movement continues outside the preview
     * canvas.
     */
    canvas.onpointerdown = (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };
    /** Update inspection rotation from the active drag's pointer displacement. */
    canvas.onpointermove = (e) => {
      if (this.dragging) {
        this.angle += (e.clientX - this.lastX) * 0.013;
        this.lastX = e.clientX;
      }
    };
    /**
     * End preview dragging when the pointer is released or the browser cancels the
     * interaction.
     */
    canvas.onpointerup = canvas.onpointercancel = () => {
      this.dragging = false;
    };
    this.render(0);
  }
  /**
   * Resize and draw the inspection scene, applying its current orbit and idle presentation
   * motion.
   */
  render(dt: number) {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (w !== this.viewportWidth || h !== this.viewportHeight) {
      this.viewportWidth = w;
      this.viewportHeight = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      const vertical = THREE.MathUtils.degToRad(this.camera.fov),
        horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect),
        distance = (this.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.08;
      this.camera.position.copy(
        new THREE.Vector3(0.25, -1.2, 1.3).normalize().multiplyScalar(distance)
      );
      this.camera.lookAt(0, 0, 0);
    }
    if (!this.dragging) this.angle += dt * 0.12;
    this.pivot.rotation.z = this.angle;
    this.renderer.render(this.scene, this.camera);
  }

  /** Detach preview input handlers and release its model and renderer when the menu closes. */
  dispose() {
    this.canvas.onpointerdown =
      this.canvas.onpointermove =
      this.canvas.onpointerup =
      this.canvas.onpointercancel =
        null;
    disposeShipModel(this.model);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
