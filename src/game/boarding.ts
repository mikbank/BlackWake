import { definitions, type Ship } from '../core/model';
import type { ContentCatalog } from '../content/catalog';
import { cargoUsed } from './services';

/**
 * Calculate which goods fit in the receiving hold, including commodity sizes, without
 * mutating either ship.
 */
export function cargoTransferPlan(from: Ship, to: Ship, catalog: ContentCatalog) {
  let space = Math.max(0, definitions[to.kind].cargoCapacity - cargoUsed(to, catalog));
  const cargo: Record<string, number> = {};
  let units = 0;
  for (const [id, quantity] of Object.entries(from.cargo)) {
    const size = catalog.commodities[id].unitSize;
    const amount = Math.min(quantity, Math.floor(space / size));
    if (amount > 0) {
      cargo[id] = amount;
      units += amount;
      space -= amount * size;
    }
  }
  return { cargo, units };
}
/**
 * Apply an already calculated transfer plan to both inventories; callers validate
 * eligibility and capacity before committing.
 */
export function transferCargo(from: Ship, to: Ship, cargo: Record<string, number>) {
  for (const [id, quantity] of Object.entries(cargo)) {
    from.cargo[id] -= quantity;
    to.cargo[id] = (to.cargo[id] ?? 0) + quantity;
  }
}
