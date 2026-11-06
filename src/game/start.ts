import { GameSession } from './session';
import { makeShip, position } from '../content/universe';
import type { ContentCatalog } from '../content/catalog';
import type { ServiceRegistry } from './services';
import type { ActivityRegistry } from './activities';
type StartOptions = {
  /** Disable prehistory for isolated scenarios and tests that need original spawn positions. */
  trafficWarmup?: boolean;
};
/**
 * Start an unassigned voyage at Haven after five minutes of neutral background traffic.
 * Warm-up advances the shared game clock and NPC jobs, then binds only ships currently
 * in Ashen. Player state and markets are untouched; save restoration does not use this path.
 */
export function startFreeRoam(
  catalog: ContentCatalog,
  services: ServiceRegistry,
  activities: ActivityRegistry,
  options: StartOptions = {}
) {
  const station = catalog.systems.ashen.stations[0];
  const player = makeShip(
    'wayward',
    'The Wayward',
    'cutter',
    'player',
    station.position.x,
    station.position.y
  );
  const session = new GameSession(catalog, services, activities, 'ashen', player);
  session.enableTraffic();
  session.dockedAt = station.id;
  session.selection = { kind: 'station', id: station.id };
  if (options.trafficWarmup !== false) {
    // Reuse bounded background updates: no physics, rendering or stale radio playback.
    for (let elapsed = 0; elapsed < 300; elapsed += 60) {
      session.traffic.advanceBackground(session.clock, 60);
      session.clock += 60;
    }
    session.bindTraffic();
  }
  return session;
}
/**
 * Attach the optional guided trading circuit to a normal voyage, primarily for the
 * retained scenario and integration tests.
 */
export function startTrading(
  catalog: ContentCatalog,
  services: ServiceRegistry,
  activities: ActivityRegistry
) {
  const session = startFreeRoam(catalog, services, activities, { trafficWarmup: false });
  session.activity = {
    type: 'trade-route',
    config: {
      origin: 'haven',
      destination: 'relay',
      export: 'rations',
      import: 'parts',
      originSystem: 'ashen',
      destinationSystem: 'kepler'
    },
    state: {}
  };
  return session;
}
/**
 * Create the isolated two-ship combat test with a hostile cargo prize and a separate
 * optional raid activity.
 */
export function startRaid(
  catalog: ContentCatalog,
  services: ServiceRegistry,
  activities: ActivityRegistry
) {
  const session = startFreeRoam(catalog, services, activities, { trafficWarmup: false });
  session.traffic.actors = [];
  session.trafficEnabled = false;
  session.world.ships = session.world.ships.filter(
    /** Keep only the player and the raid's designated merchant in the isolated combat scenario. */
    (s) => s.id === session.world.controlledShipId || s.id === 'ashen-trader'
  );
  session.radio.clear();
  session.dockedAt = null;
  session.world.player.position = position(0, 0);
  const target = session.world.ships.find(
    /** Resolve the designated merchant before applying the raid-only hostile setup and cargo. */
    (s) => s.id === 'ashen-trader'
  )!;
  target.name = 'Gilded Gull';
  target.position = position(1325, 400);
  target.cargo = { rations: 16, parts: 8 };
  target.role = 'hostile';
  session.world.relations.declareHostile(session.world.player.id, target.id);
  session.selection = { kind: 'ship', id: target.id };
  session.activity = { type: 'raid', config: { target: target.id, home: 'haven' }, state: {} };
  return session;
}
