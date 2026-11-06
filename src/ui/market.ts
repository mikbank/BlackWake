import { definitions } from '../core/model';
import {
  cargoUsed,
  marketState,
  marketPrice,
  marketLimit,
  marketGoods,
  type MarketContext,
  type TradeDirection
} from '../game/services';
import type { GameSession } from '../game/session';
import type { ServiceView } from './station-services';
import { esc, element as $ } from './dom';
let direction: TradeDirection = 'buy';
let quantity = 1;
let category = 'all';
let lastStation = '';

/** Build a read/trade view of this dock's market without granting the UI direct state mutation. */
function context(game: GameSession): MarketContext {
  const station = game.station!;
  const spec = station.services.find(
    /** Resolve the actual market capability rather than infer one from station size. */
    (service) => service.kind === 'market'
  )!;
  return {
    station,
    spec,
    catalog: game.catalog,
    markets: game.markets,
    ship: game.world.player,
    captain: game.captain
  };
}

/** Present one directional market with only the stock offered here or the player's actual cargo. */
export const marketView: ServiceView = {
  /** Render separate shopping and cargo-selling views, including explicit unsupported-goods rows. */
  render(game) {
    const ctx = context(game);
    const profile = game.catalog.markets[String(ctx.spec.config.profileId)];
    const stock = marketState(ctx);
    if (lastStation !== ctx.station.id) {
      category = 'all';
      lastStation = ctx.station.id;
    }
    const ids = marketGoods(ctx, direction);
    ids.sort(
      /** Keep the assortment readable by category and display name rather than storage order. */
      (a, b) =>
        (game.catalog.commodities[a].category ?? 'Other').localeCompare(
          game.catalog.commodities[b].category ?? 'Other'
        ) || game.catalog.commodities[a].name.localeCompare(game.catalog.commodities[b].name)
    );
    const categories = [
      ...new Set(
        ids.map(
          /** Derive filters from the displayed goods rather than a fixed list of categories. */
          (id) => game.catalog.commodities[id].category ?? 'Other'
        )
      )
    ];
    if (!categories.includes(category)) category = 'all';
    const visible = ids.filter(
      /** Apply the category filter without hiding unsupported cargo from the unfiltered Sell view. */
      (id) => category === 'all' || (game.catalog.commodities[id].category ?? 'Other') === category
    );
    const rows = visible
      .map(
        /** Render the actual quote, unit size, quantity and feasible trade controls for one good. */
        (id) => {
          const good = game.catalog.commodities[id];
          const price = marketPrice(profile, id, direction);
          const limit = marketLimit(ctx, id, direction);
          const owned = ctx.ship.cargo[id] ?? 0;
          const accepted = price !== null;
          const reason = !accepted
            ? 'Not accepted at this station'
            : direction === 'buy' && !stock.stock[id]
              ? 'Out of stock'
              : limit === 0
                ? 'Insufficient credits or cargo space'
                : '';
          return `<section class="market-good ${!accepted ? 'unavailable' : ''}"><div><b>${esc(good.name)}</b><strong>${accepted ? `${price} cr / unit` : 'No buyer'}</strong></div><p>${esc(good.description ?? good.category ?? 'Cargo')} · ${good.unitSize} hold space / unit</p><p>${direction === 'buy' ? `Available ${stock.stock[id] ?? 0} · Aboard ${owned}` : `Aboard ${owned} · ${accepted ? 'Station buying' : 'Find another market'}`}</p>${reason ? `<p class="market-reason">${esc(reason)}</p>` : ''}<div class="market-actions"><button class="secondary" data-trade="${direction}" data-good="${esc(id)}" data-limit="${limit}" ${quantity > limit ? 'disabled' : ''}>${direction === 'buy' ? 'Buy' : 'Sell'} <span data-trade-quantity>${quantity}</span></button><button class="secondary market-max" data-trade="${direction}" data-good="${esc(id)}" data-quantity="${limit}" ${!limit ? 'disabled' : ''}>Max ${limit}</button></div></section>`;
        }
      )
      .join('');
    return `<div class="trade-wallet"><b>${game.captain.credits} cr</b><span>Hold ${cargoUsed(ctx.ship, game.catalog)} / ${definitions[ctx.ship.kind].cargoCapacity}</span></div><div class="market-tabs" role="group" aria-label="Trade direction"><button id="market-buy" aria-pressed="${direction === 'buy'}">Buy goods</button><button id="market-sell" aria-pressed="${direction === 'sell'}">Sell cargo</button></div><p>${esc(profile.description ?? 'This station trades a local selection of goods.')}</p><div class="market-filters"><label for="market-category">Category<select id="market-category"><option value="all">All goods (${ids.length})</option>${categories
      .map(
        /** Render only category choices represented in this station or cargo view. */
        (name) =>
          `<option value="${esc(name)}" ${name === category ? 'selected' : ''}>${esc(name)}</option>`
      )
      .join(
        ''
      )}</select></label><label class="quantity-label" for="trade-quantity">Quantity<input id="trade-quantity" type="number" min="1" max="1000" step="1" value="${quantity}" inputmode="numeric"></label></div>${rows || `<p class="market-empty">${direction === 'sell' ? 'Your hold is empty. Captured cargo will appear here.' : 'No goods in this category.'}</p>`}<p class="dialog-footer">${direction === 'buy' ? 'Only this station’s sale inventory is listed. Max respects your credits and free hold space.' : 'All carried cargo is shown. Unwanted goods stay aboard until you find a buyer.'} Trading is final at the displayed price.</p>`;
  },
  /** Dispatch validated trades and redraw only when a view/filter or completed operation changes. */
  bind(game, result) {
    /** Switch to buying without issuing a transaction or altering game state. */
    $('market-buy').onclick = () => {
      direction = 'buy';
      category = 'all';
      result({ ok: true, message: '' });
    };
    /** Switch to the player's cargo and show which goods this station accepts. */
    $('market-sell').onclick = () => {
      direction = 'sell';
      category = 'all';
      result({ ok: true, message: '' });
    };
    /** Filter the current direction's visible goods without changing inventory. */
    $<HTMLSelectElement>('market-category').onchange = () => {
      category = $<HTMLSelectElement>('market-category').value;
      result({ ok: true, message: '' });
    };
    /** Refresh quantity labels and availability locally, avoiding input focus loss on each keystroke. */
    $<HTMLInputElement>('trade-quantity').oninput = () => {
      const value = Number($<HTMLInputElement>('trade-quantity').value);
      const valid = Number.isSafeInteger(value) && value >= 1 && value <= 1000;
      if (valid) quantity = value;
      for (const button of Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-limit]')
      )) {
        button.disabled = !valid || value > Number(button.dataset.limit);
        const label = button.querySelector('[data-trade-quantity]');
        if (label) label.textContent = valid ? String(value) : '—';
      }
    };
    /** Commit the requested quantity or this row's currently feasible maximum through the session. */
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-trade]')))
      button.onclick = () => {
        const amount =
          button.dataset.quantity === undefined
            ? Number($<HTMLInputElement>('trade-quantity').value)
            : Number(button.dataset.quantity);
        result(
          game.dispatch({
            type: 'service',
            kind: 'market',
            payload: {
              commodityId: button.dataset.good,
              direction: button.dataset.trade,
              quantity: amount
            }
          })
        );
      };
  }
};
