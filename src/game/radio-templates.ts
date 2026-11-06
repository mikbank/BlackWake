import type { Announcement } from './traffic/model';
import type { CultureDefinition, RadioProfileDefinition } from '../content/schema';
import { defaultCultures, defaultRadioProfiles, stableIndex } from '../content/identity';
export type RadioSpeaker = { id: string; name: string; cultureId: string };
type IdentityCatalog = {
  cultures: Record<string, CultureDefinition>;
  radioProfiles: Record<string, RadioProfileDefinition>;
};
/**
 * Resolve semantic announcements into speaker-culture text, with deterministic variants
 * and shared topic fallbacks.
 */
export class RadioTemplates {
  private templates = new Map<string, (values: Announcement['values']) => string>();
  /**
   * Use the provided identity registry or authored defaults; radio voice follows the crew
   * rather than its current system.
   */
  constructor(
    readonly identity: IdentityCatalog = {
      cultures: defaultCultures,
      radioProfiles: defaultRadioProfiles
    }
  ) {}
  /**
   * Register one fallback formatter for a semantic topic and reject accidental duplicate
   * handlers.
   */
  register(topic: string, format: (values: Announcement['values']) => string) {
    if (this.templates.has(topic)) throw Error(`Duplicate radio topic: ${topic}`);
    this.templates.set(topic, format);
  }
  /**
   * Select a speaker's cultural phrase, safely substitute supplied facts and fall back when
   * the topic or required values are missing.
   */
  format(event: Announcement & { id?: string }, speaker?: RadioSpeaker) {
    if (speaker) {
      const culture = this.identity.cultures[speaker.cultureId],
        profile = culture && this.identity.radioProfiles[culture.radioProfileId];
      if (!culture || !profile) throw Error('Unknown speaker culture or radio profile.');
      const variants = Object.hasOwn(profile.templates, event.topic)
        ? profile.templates[event.topic]
        : undefined;
      if (variants?.length) {
        const values: Record<string, string | number> = {
          ...event.values,
          speaker: speaker.name,
          culture: culture.name
        };
        let complete = true;
        const phrase = variants[
          stableIndex(`${speaker.id}:${event.id ?? event.topic}`, variants.length)
        ].replace(
          /\{([a-zA-Z][\w]*)\}/g,
          /**
           * Substitute an available announcement fact and mark the phrase incomplete if its
           * placeholder is unknown.
           */
          (_token, key: string) => {
            if (!Object.hasOwn(values, key)) {
              complete = false;
              return '';
            }
            return String(values[key]);
          }
        );
        if (complete) return phrase;
      }
    }
    return this.templates.get(event.topic)?.(event.values);
  }
}
/**
 * Register the shared freight, navigation, passenger, liner, patrol and distress
 * vocabulary used by text bubbles.
 */
export function createRadioTemplates(identity?: IdentityCatalog) {
  const t = new RadioTemplates(identity);
  t.register(
    'freight.depart',
    /** Phrase a freighter's actual outbound destination and loaded commodity manifest. */
    (v) => `Outbound for ${v.destination}. ${v.cargo} secured.`
  );
  t.register(
    'freight.dock',
    /** Phrase arrival alongside the unloading destination. */
    (v) => `Alongside ${v.destination}. Unloading cargo.`
  );
  t.register(
    'freight.complete',
    /** Phrase completion of a delivery and preparation for the next load. */
    () => `Delivery complete. Preparing the return load.`
  );
  t.register(
    'navigation.charging',
    /** Phrase the immediate next system while the jump drive charges. */
    (v) => `Jump drive charging. Next stop, ${v.destination}.`
  );
  t.register(
    'navigation.transfer',
    /** Phrase an intermediate-system arrival while retaining the final destination. */
    (v) => `${v.system} entered. Continuing to ${v.destination}.`
  );
  t.register(
    'navigation.arrival',
    /** Phrase approach to the final destination after the last jump. */
    (v) => `Inbound for ${v.destination}. Requesting approach.`
  );
  t.register(
    'passenger.board',
    /** Phrase boarding instructions for the scheduled passenger destination. */
    (v) => `Boarding for ${v.destination}. Please secure your luggage.`
  );
  t.register(
    'passenger.depart',
    /** Phrase a passenger departure using the actual onboard count. */
    (v) => `${v.passengers} passengers aboard. Service to ${v.destination} departing.`
  );
  t.register(
    'passenger.dock',
    /** Phrase the passenger service's docking arrival. */
    (v) => `Welcome to ${v.destination}. Please remain seated until docking is complete.`
  );
  t.register(
    'liner.depart',
    /** Phrase a liner departure using its guest count and next sightseeing destination. */
    (v) => `Our ${v.passengers} guests are bound for ${v.destination}. Enjoy the view.`
  );
  t.register(
    'liner.view',
    /** Phrase arrival at a named sightseeing stop. */
    (v) => `Now viewing ${v.destination}. Observation lounge open.`
  );
  t.register(
    'patrol.clear',
    /** Phrase the completion of a patrol's current sector survey. */
    (v) => `${v.sector} checked. Continuing security patrol.`
  );
  t.register(
    'patrol.respond',
    /** Phrase a security warning addressed to the reported offender. */
    (v) => `${v.target}, cease fire! Security patrol responding.`
  );
  t.register(
    'ship.attacked',
    /** Phrase an urgent route interruption after a nearby hostile contact. */
    () => `Mayday! Taking fire. Our planned route is interrupted!`
  );
  t.register(
    'ship.disabled',
    /** Phrase an urgent loss of engine maneuverability. */
    () => `Engines down. We cannot manoeuvre!`
  );
  return t;
}
