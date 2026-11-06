import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { JumpGate, ThemeDefinition } from '../content/schema';

/** Build an industrial hyperspace gateway with its open flight axis pointing out from the system centre. */
export function createHyperspaceGateway(gate: JumpGate, theme: ThemeDefinition) {
  const root = new THREE.Group(),
    body = new THREE.Group();
  root.name = gate.id;
  root.userData.kind = 'hyperspace-gateway';
  root.position.set(gate.position.x, gate.position.y, 0);
  body.rotation.z = Math.atan2(gate.position.y, gate.position.x);
  root.add(body);
  const materials = {
    armor: new THREE.MeshStandardMaterial({ color: '#52606d', metalness: 0.72, roughness: 0.55 }),
    pale: new THREE.MeshStandardMaterial({
      color: theme.stationColor,
      metalness: 0.5,
      roughness: 0.68
    }),
    dark: new THREE.MeshStandardMaterial({ color: '#172531', metalness: 0.65, roughness: 0.62 }),
    caution: new THREE.MeshStandardMaterial({ color: '#b7985c', metalness: 0.4, roughness: 0.6 }),
    light: new THREE.MeshBasicMaterial({ color: '#8de2ee', toneMapped: false })
  };
  type Finish = keyof typeof materials;
  const bins = new Map<Finish, THREE.BufferGeometry[]>();
  /** Transform a disposable construction part into gateway-local coordinates and batch it by material. */
  function part(
    geometry: THREE.BufferGeometry,
    finish: Finish,
    x: number,
    y: number,
    z: number,
    rotation = new THREE.Euler()
  ) {
    geometry.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(rotation),
        new THREE.Vector3(1, 1, 1)
      )
    );
    const bin = bins.get(finish) ?? [];
    bin.push(geometry);
    bins.set(finish, bin);
  }
  /** Place rectangular industrial hardware with its local Y axis pointing radially around the aperture. */
  function box(
    finish: Finish,
    size: [number, number, number],
    x: number,
    radius: number,
    angle: number
  ) {
    part(
      new THREE.BoxGeometry(...size),
      finish,
      x,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      new THREE.Euler(angle, 0, 0)
    );
  }
  for (const x of [-23, 23]) {
    part(
      new THREE.TorusGeometry(92, 6, 4, 12),
      'armor',
      x,
      0,
      0,
      new THREE.Euler(0, Math.PI / 2, 0)
    );
    part(
      new THREE.TorusGeometry(73, 1.6, 6, 64),
      'light',
      x,
      0,
      0,
      new THREE.Euler(0, Math.PI / 2, 0)
    );
    part(
      new THREE.TorusGeometry(80, 3, 4, 12),
      'dark',
      x,
      0,
      0,
      new THREE.Euler(0, Math.PI / 2, 0)
    );
  }
  for (let i = 0; i < 12; i++) {
    const angle = (i * Math.PI) / 6;
    box('armor', [46, 5, 6], 0, 92, angle);
    for (const x of [-23, 23]) box('pale', [9, 20, 7], x, 83, angle);
  }
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + Math.PI / 6;
    box('dark', [68, 21, 31], 0, 98, angle);
    box('pale', [54, 14, 35], 0, 108, angle);
    for (const x of [-28, 28]) {
      box('armor', [10, 25, 39], x, 101, angle);
      box('caution', [3, 3, 33], x + (x > 0 ? 5 : -5), 115, angle);
      box('light', [2, 9, 20], x + (x > 0 ? 5.5 : -5.5), 98, angle);
    }
    for (const x of [-14, 0, 14]) box('armor', [4, 5, 37], x, 117, angle);
    box('light', [30, 1.8, 2], 0, 120, angle);
  }
  // Static hardware uses one draw call per finish rather than one per construction part.
  for (const [finish, geometries] of bins) {
    const geometry = mergeGeometries(geometries)!;
    for (const source of geometries) source.dispose();
    const mesh = new THREE.Mesh(geometry, materials[finish]);
    mesh.name = `gateway-${finish}`;
    body.add(mesh);
  }
  const aperture = new THREE.Mesh(
    new THREE.CircleGeometry(70, 64),
    new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color('#71cddd') } },
      vertexShader:
        'varying vec2 apertureUv; void main(){apertureUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec2 apertureUv; uniform float time; uniform vec3 color;
      void main(){vec2 p=(apertureUv-.5)*2.;float r=length(p);float angle=atan(p.y,p.x);
      float ripple=.5+.5*sin(r*38.-time*2.8+sin(angle*5.+time)*.7);
      float edge=smoothstep(.4,1.,r);float alpha=(.025+ripple*.06+edge*.13)*(1.-smoothstep(.96,1.,r));
      gl_FragColor=vec4(color*(.7+ripple*.5),alpha);}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false
    })
  );
  aperture.rotation.y = Math.PI / 2;
  aperture.name = 'gateway-aperture';
  body.add(aperture);
  const envelope = new THREE.Mesh(
    new THREE.RingGeometry(gate.radius, gate.radius + 1, 64),
    new THREE.MeshBasicMaterial({
      color: '#79bcd4',
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false
    })
  );
  envelope.position.z = -8;
  envelope.name = 'gateway-approach-envelope';
  root.add(envelope);
  return root;
}

/** Animate gateway energy locally without introducing a simulation entity, light source or gameplay effect. */
export function animateHyperspaceGateways(root: THREE.Object3D, seconds: number) {
  for (const child of root.children) {
    if (child.userData.kind !== 'hyperspace-gateway') continue;
    const aperture = child.getObjectByName('gateway-aperture') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    if (aperture) aperture.material.uniforms.time.value = seconds;
  }
}
