import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from './content/universe';
import { startFreeRoam, startRaid } from './game/start';
import { createServices } from './game/services';
import { createActivities } from './game/activities';
import { loadSession } from './game/persistence';
import { distance, definitions } from './core/model';

/** Create the browser's normal new-game path, including its default traffic prehistory. */
function game() {
  return startFreeRoam(createCatalog(), createServices(), createActivities());
}

/** Verify five minutes of genuine NPC activity without charging the player for that prehistory. */
test('new free roam starts after five minutes of traffic with the original player and market state', () => {
  const warm = game(),
    cold = startFreeRoam(warm.catalog, warm.services, warm.activities, { trafficWarmup: false });
  assert.equal(warm.clock, 300);
  assert.deepEqual(warm.world.player, cold.world.player);
  assert.deepEqual(warm.captain, cold.captain);
  assert.deepEqual(warm.markets, {});
  assert.deepEqual(warm.visits, cold.visits);
  assert.equal(warm.dockedAt, cold.dockedAt);
  assert.deepEqual(warm.selection, cold.selection);
  assert.equal(warm.activity, null);
  assert.deepEqual(warm.world.relations.hostilePairs, []);
  assert.ok(
    warm.traffic.actors.some(
      /** Observe completed jobs rather than merely offset spawn coordinates. */ (a) =>
        a.journeys > 0
    )
  );
  assert.ok(
    warm.traffic.actors.some(
      /** Traffic can already have left its authored home system. */ (a) =>
        a.motion.systemId !== null && a.motion.systemId !== a.homeSystemId
    )
  );
  assert.ok(
    warm.traffic.actors.some(
      /** Real loading phases have populated commercial holds. */ (a) =>
        a.job.kind === 'freight' && Object.keys(a.ship.cargo).length > 0
    )
  );
  assert.deepEqual(warm.traffic.events, []);
  assert.deepEqual(warm.radio.active, []);
});

/** Ensure warm-up handoff only materializes present NPCs and keeps the ledger's authoritative ship references. */
test('warm traffic materializes once in the correct system and continues physically without teleporting', () => {
  const g = game(),
    local = g.traffic.actors.filter(
      /** Select actual current residents rather than original system spawns. */ (a) =>
        a.motion.systemId === g.systemId
    );
  const ids = g.world.ships.map(
    /** Detect duplicate materializations by stable hull identity. */ (s) => s.id
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    new Set(ids),
    new Set([
      g.world.player.id,
      ...local.map(/** Compare membership against the ledger after prehistory. */ (a) => a.ship.id)
    ])
  );
  const positions = new Map(
    local.map(
      /** Snapshot the active handoff position before physics resumes. */ (a) => [
        a.ship.id,
        { ...a.ship.position }
      ]
    )
  );
  for (const a of local)
    assert.equal(
      g.world.ships.find(
        /** Match the local materialization to the authoritative ledger record. */ (s) =>
          s.id === a.ship.id
      ),
      a.ship
    );
  assert.ok(g.dispatch({ type: 'undock' }).ok);
  g.step(1 / 60, { turn: 0, thrust: 0, brake: true, fire: false });
  assert.equal(g.clock, 300 + 1 / 60);
  for (const a of local)
    assert.ok(
      distance(positions.get(a.ship.id)!, a.ship.position) <=
        definitions[a.ship.kind].speed / 60 + 0.01
    );
});

/** Verify warm-up decisions are repeatable and saves resume from their exact warmed timeline. */
test('warm-up is deterministic and loading a saved game never adds another five minutes', () => {
  const g = game(),
    other = game();
  assert.equal(g.save(), other.save());
  const restored = loadSession(g.save(), g.catalog, g.services, g.activities);
  assert.equal(restored.clock, 300);
  assert.deepEqual(JSON.parse(restored.save()), JSON.parse(g.save()));
  assert.equal(loadSession(restored.save(), g.catalog, g.services, g.activities).clock, 300);
});

/** Preserve the isolated two-ship encounter's original setup and clock. */
test('the raid test starts immediately with its designated merchant still present', () => {
  const g = startRaid(createCatalog(), createServices(), createActivities());
  assert.equal(g.clock, 0);
  assert.equal(g.world.ships.length, 2);
  assert.ok(
    g.world.ships.some(
      /** Keep the encounter's required target available before combat starts. */ (s) =>
        s.id === 'ashen-trader'
    )
  );
  assert.equal(g.trafficEnabled, false);
});
