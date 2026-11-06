import { finishTransit } from './test-support/travel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntityStore, EntityCommands, SystemSchedule } from './core/ecs/store';
import { World, freshDefence } from './simulation';
import { makeShip, position } from './content/universe';
import { startFreeRoam } from './game/start';
import { createCatalog } from './content/universe';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';

/** Build a small spatial world without browser state or mission observers. */
function world() {
  return new World([makeShip('pilot', 'Pilot', 'cutter', 'player', 0, 0)], 'pilot');
}
const idle = { turn: 0, thrust: 0, brake: true, fire: false };

/** Verify component membership and mutable query data are independently composable. */
test('typed queries match capabilities and expose the authoritative component record', () => {
  const e = new EntityStore<{ position: { x: number }; weapon: { reload: number } }>();
  e.create('a', { position: { x: 1 } });
  e.create('b', { position: { x: 2 }, weapon: { reload: 0 } });
  const rows = e.query('position', 'weapon');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'b');
  rows[0].components.position.x = 9;
  assert.equal(e.require('b', 'position').x, 9);
  e.remove('b', 'weapon');
  assert.equal(e.query('position', 'weapon').length, 0);
  assert.equal(e.require('b', 'position').x, 9);
  e.destroy('b');
  assert.equal(e.get('b', 'position'), undefined);
  assert.equal(e.size, 1);
  assert.throws(
    /** Duplicate identities must not replace existing component data. */ () => e.create('a')
  );
  assert.throws(
    /** Invalid partial initialization must leave no half-created identity. */ () =>
      e.create('bad', { position: undefined })
  );
  assert.equal(e.has('bad'), false);
});

/** Verify ordered phases and a safe explicit boundary for structural changes. */
test('phase scheduling and deferred entity changes preserve deterministic boundaries', () => {
  const e = new EntityStore<{ counter: { value: number } }>();
  const commands = new EntityCommands();
  const schedule = new SystemSchedule<string[]>();
  schedule.add({
    name: 'second',
    /** Record execution order independently of entity data. */ update(log) {
      log.push('second');
    }
  });
  schedule.add(
    {
      name: 'first',
      /** Insert before a known phase without replacing registrations. */ update(log) {
        log.push('first');
      }
    },
    'second'
  );
  const log: string[] = [];
  schedule.run(log);
  assert.deepEqual(log, ['first', 'second']);
  assert.throws(
    /** Duplicate names would make extension ordering ambiguous. */ () =>
      schedule.add({ name: 'first', /** This duplicate body must never execute. */ update() {} })
  );
  e.create('a', { counter: { value: 0 } });
  e.beginUpdate();
  e.require('a', 'counter').value++;
  assert.throws(
    /** Systems must defer composition edits while a tick is running. */ () => e.destroy('a')
  );
  commands.defer(
    /** Apply the lifecycle request only after all phase queries complete. */ () => e.destroy('a')
  );
  assert.equal(e.has('a'), true);
  e.endUpdate();
  commands.flush();
  assert.equal(e.has('a'), false);
});

/** Verify the domain adapter is a live projection rather than a copied second hull store. */
test('ship records and components share identity and survive component replacement', () => {
  const w = world(),
    p = w.player;
  assert.equal(w.entities.require(p.id, 'ship').record, p);
  w.entities.require(p.id, 'hull').health = 47;
  assert.equal(p.hull, 47);
  p.engines = 39;
  assert.equal(w.entities.require(p.id, 'propulsion').condition, 39);
  w.entities.set(p.id, 'transform', { position: position(7, 9), heading: 1.2 });
  assert.equal(p.position.x, 7);
  assert.equal(p.heading, 1.2);
  p.cargo = { rations: 3 };
  assert.equal(w.entities.require(p.id, 'cargo').goods, p.cargo);
  const plain = structuredClone(p);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), JSON.parse(JSON.stringify(plain)));
  assert.throws(
    /** A live identity cannot change while component maps reference its ID. */ () =>
      (p.id = 'renamed')
  );
});

/** Verify destroying an entity restores any external domain reference to usable plain data. */
test('entity lifecycle detaches records and equipment before deleting components', () => {
  const w = world(),
    npc = makeShip('visitor', 'Visitor', 'merchant', 'guild', 80, 30);
  w.addShip(npc);
  npc.hull = 61;
  w.defenceFor(npc).interceptions = 8;
  w.entities.destroy(npc.id);
  assert.equal(npc.hull, 61);
  npc.position = position(900, 40);
  assert.equal(npc.position.x, 900);
  assert.equal(w.ships.length, 1);
  assert.equal(w.entities.has(npc.id), false);
  assert.equal(w.defences[npc.id], undefined);
  assert.equal(typeof Object.getOwnPropertyDescriptor(npc, 'hull')!.get, 'undefined');
});

/** Verify a motion-only entity participates without pretending to be a cargo-carrying ship. */
test('component-only debris drifts without ship, hull, cargo or propulsion components', () => {
  const w = world();
  w.entities.create('debris', {
    transform: { position: position(0, 40), heading: 0 },
    motion: { velocity: position(12, -3) }
  });
  w.step(0.5, idle);
  assert.deepEqual(w.entities.require('debris', 'transform').position, position(6, 38.5));
  assert.equal(w.ships.length, 1);
  assert.equal(w.entities.get('debris', 'cargo'), undefined);
});

/** Verify removing a capability changes behavior rather than leaving an unused component label. */
test('removing broadside, PDC or cruise capabilities changes the corresponding system behavior', () => {
  const w = world(),
    enemy = makeShip('enemy', 'Enemy', 'merchant', 'guild', 0, 180);
  w.addShip(enemy);
  w.relations.declareHostile('pilot', 'enemy');
  w.entities.remove('pilot', 'broadside');
  w.entities.remove('pilot', 'pointDefence');
  w.entities.remove('pilot', 'cruise');
  w.shots.push({
    owner: 'enemy',
    position: position(100, 0),
    velocity: position(-390, 0),
    life: 1,
    disable: false
  });
  w.step(1 / 60, { ...idle, fire: true, targetId: 'enemy', cruise: true, thrust: 1 });
  assert.equal(
    w.shots.some(
      /** The player lacks a weapon capability even when fire is requested. */ (s) =>
        s.owner === 'pilot'
    ),
    false
  );
  assert.equal(
    w.defenceRounds.some(
      /** A missing PDC capability must not be silently reinstalled by queries. */ (r) =>
        r.owner === 'pilot'
    ),
    false
  );
  assert.equal(w.cruise.forShip(w.player).phase, 'off');
  assert.equal(w.entities.get('pilot', 'pointDefence'), undefined);
});

/** Verify a component-only weapon platform does not need inventory, crew or propulsion to fire. */
test('stationary component-only weapons reload and fire without a domain ship record', () => {
  const w = world();
  w.player.position = position(0, 200);
  w.entities.remove('pilot', 'pointDefence');
  w.entities.create('platform', {
    transform: { position: position(0, 0), heading: 0 },
    motion: { velocity: position(0, 0) },
    hull: { kind: 'cutter', health: 100 },
    ownership: { owner: 'authority', factionId: 'police', role: 'idle' },
    broadside: { reload: [0, 0] },
    control: { input: { ...idle, fire: true, targetId: 'pilot' } }
  });
  w.relations.declareHostile('platform', 'pilot');
  w.step(1 / 60, idle);
  assert.ok(
    w.shots.some(
      /** Attribute shells to the component-only firing entity. */ (s) => s.owner === 'platform'
    )
  );
  const before = w.entities.require('platform', 'broadside').reload[0];
  w.step(0.1, idle);
  assert.ok(w.entities.require('platform', 'broadside').reload[0] < before);
  assert.equal(w.entities.get('platform', 'propulsion'), undefined);
  assert.equal(w.ships.length, 1);
});

/** Verify extending the phase list can mutate data and defer creation without touching the World loop. */
test('an added system runs on the main thread and defers structural operations until tick end', () => {
  const w = world();
  w.schedule.add(
    {
      name: 'test-extension',
      /** Demonstrate the actual public extension boundary used by custom spatial behavior. */ update(
        frame
      ) {
        frame.entities.require('pilot', 'hull').health = 88;
        frame.commands.defer(
          /** Create only after the current frame's entity composition unlocks. */ () => {
            if (!frame.entities.has('marker'))
              frame.entities.create('marker', {
                transform: { position: position(1, 2), heading: 0 }
              });
          }
        );
      }
    },
    'damage'
  );
  w.step(1 / 60, idle);
  assert.equal(w.player.hull, 88);
  assert.equal(w.entities.has('marker'), true);
  assert.ok(w.cruise.forShip(w.player).lockout > 0);
});

/** Verify normal entity reconciliation preserves component records and live equipment state. */
test('repeated materialization retains drive and equipment state for unchanged hull identities', () => {
  const w = world(),
    p = w.player,
    state = w.entities.require(p.id, 'cruise');
  state.charge = 0.8;
  const defence = w.defenceFor(p);
  defence.interceptions = 7;
  for (let i = 0; i < 10; i++) w.replaceShips([p]);
  assert.equal(w.entities.require(p.id, 'cruise'), state);
  assert.equal(state.charge, 0.8);
  assert.equal(w.defenceFor(p), defence);
  assert.equal(defence.interceptions, 7);
  w.combat.defences = { pilot: { ...freshDefence(), interceptions: 13 } };
  assert.equal(w.entities.require(p.id, 'pointDefence').interceptions, 13);
});

/** Verify old save DTOs remain unchanged while each active system rebuilds its component ownership. */
test('save, reload, capture and jumps preserve the domain identity boundary', () => {
  let g = startFreeRoam(createCatalog(), createServices(), createActivities(), {
    trafficWarmup: false
  });
  g.dispatch({ type: 'undock' });
  const actor = g.traffic.get('ashen-trader')!;
  assert.equal(actor.ship, g.world.entities.require(actor.ship.id, 'ship').record);
  actor.ship.engines = 0;
  actor.ship.position = position(g.world.player.position.x + 80, g.world.player.position.y);
  actor.ship.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'board', shipId: actor.ship.id, outcome: 'capture' }).ok);
  g.world.defenceFor(g.world.player).interceptions = 12;
  const saved = JSON.parse(g.save());
  assert.equal(saved.version, 6);
  assert.equal(saved.entities, undefined);
  g = loadSession(JSON.stringify(saved), g.catalog, g.services, g.activities);
  assert.equal(g.world.player.id, actor.ship.id);
  assert.equal(g.world.defenceFor(g.world.player).interceptions, 12);
  const oldWorld = g.world,
    gate = g.definition.gates[0];
  g.world.player.position = { ...gate.position };
  g.world.player.velocity = position(0, 0);
  assert.ok(g.dispatch({ type: 'jump', connectionId: gate.connections[0].id }).ok);
  finishTransit(g);
  assert.equal(oldWorld.entities.size, 0);
  assert.equal(g.world.defenceFor(g.world.player).interceptions, 12);
});

/** Verify ballistic damage does not require or silently grant propulsion to a stationary entity. */
test('component-only bodies take shell damage without gaining an engine capability', () => {
  const w = world();
  w.entities.create('platform', {
    transform: { position: position(100, 0), heading: 0 },
    motion: { velocity: position(0, 0) },
    hull: { kind: 'cutter', health: 100 },
    ownership: { owner: 'authority', factionId: 'police', role: 'idle' }
  });
  w.shots.push({
    owner: 'pilot',
    position: position(95, 0),
    velocity: position(100, 0),
    life: 1,
    disable: false
  });
  w.step(0.1, idle);
  assert.ok(w.entities.require('platform', 'hull').health < 100);
  assert.equal(w.entities.get('platform', 'propulsion'), undefined);
});
