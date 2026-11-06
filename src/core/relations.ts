import type { Ship } from './model';
/** Hostility requires identity, ownership and health, not a complete domain ship record. */
export type RelationBody = Pick<Ship, 'id' | 'owner' | 'hull'>;
/**
 * Store explicit hostility between ship identities, independently of their culture,
 * faction or ownership labels.
 */
export class Relations {
  hostilePairs: string[] = [];
  /**
   * Normalize an unordered pair of ship IDs so hostility is symmetric and recorded only
   * once.
   */
  private key(a: string, b: string) {
    return [a, b].sort().join('|');
  }
  /**
   * Record mutual hostility between two different ships without duplicating an existing
   * pair.
   */
  declareHostile(a: string, b: string) {
    if (a === b) return;
    const key = this.key(a, b);
    if (!this.hostilePairs.includes(key)) this.hostilePairs.push(key);
  }
  /**
   * Check explicit hostility between living, non-salvage hulls; different cultures alone
   * never cause combat.
   */
  isHostile(a: RelationBody, b: RelationBody) {
    return (
      a.id !== b.id &&
      a.hull > 0 &&
      b.hull > 0 &&
      a.owner !== 'salvage' &&
      b.owner !== 'salvage' &&
      this.hostilePairs.includes(this.key(a.id, b.id))
    );
  }
}
