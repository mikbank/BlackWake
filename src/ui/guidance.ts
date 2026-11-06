import type { GameSession, Selection, Contact } from '../game/session';
/**
 * Suggest the next route gate or optional activity contact without restricting the
 * player's own selection.
 */
export function suggestedContact(game: GameSession): Selection | null {
  if (game.routeDestinationId) {
    const hop = game.routes.find(game.systemId, game.routeDestinationId)?.hops[0];
    return hop ? { kind: 'gate', id: hop.gateId } : null;
  }
  const activity = game.activity;
  if (activity?.type === 'raid')
    return activity.state.captured || activity.state.raided
      ? { kind: 'station', id: activity.config.home }
      : { kind: 'ship', id: activity.config.target };
  if (activity?.type === 'trade-route') {
    const a = activity,
      state = a.state,
      ship = game.world.player;
    let stationId: string, systemId: string;
    if (!state.exportSold) {
      const carrying = (ship.cargo[a.config.export] ?? 0) > 0;
      stationId = carrying ? a.config.destination : a.config.origin;
      systemId = carrying ? a.config.destinationSystem : a.config.originSystem;
    } else if (!state.importSold) {
      const carrying = (ship.cargo[a.config.import] ?? 0) > 0;
      stationId = carrying ? a.config.origin : a.config.destination;
      systemId = carrying ? a.config.originSystem : a.config.destinationSystem;
    } else return null;
    if (game.systemId === systemId) return { kind: 'station', id: stationId };
    const hop = game.routes.find(game.systemId, systemId)?.hops[0],
      gate = hop && game.gateById(hop.gateId);
    return gate ? { kind: 'gate', id: gate.id } : null;
  }
  return null;
}
/**
 * Describe the plotted itinerary, optional activity or free-roam options from current
 * session state.
 */
export function guideText(game: GameSession) {
  if (game.routeDestinationId) {
    const route = game.routes.find(game.systemId, game.routeDestinationId);
    return route
      ? `To ${game.catalog.systems[game.routeDestinationId].name} · ${route.hops.length} jump${route.hops.length === 1 ? '' : 's'} remaining.`
      : 'Your plotted route is currently unavailable.';
  }
  const a = game.activity;
  if (a?.type === 'raid')
    return a.state.failed
      ? 'Raid prize lost. Trade or explore freely.'
      : a.state.complete
        ? 'Raid complete. Trade or explore freely.'
        : a.state.captured || a.state.raided
          ? 'Bring your prize or cargo to the home station.'
          : 'Optional raid: disable the merchant, then raid cargo or take the ship.';
  if (a?.type === 'trade-route') {
    if (a.state.exportSold && a.state.importSold)
      return 'Trading circuit complete. Find your next opportunity.';
    const exporting = !a.state.exportSold,
      good = exporting ? a.config.export : a.config.import,
      carrying = (game.world.player.cargo[good] ?? 0) > 0;
    const stationId = exporting
      ? carrying
        ? a.config.destination
        : a.config.origin
      : carrying
        ? a.config.origin
        : a.config.destination;
    const station = Object.values(game.catalog.systems)
        .flatMap(
          /** Collect stations across systems before resolving the optional trading destination. */
          (s) => s.stations
        )
        .find(
          /** Resolve the current station name used in the trading guidance text. */
          (s) => s.id === stationId
        ),
      name = game.catalog.commodities[good]?.name ?? good;
    return `${carrying ? 'Sell' : 'Buy'} ${name.toLowerCase()} at ${station?.name ?? stationId}.`;
  }
  return 'Free roam · Trade, explore, or choose a ship to attack.';
}
/**
 * Derive one context action, label and combat presentation from the selected contact and
 * shared interaction eligibility.
 */
export function sessionHud(game: GameSession) {
  const contact =
    game.selected ??
    game.contacts().find(
      /** Offer a local station as the fallback contact when nothing valid is selected. */
      (c) => c.kind === 'station'
    ) ??
    game.contacts()[0];
  const base = {
    contact,
    objective: guideText(game),
    action: 'none',
    label: '',
    hint: 'Tap space to fly.',
    combat: false
  };
  if (!contact) return base;
  if (game.dockedAt)
    return {
      ...base,
      action: 'station',
      label: 'Station services',
      hint: `Docked at ${game.station?.name}.`
    };
  const speed = Math.hypot(game.world.player.velocity.x, game.world.player.velocity.y);
  if (contact.kind === 'station') {
    const station = game.stationById(contact.id)!;
    const ready = game.canDock(station),
      near =
        Math.hypot(
          game.world.player.position.x - station.position.x,
          game.world.player.position.y - station.position.y
        ) < game.catalog.stationSizes[station.size].dockRadius;
    return {
      ...base,
      action: ready ? 'dock' : near && speed >= 75 ? 'brake' : 'approach',
      label: ready
        ? `Dock at ${station.name}`
        : near && speed >= 75
          ? 'Slow to dock'
          : `Approach ${station.name}`,
      hint: 'Your ship slows automatically on approach.'
    };
  }
  if (contact.kind === 'gate') {
    const gate = game.gateById(contact.id)!,
      ready = game.canJump(gate);
    return {
      ...base,
      action: ready ? 'jump-map' : 'approach',
      label: ready ? 'Choose jump destination' : 'Approach gateway',
      hint: ready
        ? 'Choose a destination connected to this gateway.'
        : 'Jumping is available inside the outer zone.'
    };
  }
  if (contact.kind === 'ship') {
    const target = game.world.ships.find(
      /** Resolve the selected ship before choosing attack, approach or boarding guidance. */
      (s) => s.id === contact.id
    )!;
    if (target.engines === 0)
      return {
        ...base,
        action: game.canBoard(target.id) ? 'board' : 'approach',
        label: game.canBoard(target.id) ? 'Board vessel' : 'Approach disabled ship',
        hint: 'Approach within 155 m and match speed.'
      };
    const hostile = game.world.relations.isHostile(game.world.player, target);
    return {
      ...base,
      action: hostile ? 'none' : game.canAttack(target.id) ? 'attack' : 'contact',
      label: hostile ? '' : game.canAttack(target.id) ? `Attack ${target.name}` : 'Contact details',
      combat: hostile,
      hint: hostile
        ? 'Maneuver alongside for a broadside. Disable engines to board.'
        : 'Neutral traffic. Tap Attack to engage; tap the name for details.'
    };
  }
  return {
    ...base,
    action: 'contact',
    label: 'Landmark details',
    hint: 'Select a station or gateway to continue.'
  };
}
