import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCatalog, position } from './content/universe';
import { CatalogSystemProvider, type SystemProvider } from './content/system-provider';
import { startFreeRoam } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { JumpTransition } from './game/jump-transition';
import {
  jumpTravelSeconds,
  hyperspaceHoldFraction,
  hyperspaceExitFraction
} from './game/jump-travel';
import { prepareScene, disposePreparedScene } from './ui/prepared-scene';
import { prepareSystemModels, disposeSystemModels, type SceneContent } from './ui/system-model';

/** Create a real session at an eligible exit without waiting through approach flight. */
function departure() {
  const catalog = createCatalog(),
    session = startFreeRoam(catalog, createServices(), createActivities(), {
      trafficWarmup: false
    });
  session.dispatch({ type: 'undock' });
  const gate = session.definition.gates[0],
    connectionId = gate.connections[0].id;
  session.world.player.position = { ...gate.position };
  session.world.player.velocity = position(0, 0);
  return { session, connectionId, destination: gate.connections[0].systemId };
}
/** Flush async continuations in coordinator tests without advancing wall time or simulation time. */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
/** Expose a controlled provider completion so loading latency can be varied independently of travel time. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(
    /** Capture a test-controlled completion without timers. */ (done) => {
      resolve = done;
    }
  );
  return { promise, resolve };
}
/** Instrument prepared-resource ownership without constructing a browser or graphics context. */
function controller(
  session: ReturnType<typeof departure>['session'],
  provider: SystemProvider = new CatalogSystemProvider(session.catalog)
) {
  const accepted: string[] = [],
    disposed: string[] = [];
  const transition = new JumpTransition(provider, {
    /** Represent successfully prepared destination graphics by a stable resource identifier. */
    async prepare(definition) {
      return definition.id;
    },
    /** Track the single ownership transfer on arrival. */
    accept(resource) {
      accepted.push(resource);
    },
    /** Track disposal after cancellation, rejection or stale completion. */
    dispose(resource) {
      disposed.push(resource);
    }
  });
  return { transition, accepted, disposed };
}

/** Verify jump commands reserve departure and freeze local physics until an explicit arrival commit. */
test('jump request has a real transit state and blocks local gameplay commands', () => {
  const { session: g, connectionId } = departure(),
    world = g.world,
    clock = g.clock,
    point = { ...g.world.player.position };
  assert.ok(g.dispatch({ type: 'jump', connectionId }).ok);
  assert.equal(g.systemId, 'ashen');
  assert.equal(g.transit?.duration, jumpTravelSeconds);
  assert.equal(g.completeJump().ok, false);
  assert.equal(g.dispatch({ type: 'jump', connectionId }).ok, false);
  assert.equal(g.dispatch({ type: 'select', target: { kind: 'station', id: 'haven' } }).ok, false);
  g.step(1, { turn: 1, thrust: 1, brake: false, fire: true });
  assert.deepEqual(g.world.player.position, point);
  assert.equal(g.world, world);
  assert.equal(g.clock, clock);
  assert.equal(g.transit?.elapsed, 1);
});

/** Verify successful arrival consumes one fixed simulated interval and releases the old spatial store. */
test('arrival releases departure ECS and advances the voyage exactly once', async () => {
  const { session: g, connectionId, destination } = departure(),
    old = g.world;
  const { transition, accepted } = controller(g);
  assert.ok(transition.begin(g, connectionId).ok);
  await settle();
  assert.equal(transition.state, 'ready');
  assert.equal(g.systemId, 'ashen');
  assert.equal(transition.update(3.9), undefined);
  assert.ok(transition.update(0.2)?.ok);
  assert.equal(g.systemId, destination);
  assert.equal(g.clock, jumpTravelSeconds);
  assert.equal(old.entities.size, 0);
  assert.deepEqual(accepted, [destination]);
  assert.equal(transition.update(100), undefined);
  assert.equal(g.clock, jumpTravelSeconds);
});

/** Verify save/export during preparation always encodes a recoverable departure, with no transient schema changes. */
test('transit saves reopen the departure checkpoint and cancellation consumes no game time', () => {
  const { session: g, connectionId } = departure(),
    before = g.save(),
    old = g.world;
  assert.ok(g.dispatch({ type: 'jump', connectionId }).ok);
  g.advanceTransit(40);
  assert.equal(g.save(), before);
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(restored.systemId, 'ashen');
  assert.equal(restored.clock, 0);
  assert.equal(restored.transit, null);
  g.cancelTransit();
  assert.equal(g.save(), before);
  assert.equal(g.world, old);
  assert.ok(old.entities.size > 0);
});

/** Verify a stalled provider cannot consume game time or advance NPCs while its animation continues. */
test('slow loading and fast loading produce identical persistent arrival states', async () => {
  const fast = departure(),
    slow = departure();
  const ready = controller(fast.session),
    gate = deferred<ReturnType<typeof createCatalog>['systems'][string]>();
  const delayed = controller(slow.session, {
    /** Hold destination content until the test explicitly finishes the load. */
    load() {
      return gate.promise;
    }
  });
  ready.transition.begin(fast.session, fast.connectionId);
  delayed.transition.begin(slow.session, slow.connectionId);
  await settle();
  ready.transition.update(4);
  delayed.transition.update(40);
  assert.equal(slow.session.clock, 0);
  assert.equal(slow.session.systemId, 'ashen');
  gate.resolve(slow.session.catalog.systems[slow.destination]);
  await settle();
  assert.equal(
    slow.session.transit!.elapsed / slow.session.transit!.duration,
    hyperspaceHoldFraction
  );
  assert.ok(hyperspaceHoldFraction < hyperspaceExitFraction);
  delayed.transition.update(0);
  assert.equal(slow.session.systemId, 'ashen');
  delayed.transition.update(4);
  assert.equal(slow.session.save(), fast.session.save());
});

/** Verify provider failures preserve departure and retries do not restart or double-charge the journey. */
test('failed preparation can retry and arrive without losing departure ownership', async () => {
  const { session: g, connectionId, destination } = departure();
  let attempts = 0;
  const { transition, accepted } = controller(g, {
    /** Fail once to exercise recovery through the real asynchronous content boundary. */
    async load(id) {
      if (++attempts === 1) throw Error('offline');
      return g.catalog.systems[id];
    }
  });
  const old = g.world,
    before = g.save();
  transition.begin(g, connectionId);
  await settle();
  assert.equal(transition.state, 'failed');
  assert.equal(g.save(), before);
  assert.equal(g.world, old);
  transition.retry();
  await settle();
  assert.equal(transition.state, 'ready');
  transition.update(4);
  assert.equal(g.systemId, destination);
  assert.equal(g.clock, 4);
  assert.deepEqual(accepted, [destination]);
});

/** Verify scene failures are recoverable just like failed content downloads. */
test('graphics preparation failure cannot change NPC schedules or discard departure', async () => {
  const { session: g, connectionId } = departure();
  const before = g.save();
  const transition = new JumpTransition(new CatalogSystemProvider(g.catalog), {
    /** Model an unavailable ship asset before any domain arrival is committed. */
    async prepare() {
      throw Error('asset unavailable');
    },
    /** A failed preparation must never transfer renderer ownership. */
    accept() {
      assert.fail('Unexpected accept');
    },
    /** No resource exists when preparation rejects before returning one. */
    dispose() {}
  });
  transition.begin(g, connectionId);
  await settle();
  assert.equal(transition.state, 'failed');
  transition.cancel();
  assert.equal(g.save(), before);
});

/** Verify cancellation cleans prepared resources and prevents a second commit. */
test('cancel disposes a ready scene exactly once and retains the departure world', async () => {
  const { session: g, connectionId, destination } = departure();
  const { transition, disposed } = controller(g);
  transition.begin(g, connectionId);
  await settle();
  transition.cancel();
  transition.cancel();
  assert.deepEqual(disposed, [destination]);
  assert.equal(g.systemId, 'ashen');
  assert.equal(g.clock, 0);
  assert.equal(transition.update(4), undefined);
});

/** Verify late asynchronous graphics completions cannot replace a cancelled journey or leak their resource. */
test('late scene completions after abort are disposed instead of installed', async () => {
  const { session: g, connectionId } = departure(),
    pending = deferred<string>();
  let disposed = 0,
    accepted = 0;
  const transition = new JumpTransition(new CatalogSystemProvider(g.catalog), {
    /** Keep graphics outstanding beyond cancellation. */
    prepare() {
      return pending.promise;
    },
    /** Count any unexpected stale ownership transfer. */
    accept() {
      accepted++;
    },
    /** Release the stale scene when its ignored promise eventually completes. */
    dispose() {
      disposed++;
    }
  });
  transition.begin(g, connectionId);
  await settle();
  transition.cancel();
  pending.resolve('late');
  await settle();
  assert.equal(accepted, 0);
  assert.equal(disposed, 1);
  assert.equal(g.systemId, 'ashen');
});

/** Verify misrouted provider results are rejected before constructing any scene. */
test('wrong destination definitions fail without changing the reserved departure', async () => {
  const { session: g, connectionId } = departure();
  const { transition } = controller(g, {
    /** Deliberately violate the provider's requested-system contract. */
    async load() {
      return g.catalog.systems.ashen;
    }
  });
  transition.begin(g, connectionId);
  await settle();
  assert.equal(transition.state, 'failed');
  assert.equal(g.clock, 0);
});

/** Verify a changed access policy is rechecked when arrival is committed, without losing prepared resources. */
test('a route closed during loading retains departure and releases the unused scene', async () => {
  const { session: g, connectionId, destination } = departure(),
    old = g.world;
  const { transition, disposed } = controller(g);
  transition.begin(g, connectionId);
  await settle();
  g.routes.policy =
    /** Close this route after preparation to test commit-time validation. */ () => ({
      allowed: false,
      reason: 'Closed'
    });
  assert.equal(transition.update(4)?.ok, false);
  assert.equal(transition.state, 'failed');
  assert.equal(g.world, old);
  assert.ok(old.entities.size > 0);
  assert.equal(g.clock, 0);
  assert.deepEqual(disposed, [destination]);
  transition.cancel();
  assert.equal(g.transit, null);
});

/** Verify NPC arrival uses the same duration as player travel and keeps foreign identity, cargo and damage. */
test('following an incoming NPC preserves its journey and materializes its current arrival position', async () => {
  const { session: g, connectionId, destination } = departure(),
    actor = g.traffic.get('ashen-trader')!;
  const hop = g.routes.connection(g.systemId, connectionId)!;
  const action = {
    kind: 'travel' as const,
    destination: {
      kind: 'station' as const,
      systemId: destination,
      stationId: g.catalog.systems[destination].stations[0].id
    },
    activity: 'Delivering cargo'
  };
  actor.motion = {
    kind: 'transit',
    systemId: null,
    fromSystemId: g.systemId,
    arrivalSystemId: destination,
    arrivalGateId: hop.arrivalGateId,
    until: 1,
    action
  };
  actor.ship.hull = 63;
  actor.ship.cargo = { rations: 7 };
  const culture = actor.cultureId,
    design = actor.ship.designId,
    record = actor.ship;
  g.followedActorId = actor.ship.id;
  const { transition } = controller(g);
  transition.begin(g, connectionId);
  await settle();
  transition.update(4);
  assert.equal(actor.ship, record);
  assert.equal(actor.cultureId, culture);
  assert.equal(actor.ship.designId, design);
  assert.equal(actor.ship.hull, 63);
  assert.deepEqual(actor.ship.cargo, { rations: 7 });
  assert.equal(g.followedActorId, actor.ship.id);
  assert.equal(actor.motion.kind, 'flight');
  assert.equal(
    g.world.ships.filter(
      /** Count exactly one physical copy of this actor. */ (ship) => ship.id === actor.ship.id
    ).length,
    1
  );
  const gate = g.definition.gates.find(
    /** Locate the actor's actual arrival anchor. */ (gate) => gate.id === hop.arrivalGateId
  )!;
  assert.ok(
    Math.hypot(actor.ship.position.x - gate.position.x, actor.ship.position.y - gate.position.y) > 0
  );
  assert.equal(g.radio.active.length, 0);
});

/** Verify both traffic and player transitions read the shared transit duration policy. */
test('NPC charge completion enters the same four-second transit budget as the player', () => {
  const { session: g, connectionId } = departure(),
    actor = g.traffic.get('ashen-trader')!;
  const hop = g.routes.connection(g.systemId, connectionId)!;
  actor.motion = {
    kind: 'charging',
    systemId: g.systemId,
    gateId: hop.gateId,
    connectionId,
    until: 0,
    action: {
      kind: 'travel',
      destination: {
        kind: 'station',
        systemId: hop.toSystemId,
        stationId: g.catalog.systems[hop.toSystemId].stations[0].id
      },
      activity: 'Freight'
    }
  };
  g.traffic.navigation.advance(actor, 10, false);
  assert.equal(actor.motion.kind, 'transit');
  if (actor.motion.kind === 'transit') assert.equal(actor.motion.until, 10 + jumpTravelSeconds);
});

/** Verify the first provider is asynchronous and rejects unknown content rather than inventing a destination. */
test('catalog provider uses validated local content behind an asynchronous contract', async () => {
  const catalog = createCatalog(),
    provider = new CatalogSystemProvider(catalog);
  assert.equal(await provider.load('ashen'), catalog.systems.ashen);
  await assert.rejects(
    /** Missing content must become a recoverable loading rejection. */ () =>
      provider.load('missing')
  );
});

/** Assemble consistent scene inputs for browser-free incremental graphics checks. */
function content(): SceneContent {
  const catalog = createCatalog(),
    definition = catalog.systems.ashen;
  return {
    definition,
    theme: catalog.themes[definition.themeId],
    sizes: catalog.stationSizes,
    key: 'test',
    dockedAt: null
  };
}
/** Verify destination objects are batched across browser yields and all completed resources are owned by the result. */
test('destination geometry preparation yields between complete scene objects', async () => {
  const c = content();
  let yields = 0;
  const root = await prepareSystemModels(
    c,
    /** Represent an animation-frame yield without a DOM. */ async () => {
      yields++;
    }
  );
  assert.equal(
    yields,
    c.definition.stations.length + c.definition.landmarks.length + c.definition.gates.length
  );
  assert.equal(root.children.length, yields);
  disposeSystemModels(root);
});

/** Verify failed batches dispose resources already produced by registered visual providers. */
test('a failed preparation yield releases partially built station geometry', async () => {
  const c = content();
  let geometryDisposals = 0;
  const prototype = THREE.BufferGeometry.prototype,
    dispose = prototype.dispose;
  prototype.dispose =
    /** Observe disposal during the injected yield failure, preserving Three.js behavior. */ function () {
      geometryDisposals++;
      return dispose.call(this);
    };
  try {
    await assert.rejects(
      /** Reject after the first completed station so its allocations must be released. */ () =>
        prepareSystemModels(
          c,
          /** Simulate interrupted asynchronous preparation. */ async () => {
            throw Error('aborted');
          }
        )
    );
    assert.ok(geometryDisposals > 0);
  } finally {
    prototype.dispose = dispose;
  }
});

/** Verify hull preparation selects an actor's own design and creates a disposable resource without WebGL. */
test('prepared destination includes visiting foreign hull models independently of system culture', async () => {
  const c = content(),
    catalog = createCatalog();
  const { session: g } = departure();
  const visitor = g.traffic.actors.find(
    /** Find the visiting culture whose design must survive preparation. */ (actor) =>
      actor.cultureId !== c.definition.cultureId
  )!;
  const prepared = await prepareScene(
    c,
    [visitor.ship],
    catalog.shipDesigns,
    /** Yield immediately for headless preparation checks. */ async () => {}
  );
  const group = prepared.ships.get(visitor.ship.id)!;
  assert.equal(group.userData.designId, visitor.ship.designId);
  disposePreparedScene(prepared);
  assert.equal(prepared.ships.size, 0);
});

/** Verify abort signals reach an in-flight provider before another attempt starts. */
test('cancellation aborts provider work and a new journey receives a fresh signal', async () => {
  const { session: g, connectionId } = departure();
  const signals: AbortSignal[] = [];
  const { transition } = controller(g, {
    /** Retain each signal while deliberately leaving its request pending. */
    load(_id, signal) {
      signals.push(signal!);
      return new Promise(
        /** Keep content pending until the controller aborts it. */ (_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            /** Reject pending work as a real fetch would. */ () => reject(new Error('aborted')),
            { once: true }
          )
      );
    }
  });
  transition.begin(g, connectionId);
  await settle();
  transition.cancel();
  assert.equal(signals[0].aborted, true);
  transition.begin(g, connectionId);
  await settle();
  assert.equal(signals[1].aborted, false);
  assert.equal(transition.state, 'loading');
  transition.cancel();
  await settle();
});
