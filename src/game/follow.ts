import type { GameSession, Contact } from './session';
import { actorSystemId, isRetired } from './traffic/model';
/**
 * Resolve the followed actor into a local contact or next-system hint, clearing a follow
 * order whose actor has retired.
 */
export function followTarget(
  game: GameSession
): { contact: Contact | null; message: string } | null {
  const a = game.followedActorId ? game.traffic.get(game.followedActorId) : undefined;
  if (!a) return null;
  if (isRetired(a)) {
    game.followedActorId = null;
    return null;
  }
  if (actorSystemId(a) === game.systemId)
    return {
      contact:
        game.contacts().find(
          /** Reacquire the followed ship among selectable contacts in the active system. */
          (c) => c.id === a.ship.id && c.kind === 'ship'
        ) ?? null,
      message: `Following ${a.ship.name} · ${game.traffic.activity(a)}`
    };
  const destination =
    actorSystemId(a) ?? (a.motion.kind === 'transit' ? a.motion.arrivalSystemId : a.homeSystemId);
  if (destination === game.systemId)
    return { contact: null, message: `Waiting for ${a.ship.name} to arrive` };
  const hop = game.routes.find(game.systemId, destination)?.hops[0];
  const gate = hop && game.gateById(hop.gateId);
  return {
    contact: gate ? { kind: 'gate', id: gate.id, name: gate.name, position: gate.position } : null,
    message: `${a.ship.name} → ${game.catalog.systems[destination]?.name ?? 'in transit'} · follow via gateway`
  };
}
