import definition from '../../content/universe.json' with { type: 'json' };
import { systemDefinitions } from './system-index';
import { catalogFromData } from './data';
export { position, makeShip } from './ship-factory';
/**
 * Load the same shared manifest and generated system imports used by authoring tools,
 * returning an independently validated catalog.
 */
export function createCatalog() {
  return catalogFromData(definition, systemDefinitions);
}
