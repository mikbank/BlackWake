import type { GameSession } from '../game/session';
/**
 * List only direct connections from the chosen physical gate that currently pass speed,
 * position and access checks.
 */
export function jumpDestinations(game: GameSession, gateId: string) {
  return game.routes
    .connections(game.systemId)
    .filter(
      /** Keep only hops from this exact exit that are physically usable and permitted right now. */
      (hop) => hop.gateId === gateId && game.canJumpConnection(hop.connectionId)
    )
    .map(
      /** Pair each valid hop with its destination definition for the jump-menu presentation. */
      (hop) => ({ hop, system: game.catalog.systems[hop.toSystemId] })
    );
}
/** Resolve a system's authored region label, with a fallback for older regionless content. */
export function regionName(game: GameSession, systemId = game.systemId) {
  const id = game.catalog.systems[systemId].regionId;
  return id ? game.catalog.regions[id].name : 'Independent systems';
}
