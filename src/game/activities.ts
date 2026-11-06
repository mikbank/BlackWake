/** Optional activities observe facts; basic simulation and station services do not depend on them. */
export type GameEvent = {
  type: 'docked' | 'jumped' | 'boarded' | 'trade' | 'ship-destroyed' | 'cargo-raided';
  stationId?: string;
  systemId?: string;
  shipId?: string;
  commodityId?: string;
  direction?: 'buy' | 'sell';
  quantity?: number;
};
export type Activity = {
  type: string;
  config: Record<string, string>;
  state: Record<string, boolean | string | number>;
};
/**
 * Dispatch optional mission-progress observers; core trading, travel and combat continue
 * without an activity.
 */
export class ActivityRegistry {
  private observers = new Map<string, (activity: Activity, event: GameEvent) => void>();
  /**
   * Associate an activity type with its event observer without coupling that observer to
   * simulation systems.
   */
  register(type: string, observer: (activity: Activity, event: GameEvent) => void) {
    this.observers.set(type, observer);
  }
  /**
   * Notify the current activity about a gameplay fact, doing nothing when no activity is
   * active.
   */
  observe(activity: Activity | null, event: GameEvent) {
    if (activity) this.observers.get(activity.type)?.(activity, event);
  }
}
/**
 * Register the optional trading circuit and raid observers, which update progress from
 * completed actions rather than control gameplay.
 */
export function createActivities() {
  const activities = new ActivityRegistry();
  activities.register(
    'trade-route',
    /**
     * Observe completed market transactions and update the optional two-way trading circuit's
     * progress.
     */
    (a, e) => {
      if (e.type !== 'trade' || !e.quantity) return;
      if (
        e.stationId === a.config.origin &&
        e.commodityId === a.config.export &&
        e.direction === 'buy'
      )
        a.state.exportBought = true;
      if (
        e.stationId === a.config.destination &&
        e.commodityId === a.config.export &&
        e.direction === 'sell'
      )
        a.state.exportSold = true;
      if (
        e.stationId === a.config.destination &&
        e.commodityId === a.config.import &&
        e.direction === 'buy'
      )
        a.state.importBought = true;
      if (
        e.stationId === a.config.origin &&
        e.commodityId === a.config.import &&
        e.direction === 'sell'
      )
        a.state.importSold = true;
    }
  );
  activities.register(
    'raid',
    /** Observe destruction, boarding and return-to-port facts for the optional raid scenario. */
    (a, e) => {
      if (e.type === 'ship-destroyed' && e.shipId === a.config.target) a.state.failed = true;
      if (e.type === 'boarded' && e.shipId === a.config.target) a.state.captured = true;
      if (e.type === 'cargo-raided' && e.shipId === a.config.target) a.state.raided = true;
      if (
        e.type === 'docked' &&
        e.stationId === a.config.home &&
        (a.state.captured || a.state.raided)
      )
        a.state.complete = true;
    }
  );
  return activities;
}
