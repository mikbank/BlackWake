import { marketView } from './market';
import { definitions } from '../simulation';
import type { GameSession, Result } from '../game/session';
import { esc, element as $ } from './dom';
/**
 * Browser presentation for a separately registered domain service; stations opt in through
 * authored capability records.
 */
export type ServiceView = {
  /**
   * Render a station capability from current session state without owning its gameplay
   * rules.
   */
  render: (game: GameSession) => string;
  /**
   * Attach dialog controls to validated session commands and report their results to the
   * enclosing menu.
   */
  bind: (game: GameSession, result: (r: Result) => void) => void;
};
/** Register another service view here; station menus discover services from their definitions. */
export const serviceViews = new Map<string, ServiceView>();
serviceViews.set('market', marketView);
serviceViews.set('repair', {
  /**
   * Build the repair offer from missing hull/engine points and the station's configured
   * rate.
   */
  render(game) {
    const p = game.world.player,
      spec = game.station!.services.find(
        /** Resolve this station's repair rate before calculating the displayed offer. */
        (s) => s.kind === 'repair'
      )!,
      cost = Math.ceil((200 - p.hull - p.engines) * Number(spec.config.pricePerPoint));
    return `<div class="trade-wallet"><b>${game.captain.credits} cr</b><span>Repair cost ${cost} cr</span></div><div class="dossier-specs"><span>Hull<b>${Math.ceil(p.hull)}%</b></span><span>Engines<b>${Math.ceil(p.engines)}%</b></span></div><button class="secondary" id="repair-ship" ${cost === 0 ? 'disabled' : ''}>Repair hull and engines · ${cost} cr</button>`;
  },
  /**
   * Connect the repair button to the session service command rather than mutating the hull
   * directly in the UI.
   */
  bind(game, result) {
    /**
     * Request the station's repair service and let its domain handler validate funds and
     * damage.
     */
    $('repair-ship').onclick = () =>
      result(game.dispatch({ type: 'service', kind: 'repair', payload: {} }));
  }
});
