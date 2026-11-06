import { distance, type Vec3 } from '../core/model';
import type { ContentCatalog } from '../content/catalog';
import { actorSystemId, isRetired, type TrafficActor, type TrafficEvent } from './traffic/model';
import { createRadioTemplates, RadioTemplates } from './radio-templates';
export type RadioBubble = {
  id: string;
  actorId: string;
  name: string;
  text: string;
  expires: number;
  urgent: boolean;
};
type TrafficReader = { get: (id: string) => TrafficActor | undefined };
/**
 * Schedule nearby ship text bubbles with urgency, relevance, deduplication and display
 * limits; it never drives NPC jobs.
 */
export class RadioDirector {
  active: RadioBubble[] = [];
  private pending: TrafficEvent[] = [];
  private seen = new Set<string>();
  private lastByActor = new Map<string, number>();
  private nextAt = 0;
  private systemId = '';
  /** Create speaker-aware formatters from the same catalog used by the traffic ledger. */
  constructor(
    readonly catalog: ContentCatalog,
    readonly templates: RadioTemplates = createRadioTemplates(catalog)
  ) {}
  /**
   * Remove transient displayed and queued chatter when the visible system changes or a
   * scenario resets.
   */
  clear() {
    this.active = [];
    this.pending = [];
    this.nextAt = 0;
  }
  /**
   * Consume traffic announcements, expire old bubbles and schedule relevant speakers under
   * global and per-ship cooldowns.
   */
  update(
    now: number,
    events: TrafficEvent[],
    traffic: TrafficReader,
    systemId: string,
    listener: Vec3,
    selectedId?: string
  ) {
    if (this.systemId !== systemId) {
      this.clear();
      this.systemId = systemId;
    }
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
      const speaker = traffic.get(event.actorId);
      if (
        event.systemId !== systemId ||
        !speaker ||
        !this.templates.format(event, {
          id: speaker.ship.id,
          name: speaker.ship.name,
          cultureId: speaker.cultureId
        })
      )
        continue;
      if (event.urgent) {
        this.pending = this.pending.filter(
          /** Remove older queued chatter from a speaker whose urgent event has superseded it. */
          (p) => p.actorId !== event.actorId
        );
        this.active = this.active.filter(
          /** Remove older displayed chatter from a speaker whose urgent event must take priority. */
          (p) => p.actorId !== event.actorId
        );
        this.pending.unshift(event);
      } else this.pending.push(event);
    }
    /**
     * Check whether a speaker still exists as active traffic in the player's current system
     * before showing its bubble.
     */
    const present = (id: string) => {
      const a = traffic.get(id);
      return !!a && actorSystemId(a) === systemId && !isRetired(a);
    };
    this.pending = this.pending
      .filter(
        /** Discard stale queued events and speakers no longer present in this system. */
        (e) => now - e.at < 8 && present(e.actorId)
      )
      .slice(0, 20);
    this.active = this.active.filter(
      /** Keep only unexpired displayed bubbles whose speakers remain locally active. */
      (b) => b.expires > now && present(b.actorId)
    );
    const index = this.pending.findIndex(
      /** Choose a relevant pending event whose speaker and cooldowns permit presentation now. */
      (e) => {
        const a = traffic.get(e.actorId)!;
        return (
          (a.ship.id === selectedId || distance(listener, a.ship.position) < 950) &&
          (e.urgent ||
            (now >= this.nextAt && now - (this.lastByActor.get(e.actorId) ?? -Infinity) >= 4)) &&
          !this.active.some(
            /** Avoid showing multiple simultaneous bubbles from the same ship. */
            (b) => b.actorId === e.actorId
          )
        );
      }
    );
    if (index < 0) return;
    const event = this.pending[index],
      urgent = !!event.urgent;
    if (this.active.length >= 2) {
      if (!urgent) return;
      const routine = this.active.findIndex(
        /** Find a nonurgent displayed bubble that may yield space to an urgent announcement. */
        (b) => !b.urgent
      );
      this.active.splice(routine >= 0 ? routine : 0, 1);
    }
    this.pending.splice(index, 1);
    const actor = traffic.get(event.actorId)!;
    this.active.push({
      id: event.id,
      actorId: event.actorId,
      name: actor.ship.name,
      text: this.templates.format(event, {
        id: actor.ship.id,
        name: actor.ship.name,
        cultureId: actor.cultureId
      })!,
      expires: now + 5.5,
      urgent
    });
    this.nextAt = now + 2;
    this.lastByActor.set(event.actorId, now);
  }
}
