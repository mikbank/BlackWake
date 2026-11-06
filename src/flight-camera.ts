import * as THREE from 'three';
import type { Ship, Vec3 } from './core/model';
export type CameraMode = 'chase' | 'tactical';
/** Presentation-only camera state: flight still uses the existing XY plane and heading controls. */
export class FlightCamera {
  readonly chase = new THREE.PerspectiveCamera(56, 1, 0.5, 22000);
  readonly tactical = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 22000);
  mode: CameraMode = 'chase';
  private initialized = false;
  private yaw = 0;
  private aim = new THREE.Vector3();
  /** Use the simulation's Z-up convention for the chase view, retaining north-up tactical projection. */
  constructor() {
    this.chase.up.set(0, 0, 1);
    this.tactical.position.z = 1500;
  }
  /** Read the active projection without exposing a second gameplay coordinate system. */
  get camera() {
    return this.mode === 'chase' ? this.chase : this.tactical;
  }
  /** Switch presentation modes and snap the new rig on its next update to avoid orbiting from an unrelated pose. */
  setMode(mode: CameraMode) {
    this.mode = mode;
    this.reset();
  }
  /** Mark a system transition so the camera follows the arriving ship rather than traversing between old coordinates. */
  reset() {
    this.initialized = false;
  }
  /** Configure both projections for the viewport so changing modes needs no window resize. */
  resize(width: number, height: number) {
    const aspect = width / Math.max(1, height),
      worldHeight = width < 700 ? 1000 : 950;
    this.chase.aspect = aspect;
    this.chase.updateProjectionMatrix();
    this.tactical.left = (-worldHeight * aspect) / 2;
    this.tactical.right = -this.tactical.left;
    this.tactical.top = worldHeight / 2;
    this.tactical.bottom = -worldHeight / 2;
    this.tactical.updateProjectionMatrix();
  }
  /** Keep distant gateways projectable in enlarged systems without changing ship framing or camera zoom. */
  setSystemRadius(radius: number) {
    const far = Math.max(22000, radius * 2 + 3000);
    for (const camera of [this.chase, this.tactical])
      if (camera.far !== far) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
  }
  /** Follow a ship smoothly from above and behind; focus biases the look point but cannot pull the camera far away. */
  update(
    ship: Pick<Ship, 'position' | 'velocity' | 'heading'>,
    focus: Vec3 | undefined,
    dt: number
  ) {
    const p = ship.position,
      target = focus ?? p,
      dx = target.x - p.x,
      dy = target.y - p.y;
    const focusScale = Math.min(1, 220 / Math.max(1, Math.hypot(dx, dy)));
    const alpha = 1 - Math.exp(-Math.max(0, dt) * 4);
    if (!this.initialized) this.yaw = ship.heading;
    else
      this.yaw +=
        Math.atan2(Math.sin(ship.heading - this.yaw), Math.cos(ship.heading - this.yaw)) *
        (1 - Math.exp(-Math.max(0, dt) * 2.8));
    if (this.mode === 'tactical') {
      const desired = new THREE.Vector3(
        p.x + dx * 0.22 * focusScale,
        p.y + dy * 0.22 * focusScale - 20,
        1500
      );
      if (!this.initialized) this.tactical.position.copy(desired);
      else this.tactical.position.lerp(desired, alpha);
      this.tactical.lookAt(this.tactical.position.x, this.tactical.position.y, 0);
    } else {
      const speed = Math.hypot(ship.velocity.x, ship.velocity.y),
        forward = new THREE.Vector3(Math.cos(this.yaw), Math.sin(this.yaw), 0);
      const behind = 360 + Math.min(130, speed * 0.22),
        height = 240 + Math.min(80, speed * 0.12),
        ahead = 160 + Math.min(130, speed * 0.26);
      const desired = new THREE.Vector3(p.x, p.y, 0).addScaledVector(forward, -behind);
      desired.z = height;
      const look = new THREE.Vector3(
        p.x + dx * 0.25 * focusScale,
        p.y + dy * 0.25 * focusScale,
        0
      ).addScaledVector(forward, ahead);
      if (!this.initialized) {
        this.chase.position.copy(desired);
        this.aim.copy(look);
      } else {
        this.chase.position.lerp(desired, alpha);
        this.aim.lerp(look, alpha);
      }
      this.chase.lookAt(this.aim);
    }
    this.initialized = true;
    this.camera.updateMatrixWorld(true);
  }
}
