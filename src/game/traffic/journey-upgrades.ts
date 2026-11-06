import type { ContentCatalog } from '../../content/catalog';
import type { TrafficJobs } from './registry';
import { isRetired, type TrafficActor, type Port, type Destination } from './model';
import type { RoamingLinerState } from './jobs/liner';
/** Upgrade only stock actors whose newly authored purpose changed, preserving any journey already underway. */
export function upgradeStockJourneys(
  actors: TrafficActor[],
  catalog: ContentCatalog,
  jobs: TrafficJobs
) {
  const haulers = new Set(['aster-cradle', 'drift-003-freight-1', 'drift-005-freight-1']);
  const liners = new Set(['ashen-liner', 'aster-commonlight']);
  for (const actor of actors) {
    if (isRetired(actor)) continue;
    const spawn = catalog.systems[actor.homeSystemId]?.traffic.find(
      /** Limit content upgrades to the same stable authored actor identity. */ (spawn) =>
        spawn.ship.id === actor.ship.id
    );
    if (!spawn) continue;
    if (
      haulers.has(actor.ship.id) &&
      actor.job.kind === 'freight' &&
      spawn.job.kind === 'long-haul'
    ) {
      const old = actor.job.config as { route: [Port, Port] },
        state = actor.job.state as { origin: 0 | 1; next: string };
      const origin = old.route[state.origin],
        destination = old.route[state.origin === 0 ? 1 : 0];
      actor.job = jobs
        .get('long-haul')
        .read(
          spawn.job.config,
          {
            origin,
            destination,
            next: state.next,
            decision: 0,
            recentSystems: [origin.systemId, destination.systemId]
          },
          catalog
        );
    } else if (
      liners.has(actor.ship.id) &&
      actor.job.kind === 'liner' &&
      (actor.job.config as { routing?: string }).routing !== 'roaming' &&
      (spawn.job.config as { routing?: string }).routing === 'roaming'
    ) {
      const old = actor.job.config as { stops: Destination[] },
        state = actor.job.state as { index: number; next: 'depart' | 'visit' };
      const upgraded: RoamingLinerState = {
        index: 0,
        next: state.next,
        decision: 0,
        recentSystems: [actor.motion.systemId ?? actor.homeSystemId],
        destination: state.next === 'visit' ? old.stops[state.index] : null
      };
      actor.job = jobs.get('liner').read(spawn.job.config, upgraded, catalog);
    }
  }
}
