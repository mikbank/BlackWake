import type { Ship } from '../core/model';
import type { ContentCatalog } from './catalog';
import type { CultureDefinition, ShipDesignDefinition, RadioProfileDefinition } from './schema';

import shared from '../../content/universe.json' with { type: 'json' };
/** Standalone model/radio callers use the same authored defaults as the runtime catalog. */
export const defaultShipDesigns = shared.shipDesigns as Record<string, ShipDesignDefinition>;
export const defaultCultures = shared.cultures as Record<string, CultureDefinition>;
export const defaultRadioProfiles = shared.radioProfiles as Record<string, RadioProfileDefinition>;
/**
 * Hash an identity into a repeatable choice; no shared random stream is consumed when
 * another actor is added.
 */
export function stableIndex(key: string, count: number) {
  let hash = 2166136261;
  for (const ch of key) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}
/**
 * Look up a registered culture and reject unknown IDs instead of silently replacing a
 * saved identity.
 */
export function getCulture(catalog: Pick<ContentCatalog, 'cultures'>, id: string) {
  if (typeof id !== 'string' || !Object.hasOwn(catalog.cultures, id))
    throw Error(`Unknown culture: ${id}`);
  return catalog.cultures[id];
}
/** Require a registered visual design compatible with the ship's gameplay hull class. */
export function validateShipDesign(
  ship: Pick<Ship, 'kind' | 'designId'>,
  designs: Record<string, ShipDesignDefinition>
) {
  const id = ship.designId;
  if (typeof id !== 'string' || !Object.hasOwn(designs, id) || designs[id].kind !== ship.kind)
    throw Error('Unknown ship design or incompatible hull class.');
  return designs[id];
}
/**
 * Resolve a missing hull design once from culture and job pools; preserve and validate an
 * explicitly assigned foreign hull.
 */
export function assignShipDesign(
  catalog: ContentCatalog,
  ship: Ship,
  cultureId: string,
  seed: number,
  designRole?: string
) {
  const culture = getCulture(catalog, cultureId);
  if (ship.designId === undefined) {
    const roleChoices = designRole && culture.roleDesigns?.[designRole];
    const choices = roleChoices
      ? roleChoices.filter(
          /** Keep only job-pool designs compatible with the physical hull's gameplay class. */
          (id) => catalog.shipDesigns[id]?.kind === ship.kind
        )
      : culture.shipDesigns[ship.kind];
    if (!choices?.length) throw Error('Culture has no design for this hull class.');
    ship.designId = choices[stableIndex(`${seed}:${ship.id}:design`, choices.length)];
  }
  validateShipDesign(ship, catalog.shipDesigns);
  return ship;
}
