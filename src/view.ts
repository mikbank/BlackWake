import {
  buildEnvironment,
  disposeEnvironment,
  type BuiltEnvironment
} from './ui/environment-model';
import { defaultEnvironmentProfile } from './content/environments';
import { animateHyperspaceGateways } from './ui/gateway-model';
import type { PreparedScene } from './ui/prepared-scene';
import type { ShipDesignDefinition } from './content/schema';
import { defaultShipDesigns } from './content/identity';
import * as THREE from 'three';
import { World, definitions, type Ship, type Vec3 } from './simulation';
import { createShipModel, disposeShipModel, shipAppearanceKey } from './ship-model';
import { buildSystemModels, disposeSystemModels, type SceneContent } from './ui/system-model';
import { FlightCamera, type CameraMode } from './flight-camera';
/**
 * Own the flight renderer, camera, cached hull models and transient effects; never own
 * gameplay state or advance physics.
 */
export class View {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  private cameraRig = new FlightCamera();
  private environment: BuiltEnvironment | undefined;
  private tacticalGrid: THREE.GridHelper;
  /** Read the active visual projection; simulation orientation and inputs remain unchanged. */
  get camera() {
    return this.cameraRig.camera;
  }
  /** Expose the selected camera for the player's view preference control. */
  get cameraMode() {
    return this.cameraRig.mode;
  }
  /** Change only the visual rig, leaving the session and course untouched. */
  setCameraMode(mode: CameraMode) {
    this.cameraRig.setMode(mode);
  }
  groups = new Map<string, THREE.Group>();
  shots = new THREE.Group();
  defenceRounds = new THREE.Group();
  effects = new THREE.Group();
  arcs = new THREE.Group();
  locations = new THREE.Group();
  private contentKey = '';
  width = 0;
  height = 0;
  shake = 0;
  destination: Vec3 | null = null;
  waypoint = new THREE.Group();
  route: THREE.Line;
  /**
   * Create the WebGL scene, lighting, star field and effect groups using the catalog's
   * design providers.
   */
  constructor(
    canvas: HTMLCanvasElement,
    private designs: Record<string, ShipDesignDefinition> = defaultShipDesigns
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor('#090f1b');
    const grid = new THREE.GridHelper(4000, 40, '#304354', '#1b2b3b');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -30;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.1;
    this.scene.add(grid);
    this.tacticalGrid = grid;
    this.scene.add(this.locations, this.shots, this.defenceRounds, this.effects, this.arcs);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(15, 17, 40),
      new THREE.MeshBasicMaterial({
        color: '#9ad8cb',
        transparent: true,
        opacity: 0.8,
        depthWrite: false
      })
    );
    this.waypoint.add(ring);
    for (const rotation of [0, Math.PI / 2]) {
      const cross = new THREE.Mesh(
        new THREE.PlaneGeometry(11, 1.5),
        new THREE.MeshBasicMaterial({ color: '#9ad8cb' })
      );
      cross.rotation.z = rotation;
      this.waypoint.add(cross);
    }
    const routeGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3()
    ]);
    this.route = new THREE.Line(
      routeGeometry,
      new THREE.LineDashedMaterial({
        color: '#9ad8cb',
        transparent: true,
        opacity: 0.35,
        dashSize: 8,
        gapSize: 7
      })
    );
    this.waypoint.visible = false;
    this.route.visible = false;
    this.scene.add(this.waypoint, this.route);
    for (const side of [-1, 1]) {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(100, 295, 40, 1, -0.69, 1.38),
        new THREE.MeshBasicMaterial({
          color: '#d2ad70',
          transparent: true,
          opacity: 0.035,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      arc.rotation.z = (side * Math.PI) / 2;
      arc.position.z = -3;
      this.arcs.add(arc);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(
        Array.from(
          { length: 41 },
          /** Sample points across the broadside arc for the flight overlay. */
          (_, i) =>
            new THREE.Vector3(
              Math.cos(-0.69 + (i / 40) * 1.38) * 295,
              Math.sin(-0.69 + (i / 40) * 1.38) * 295,
              0
            )
        )
      );
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color: '#d2ad70', transparent: true, opacity: 0.15 })
      );
      line.rotation.z = (side * Math.PI) / 2;
      line.position.z = -2;
      this.arcs.add(line);
    }
  }
  /** Construct and cache one hull model through the shared registered-design factory. */
  buildShip(s: Ship) {
    const group = createShipModel(s, this.designs);
    this.groups.set(s.id, group);
    this.scene.add(group);
    return group;
  }
  /**
   * Fit the renderer and both camera projections to the current viewport while preserving
   * world-to-screen consistency.
   */
  resize() {
    const w = innerWidth,
      h = innerHeight;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.cameraRig.resize(w, h);
  }
  /**
   * Convert a world-space XY position into browser client pixels for labels, radio and
   * pointer hit testing.
   */
  project(x: number, y: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const world = new THREE.Vector3(x, y, 0);
    const local = world.clone().applyMatrix4(this.camera.matrixWorldInverse);
    if (local.z >= 0)
      return {
        x: rect.left + rect.width / 2 + local.x * 2,
        y: rect.top + rect.height + 250,
        visible: false
      };
    const v = world.project(this.camera);
    return {
      x: rect.left + ((v.x + 1) * rect.width) / 2,
      y: rect.top + ((1 - v.y) * rect.height) / 2,
      visible: v.z >= -1 && v.z <= 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
    };
  }
  /** Project a world-space station footprint to a depth-aware touch target in the active camera. */
  screenRadius(position: Vec3, radius: number) {
    const camera = this.camera;
    if (camera instanceof THREE.PerspectiveCamera) {
      const local = new THREE.Vector3(position.x, position.y, position.z).applyMatrix4(
        camera.matrixWorldInverse
      );
      return local.z < 0
        ? Math.min(
            this.width * 0.4,
            (radius * this.height) /
              (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * -local.z)
          )
        : 0;
    }
    return ((radius * this.height) / (camera.top - camera.bottom)) * camera.zoom;
  }
  /**
   * Convert a browser client point back onto the flight plane, accounting for canvas offsets
   * and camera position. Sky taps have no intersection and return null instead of issuing a course.
   */
  worldPoint(clientX: number, clientY: number): Vec3 | null {
    this.resize();
    this.camera.updateMatrixWorld();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((clientY - rect.top) / rect.height) * 2
      ),
      this.camera
    );
    const hit = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Vector3()
    );
    return hit ? { x: hit.x, y: hit.y, z: 0 } : null;
  }
  /**
   * Keep exactly the live hull models needed by this world, rebuilding only when appearance
   * identity changes and disposing replaced resources.
   */
  syncShipModels(world: World) {
    for (const [id, g] of this.groups) {
      if (
        !world.ships.some(
          /**
           * Retain a cached model only when its hull still exists with the same design, class and
           * livery.
           */
          (s) => s.id === id && shipAppearanceKey(s) === g.userData.modelKey
        )
      ) {
        this.scene.remove(g);
        disposeShipModel(g);
        this.groups.delete(id);
      }
    }
    for (const ship of world.ships) if (!this.groups.has(ship.id)) this.buildShip(ship);
  }
  /** Replace one system's environment and release its complete texture/geometry/light ownership bundle. */
  private installEnvironment(environment: BuiltEnvironment) {
    if (this.environment) {
      this.scene.remove(this.environment.sky, this.environment.world);
      disposeEnvironment(this.environment);
    }
    this.environment = environment;
    this.scene.add(environment.sky, environment.world);
    this.renderer.setClearColor(environment.background);
  }
  /** Precompile destination materials while the hyperspace overlay owns presentation. */
  async warmPreparedScene(prepared: PreparedScene) {
    const warm = new THREE.Scene();
    warm.add(prepared.environment.sky, prepared.environment.world);
    warm.add(prepared.locations);
    for (const group of prepared.ships.values()) warm.add(group);
    await this.renderer.compileAsync(warm, this.camera);
  }
  /** Transfer prepared graphics into the active view and release departure GPU resources. */
  acceptPreparedScene(prepared: PreparedScene) {
    disposeSystemModels(this.locations);
    this.scene.remove(this.locations);
    for (const group of this.groups.values()) {
      this.scene.remove(group);
      disposeShipModel(group);
    }
    this.groups.clear();
    this.locations = prepared.locations;
    this.scene.add(this.locations);
    for (const [id, group] of prepared.ships) {
      this.groups.set(id, group);
      this.scene.add(group);
    }
    prepared.ships.clear();
    this.contentKey = prepared.content.key;
    this.installEnvironment(prepared.environment);
    this.cameraRig.reset();
  }
  /**
   * Synchronize scene content, camera, ships and transient effects, then draw the current
   * world without changing simulation rules.
   */
  render(world: World, dt: number, content: SceneContent) {
    this.resize();
    if (this.contentKey !== content.key) {
      this.contentKey = content.key;
      disposeSystemModels(this.locations);
      this.scene.remove(this.locations);
      this.locations = buildSystemModels(content);
      this.scene.add(this.locations);
      this.installEnvironment(
        buildEnvironment(content.definition, content.environment ?? defaultEnvironmentProfile)
      );
      this.cameraRig.reset();
    }
    animateHyperspaceGateways(this.locations, world.elapsed);
    this.syncShipModels(world);
    const p = world.player;
    this.cameraRig.setSystemRadius(world.radius);
    this.cameraRig.update(p, content.focus, dt);
    // The reference grid spans the expanded sector without changing the ship camera's zoom.
    this.tacticalGrid.scale.setScalar((world.radius * 2.5) / 4000);
    this.tacticalGrid.visible = this.cameraMode === 'tactical';
    this.environment?.sky.position.copy(this.camera.position);
    this.shake *= Math.max(0, 1 - dt * 8);
    this.camera.position.x += (Math.random() - 0.5) * this.shake;
    this.camera.position.y += (Math.random() - 0.5) * this.shake;
    this.camera.updateMatrixWorld();
    for (const s of world.ships) {
      const g = this.groups.get(s.id) || this.buildShip(s);
      g.position.set(s.position.x, s.position.y, 0);
      g.rotation.z = s.heading;
      g.visible = s.hull > 0 && !(s.id === world.controlledShipId && content.dockedAt);
      const flame = g.getObjectByName('flame')!;
      flame.visible = s.engines > 0 && Math.hypot(s.velocity.x, s.velocity.y) > 5;
      flame.scale.x = 0.45 + Math.hypot(s.velocity.x, s.velocity.y) / 90 + Math.random() * 0.12;
      const material = (g.getObjectByName('ring') as THREE.Mesh)
        .material as THREE.MeshBasicMaterial;
      material.color.set(
        s.id === world.controlledShipId
          ? '#80c5bc'
          : world.relations.isHostile(p, s)
            ? '#d5ac6b'
            : '#667c8b'
      );
    }
    this.arcs.position.set(p.position.x, p.position.y, 0);
    this.arcs.rotation.z = p.heading;
    this.arcs.visible = !!content.combatTargetId;
    while (this.shots.children.length < world.shots.length) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 15, 4),
        new THREE.MeshBasicMaterial({ color: '#f4dba7' })
      );
      this.shots.add(mesh);
    }
    this.shots.children.forEach(
      /** Place or hide pooled broadside-shell meshes according to current projectile state. */
      (mesh, i) => {
        const shot = world.shots[i];
        mesh.visible = !!shot;
        if (shot) {
          mesh.position.set(shot.position.x, shot.position.y, 8);
          mesh.rotation.z = Math.atan2(shot.velocity.y, shot.velocity.x) - Math.PI / 2;
        }
      }
    );
    while (this.defenceRounds.children.length < world.defenceRounds.length) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 20, 4),
        new THREE.MeshBasicMaterial({ color: '#a8eeff' })
      );
      this.defenceRounds.add(mesh);
    }
    this.defenceRounds.children.forEach(
      /** Place or hide pooled PDC-round meshes according to current defence-projectile state. */
      (object, i) => {
        const round = world.defenceRounds[i];
        object.visible = !!round;
        if (round) {
          const mesh = object as THREE.Mesh;
          mesh.position.set(round.position.x, round.position.y, 16);
          mesh.rotation.z = Math.atan2(round.velocity.y, round.velocity.x) - Math.PI / 2;
          (mesh.material as THREE.MeshBasicMaterial).color.set(
            world.ships.find(
              /** Resolve a defence round's firing ship for its presentation. */
              (s) => s.id === round.owner
            )?.owner === 'player'
              ? '#a8eeff'
              : '#ffad6b'
          );
        }
      }
    );
    for (const event of world.events) {
      if (event.type === 'pdc-fire' && event.origin) {
        const ship = world.ships.find(
            /** Resolve the ship named by a combat effect so animated weapons align with its model. */
            (s) => s.id === event.shipId
          ),
          group = ship ? this.groups.get(ship.id) : undefined,
          mount = group?.getObjectByName(`pdc-${event.mount}`);
        if (mount && ship) {
          mount.rotation.z =
            Math.atan2(event.position.y - event.origin.y, event.position.x - event.origin.x) -
            ship.heading;
        }
        const flash = new THREE.Mesh(
          new THREE.CircleGeometry(3.5, 8),
          new THREE.MeshBasicMaterial({
            color: event.player ? '#d4f7ff' : '#ffe5b8',
            transparent: true
          })
        );
        flash.position.set(event.origin.x, event.origin.y, 18);
        flash.userData = { life: 0.07, maxLife: 0.07, vx: 0, vy: 0 };
        this.effects.add(flash);
      }
      if (event.type === 'hit' || event.type === 'intercept') {
        if (event.type === 'hit' && event.player) this.shake = 7;
        for (let i = 0; i < (event.type === 'intercept' ? 12 : 8); i++) {
          const spark = new THREE.Mesh(
            new THREE.CircleGeometry(1.5 + Math.random() * 2, 5),
            new THREE.MeshBasicMaterial({
              color:
                event.type === 'intercept'
                  ? i % 2
                    ? event.player
                      ? '#a8eeff'
                      : '#ffad6b'
                    : '#fff4cc'
                  : i % 2
                    ? '#e1a167'
                    : '#f3dfb6',
              transparent: true
            })
          );
          spark.position.set(event.position.x, event.position.y, 14);
          spark.userData = {
            life: 0.4,
            maxLife: 0.4,
            vx: (Math.random() - 0.5) * 130,
            vy: (Math.random() - 0.5) * 130
          };
          this.effects.add(spark);
        }
      }
    }
    for (const effect of [...this.effects.children]) {
      effect.userData.life -= dt;
      effect.position.x += effect.userData.vx * dt;
      effect.position.y += effect.userData.vy * dt;
      effect.quaternion.copy(this.camera.quaternion);
      const renderable = effect as THREE.Mesh;
      const material = renderable.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, effect.userData.life / effect.userData.maxLife);
      if (effect.userData.life <= 0) {
        this.effects.remove(effect);
        renderable.geometry.dispose();
        material.dispose();
      }
    }
    this.waypoint.visible = !!this.destination;
    this.route.visible = !!this.destination;
    if (this.destination) {
      this.waypoint.position.set(this.destination.x, this.destination.y, 14);
      this.waypoint.scale.setScalar(1 + Math.sin(world.elapsed * 4) * 0.08);
      const positions = this.route.geometry.getAttribute('position') as THREE.BufferAttribute;
      positions.setXYZ(0, p.position.x, p.position.y, 12);
      positions.setXYZ(1, this.destination.x, this.destination.y, 12);
      positions.needsUpdate = true;
      this.route.computeLineDistances();
      this.route.geometry.computeBoundingSphere();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
