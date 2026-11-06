import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { createCatalog } from './content/universe';
import { catalogFromData } from './content/data';
import { systemEnvironment } from './content/environments';
import { expandUniverse, type SystemSpec } from './content/generation/generate';
import { readContent, writeContent } from '../tools/content-files';
import { runUniverse } from '../tools/universe';
import {
  backgroundSampler,
  buildEnvironment,
  prepareEnvironment,
  disposeEnvironment,
  type EnvironmentQuality
} from './ui/environment-model';
import { prepareScene, disposePreparedScene } from './ui/prepared-scene';
import { buildSystemModels, disposeSystemModels } from './ui/system-model';
import { View } from './view';
import { startFreeRoam } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
const quality: EnvironmentQuality = {
  maxStars: 18,
  maxDust: 8,
  maxAsteroids: 4,
  textureWidth: 32,
  textureHeight: 16
};
const presets = JSON.parse(readFileSync('content/presets.json', 'utf8'));
/** Generate one connected fixture without mutating the authored universe. */
function generated(overrides: Partial<SystemSpec> = {}) {
  return expandUniverse(
    readContent(resolve('content')),
    {
      schemaVersion: 1,
      systems: [
        {
          id: 'test-environment',
          name: 'Test environment',
          seed: 91,
          preset: 'frontier',
          chart: { x: 4, y: 3 },
          ...overrides
        }
      ],
      connections: [{ from: 'ashen', to: 'test-environment' }]
    },
    presets
  );
}
/** Copy authoring inputs and build their exact import index in an isolated temporary directory. */
function temporaryContent() {
  const temp = mkdtempSync(join(tmpdir(), 'blackwake-environments-')),
    root = join(temp, 'content');
  cpSync(resolve('content'), root, { recursive: true });
  mkdirSync(join(temp, 'src/content'), { recursive: true });
  writeContent(root, readContent(root));
  return { temp, root };
}
/** Read texture bytes from a generated sky without requiring a browser or GPU. */
function texture(environment: ReturnType<typeof buildEnvironment>) {
  const mesh = environment.sky.getObjectByName('environment-background') as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshBasicMaterial
  >;
  return mesh.material.map as THREE.DataTexture;
}

/** Verify the six initial looks are available in the live universe while existing dimensions and cultures stay intact. */
test('six environment profiles are assigned independently of culture and physical size', () => {
  const catalog = createCatalog();
  assert.equal(Object.keys(catalog.environmentProfiles).length, 6);
  assert.equal(
    new Set(
      Object.values(catalog.systems).map(
        /** Resolve each live appearance reference. */ (system) =>
          systemEnvironment(catalog, system).id
      )
    ).size,
    6
  );
  assert.equal(catalog.systems.ashen.radius, 8000);
  assert.equal(catalog.systems.vesper.cultureId, 'aster');
  assert.equal(catalog.systems.ashen.themeId, catalog.systems.vesper.themeId);
  assert.notEqual(
    systemEnvironment(catalog, catalog.systems.ashen).id,
    systemEnvironment(catalog, catalog.systems.vesper).id
  );
});

/** Verify old authored bundles still resolve to a bounded default without a save-schema change. */
test('legacy content without environment fields receives an independent default profile', () => {
  const source = readContent(resolve('content')),
    raw = structuredClone(source.definition) as any;
  delete raw.environmentProfiles;
  delete raw.defaultEnvironmentId;
  for (const system of source.systems) delete system.environmentId;
  const catalog = catalogFromData(raw, source.systems);
  assert.equal(systemEnvironment(catalog, catalog.systems.ashen).id, 'frontier-space');
  assert.equal(catalog.systems.ashen.radius, 8000);
});

/** Verify malformed visual inputs fail before allocation or generator writes. */
test('environment validation rejects unknown recipes, colors, unbounded densities and broken references', () => {
  const corruptions = [
    /** Reject an unknown per-system profile reference. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      c.systems.ashen.environmentId = 'missing';
    },
    /** Reject a shader/recipe name unsupported by the renderer. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      (c.environmentProfiles['frontier-space'] as any).rendererId = 'missing';
    },
    /** Reject invalid encoded color data before procedural texture generation. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      c.environmentProfiles['frontier-space'].background.tint = 'bad';
    },
    /** Bound authored density separately from the renderer's quality budget. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      c.environmentProfiles['frontier-space'].stars.density = 9000;
    },
    /** Prevent NaN values from reaching material intensities or allocation arithmetic. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      c.environmentProfiles['frontier-space'].lighting.keyIntensity = NaN;
    },
    /** Require the default reference to resolve even if every current system has an override. */ (
      c: ReturnType<typeof createCatalog>
    ) => {
      c.defaultEnvironmentId = 'missing';
    }
  ];
  for (const corrupt of corruptions) {
    const catalog = createCatalog();
    corrupt(catalog);
    assert.throws(
      /** Exercise the actual browser/tool shared validation boundary. */ () => catalog.validate()
    );
  }
});

/** Verify visual choices consume no market, station-layout, culture or traffic randomness. */
test('changing only the generated environment leaves gameplay content identical', () => {
  const a = generated({ environmentId: 'violet-veil' }),
    b = generated({ environmentId: 'amber-dust' });
  const sa = a.bundle.systems.at(-1)!,
    sb = b.bundle.systems.at(-1)!;
  assert.notEqual(sa.environmentId, sb.environmentId);
  assert.deepEqual({ ...sa, environmentId: null }, { ...sb, environmentId: null });
  assert.deepEqual(a.bundle.definition.markets, b.bundle.definition.markets);
});

/** Verify size authoring resolves to one explicit runtime radius independently of the selected appearance. */
test('size presets and numeric radii produce validated layouts without a second runtime size property', () => {
  const sized = generated({ environmentId: 'deep-void', size: 'large' }).bundle.systems.at(-1)!;
  assert.ok(sized.radius >= 20000 && sized.radius <= 30000);
  assert.equal('size' in sized, false);
  const explicit = generated({ environmentId: 'deep-void', radius: 2750 }).bundle.systems.at(-1)!;
  assert.equal(explicit.radius, 2750);
  assert.throws(
    /** Reject ambiguous physical size input before constructing any content. */ () =>
      generated({ size: 'small', radius: 1500 })
  );
});

/** Verify profile pools are deterministic and invalid members fail even when another member could be selected. */
test('preset appearance pools choose repeatably and validate their references', () => {
  assert.deepEqual(generated().bundle, generated().bundle);
  const bad = structuredClone(presets);
  bad.presets.frontier.environmentIds = ['frontier-space', 'missing'];
  assert.throws(
    /** Reject an invalid pool through real expansion before any source write. */ () =>
      expandUniverse(
        readContent(resolve('content')),
        {
          schemaVersion: 1,
          systems: [
            {
              id: 'bad-environment',
              name: 'Bad',
              seed: 1,
              preset: 'frontier',
              chart: { x: 4, y: 3 }
            }
          ],
          connections: []
        },
        bad
      )
  );
});

/** Verify the actual single-system CLI persists profile and radius choices and preserves hand edits on replay. */
test('creator script accepts explicit environment and size and never regenerates existing systems', () => {
  const { temp, root } = temporaryContent();
  try {
    const result = runUniverse('create', [
      '--root',
      root,
      '--id',
      'quiet-orbit',
      '--name',
      'Quiet Orbit',
      '--seed',
      '89',
      '--connect',
      'ashen',
      '--x',
      '4',
      '--y',
      '3',
      '--environment',
      'emerald-rift',
      '--size',
      'medium'
    ]) as any;
    assert.deepEqual(result.created, ['quiet-orbit']);
    const system = readContent(root).systems.at(-1)!;
    assert.equal(system.environmentId, 'emerald-rift');
    assert.ok(system.radius >= 10000 && system.radius <= 16000);
    assert.throws(
      /** Single-system creation may never overwrite the existing authored layout or appearance. */ () =>
        runUniverse('create', [
          '--root',
          root,
          '--id',
          'quiet-orbit',
          '--seed',
          '90',
          '--connect',
          'ashen',
          '--x',
          '4',
          '--y',
          '3',
          '--environment',
          'deep-void'
        ])
    );
    assert.equal(readContent(root).systems.at(-1)!.environmentId, 'emerald-rift');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/** Verify named batch generation can mix profiles reproducibly while using one explicit physical radius. */
test('batch creator accepts a seeded profile pool and a numeric radius', () => {
  const { temp, root } = temporaryContent();
  try {
    const options = [
      '--root',
      root,
      '--names',
      'First Veil,Second Veil,Third Veil,Fourth Veil',
      '--seed',
      '81',
      '--prefix',
      'look',
      '--anchor',
      'vesper',
      '--environments',
      'violet-veil,deep-void,amber-dust',
      '--radius',
      '2500'
    ];
    const before = readContent(root).systems.length;
    const preview = runUniverse('generate', [...options, '--dry-run']) as any;
    assert.equal(readContent(root).systems.length, before);
    assert.equal(preview.systems.length, 4);
    const actual = runUniverse('generate', options) as any;
    assert.deepEqual(preview.systems, actual.systems);
    const systems = readContent(root).systems.slice(-4);
    assert.ok(
      new Set(
        systems.map(
          /** Collect the actual resolved per-system appearance choices. */ (system) =>
            system.environmentId
        )
      ).size > 1
    );
    for (const system of systems) {
      assert.equal(system.radius, 2500);
      assert.equal(system.cultureId, 'aster');
      assert.ok(['violet-veil', 'deep-void', 'amber-dust'].includes(system.environmentId!));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/** Verify invalid CLI visual/size options fail before changing any authoring files. */
test('creator rejects bad profiles, conflicting size options and unused invalid pool entries atomically', () => {
  const { temp, root } = temporaryContent(),
    before = readContent(root);
  try {
    const base = [
      '--root',
      root,
      '--count',
      '2',
      '--prefix',
      'bad',
      '--seed',
      '31',
      '--anchor',
      'ashen'
    ];
    for (const extra of [
      ['--environment', 'missing'],
      ['--size', 'small', '--radius', '1500'],
      ['--environments', 'frontier-space,missing'],
      ['--size', 'enormous'],
      ['--radius', '1000000']
    ])
      assert.throws(
        /** Validate each malformed batch against the real CLI without partial writes. */ () =>
          runUniverse('generate', [...base, ...extra])
      );
    assert.deepEqual(readContent(root), before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/** Verify authors can discover all profile IDs and size bands without generating systems. */
test('environment listing exposes the authoring catalog and size bands', () => {
  const result = runUniverse('environments', []) as any;
  assert.equal(result.profiles.length, 6);
  assert.deepEqual(result.sizes.medium, [10000, 16000]);
});

/** Verify generated noise is deterministic, seam-safe and varied by each system's seed. */
test('background texture recipes repeat by seed and remain continuous across the sky seam', () => {
  const catalog = createCatalog(),
    profile = catalog.environmentProfiles['ion-blue'],
    a = backgroundSampler(profile, 71),
    b = backgroundSampler(profile, 71),
    c = backgroundSampler(profile, 72);
  const points = [
    [0, 0],
    [0.8, 0.4],
    [2, -0.6],
    [4, 1]
  ];
  assert.deepEqual(
    points.map(/** Sample the first repeatable background field. */ ([x, y]) => a(x, y)),
    points.map(/** Sample the same field without mutable RNG ordering. */ ([x, y]) => b(x, y))
  );
  assert.notDeepEqual(
    points.map(/** Sample one system's texture field. */ ([x, y]) => a(x, y)),
    points.map(
      /** Sample an independently seeded system with the same profile. */ ([x, y]) => c(x, y)
    )
  );
  for (const latitude of [-1.2, 0, 0.8]) assert.deepEqual(a(0, latitude), a(Math.PI * 2, latitude));
});

/** Verify real texture output changes across the six profiles and never mutates system content. */
test('all initial profiles produce distinct backgrounds behind bounded rendering resources', () => {
  const catalog = createCatalog(),
    system = catalog.systems.ashen,
    before = JSON.stringify(system),
    backgrounds = new Set<string>();
  for (const profile of Object.values(catalog.environmentProfiles)) {
    const environment = buildEnvironment(system, profile, quality);
    backgrounds.add(Buffer.from(texture(environment).image.data as Uint8Array).toString('base64'));
    const stars = environment.sky.getObjectByName('environment-stars') as THREE.Points;
    assert.ok(stars.geometry.getAttribute('position').count <= quality.maxStars);
    const rocks = environment.world.getObjectByName('environment-asteroids') as
      | THREE.InstancedMesh
      | undefined;
    if (rocks) assert.ok(rocks.count <= quality.maxAsteroids);
    disposeEnvironment(environment);
  }
  assert.equal(backgrounds.size, 6);
  assert.equal(JSON.stringify(system), before);
});

/** Verify rendering budgets do not scale particle counts quadratically with physical system size. */
test('large systems retain the same visual allocation caps as small systems', () => {
  const catalog = createCatalog(),
    system = catalog.systems.ashen,
    profile = catalog.environmentProfiles['amber-dust'];
  const small = buildEnvironment(system, profile, quality),
    large = buildEnvironment({ ...system, radius: 8000 }, profile, quality);
  const a = small.sky.getObjectByName('environment-stars') as THREE.Points,
    b = large.sky.getObjectByName('environment-stars') as THREE.Points;
  assert.deepEqual(
    a.geometry.getAttribute('position').array,
    b.geometry.getAttribute('position').array
  );
  assert.deepEqual(texture(small).image.data, texture(large).image.data);
  assert.equal(
    (small.world.getObjectByName('environment-dust') as THREE.Points).geometry.getAttribute(
      'position'
    ).count,
    (large.world.getObjectByName('environment-dust') as THREE.Points).geometry.getAttribute(
      'position'
    ).count
  );
  disposeEnvironment(small);
  disposeEnvironment(large);
});

/** Verify space profiles do not repaint authored station materials or change planet providers. */
test('environment changes leave infrastructure palette and object geometry ownership separate', () => {
  const catalog = createCatalog(),
    definition = catalog.systems.ashen,
    theme = catalog.themes[definition.themeId];
  const a = buildSystemModels({
      definition,
      theme,
      sizes: catalog.stationSizes,
      key: 'a',
      dockedAt: null,
      environment: catalog.environmentProfiles['violet-veil']
    }),
    b = buildSystemModels({
      definition,
      theme,
      sizes: catalog.stationSizes,
      key: 'b',
      dockedAt: null,
      environment: catalog.environmentProfiles['amber-dust']
    });
  const firstA = a.children[0].children[0] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >,
    firstB = b.children[0].children[0] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >;
  assert.equal(firstA.material.color.getHexString(), firstB.material.color.getHexString());
  assert.equal(a.children.length, b.children.length);
  disposeSystemModels(a);
  disposeSystemModels(b);
});

/** Verify both ordinary and instance-owned GPU resources are released by an environment unload. */
test('environment disposal releases textures, particle geometry and instance buffers', () => {
  const catalog = createCatalog(),
    environment = buildEnvironment(
      catalog.systems.ashen,
      catalog.environmentProfiles['amber-dust'],
      quality
    ),
    map = texture(environment);
  let textureDisposed = 0,
    instanceDisposed = 0;
  map.addEventListener(
    'dispose',
    /** Observe the background texture's explicit GPU lifetime. */ () => textureDisposed++
  );
  const rocks = environment.world.getObjectByName('environment-asteroids') as THREE.InstancedMesh;
  rocks.addEventListener(
    'dispose',
    /** Observe per-instance attribute cleanup beyond geometry disposal. */ () => instanceDisposed++
  );
  disposeEnvironment(environment);
  assert.equal(textureDisposed, 1);
  assert.equal(instanceDisposed, 1);
  assert.equal(environment.sky.children.length, 0);
  assert.equal(environment.world.children.length, 0);
});

/** Verify partial asynchronous work releases its already-built buffers after a loading failure. */
test('aborted environment preparation releases partial resource ownership', async () => {
  const catalog = createCatalog(),
    prototype = THREE.BufferGeometry.prototype,
    dispose = prototype.dispose;
  let disposed = 0;
  prototype.dispose =
    /** Observe cleanup of the star buffer built before the failing yield. */ function () {
      disposed++;
      return dispose.call(this);
    };
  try {
    await assert.rejects(
      /** Reject at the first batching boundary to exercise cleanup. */ () =>
        prepareEnvironment(
          catalog.systems.ashen,
          catalog.environmentProfiles['ion-blue'],
          /** Model cancellation at a browser-frame boundary. */ async () => {
            throw Error('cancelled');
          },
          quality
        )
    );
    assert.ok(disposed > 0);
  } finally {
    prototype.dispose = dispose;
  }
});

/** Verify shader preparation uses only destination lighting and keeps renderer resources ready for ownership transfer. */
test('destination warm-up includes its own background and lighting without departure lights', async () => {
  const catalog = createCatalog(),
    definition = catalog.systems.kepler,
    prepared = await prepareScene(
      {
        definition,
        theme: catalog.themes[definition.themeId],
        environment: systemEnvironment(catalog, definition),
        sizes: catalog.stationSizes,
        key: 'warm',
        dockedAt: null
      },
      [],
      catalog.shipDesigns,
      /** Yield immediately for a headless shader-input check. */ async () => {}
    );
  let lights = 0;
  const fake = {
    camera: new THREE.PerspectiveCamera(),
    renderer: {
      /** Inspect the actual scene supplied to Three.js compilation without a WebGL context. */ async compileAsync(
        scene: THREE.Scene
      ) {
        scene.traverse(
          /** Count destination light inputs recursively through the environment ownership root. */ (
            object
          ) => {
            if (object instanceof THREE.Light) lights++;
          }
        );
      }
    }
  } as unknown as View;
  await View.prototype.warmPreparedScene.call(fake, prepared);
  assert.equal(lights, 2);
  const key = prepared.environment.world.getObjectByName(
    'environment-key-light'
  ) as THREE.DirectionalLight;
  assert.equal(
    key.color.getHexString(),
    catalog.environmentProfiles['amber-dust'].lighting.keyColor.slice(1)
  );
  disposePreparedScene(prepared);
});

/** Verify appearance changes preserve existing voyage saves, actor identities and the physical system radius. */
test('voyage schema and NPC continuity survive environment profile changes', () => {
  const catalog = createCatalog(),
    game = startFreeRoam(catalog, createServices(), createActivities(), { trafficWarmup: false }),
    saved = game.save();
  catalog.systems.ashen.environmentId = 'deep-void';
  const restored = loadSession(saved, catalog, game.services, game.activities);
  assert.equal(restored.world.radius, game.world.radius);
  assert.equal(restored.world.player.id, game.world.player.id);
  assert.equal(restored.traffic.actors.length, game.traffic.actors.length);
  assert.equal(JSON.parse(restored.save()).version, 6);
  assert.equal(systemEnvironment(catalog, restored.definition).id, 'deep-void');
});
