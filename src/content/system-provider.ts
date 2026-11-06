import type { ContentCatalog } from './catalog';
import type { SystemDefinition } from './schema';
/** Destination content boundary; a later provider can fetch assets without changing travel or NPC ownership. */
export interface SystemProvider {
  /** Resolve a destination definition or reject before the departure world is released. */
  load(systemId: string, signal?: AbortSignal): Promise<SystemDefinition>;
}
/** Initial provider serves already validated in-memory content; system JSON remains eagerly bundled for now. */
export class CatalogSystemProvider implements SystemProvider {
  /** Retain the same catalog used by graph navigation and background job policies. */
  constructor(private catalog: ContentCatalog) {}
  /** Introduce an asynchronous seam without a network dependency or artificial loading delay. */
  async load(systemId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const definition = this.catalog.systems[systemId];
    if (!definition) throw Error(`Unknown system: ${systemId}`);
    return definition;
  }
}
