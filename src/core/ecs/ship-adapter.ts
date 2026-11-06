import { freshDefence, type Ship } from '../model';
import { freshCruise, type SpatialComponents, type CombatBody } from './components';
import { EntityStore } from './store';

type Store = EntityStore<SpatialComponents>;
/** The bindings are lifecycle metadata; they are neither serialized nor a second hull-state store. */
const bindings = new WeakMap<Ship, Store>();
const fields = {
  position: ['transform', 'position'],
  heading: ['transform', 'heading'],
  velocity: ['motion', 'velocity'],
  kind: ['hull', 'kind'],
  hull: ['hull', 'health'],
  owner: ['ownership', 'owner'],
  factionId: ['ownership', 'factionId'],
  role: ['ownership', 'role'],
  engines: ['propulsion', 'condition'],
  reload: ['broadside', 'reload'],
  cargo: ['cargo', 'goods'],
  crew: ['crew', 'count'],
  name: ['appearance', 'name'],
  designId: ['appearance', 'designId'],
  livery: ['appearance', 'livery']
} as const;

/** Register a plain domain hull as component data while preserving the actor's existing record identity. */
export function attachShip(store: Store, ship: Ship) {
  const previous = bindings.get(ship);
  if (previous === store && store.get(ship.id, 'ship')?.record === ship) return;
  if (previous) detachShip(previous, ship);
  if (store.has(ship.id)) throw Error(`Entity already exists: ${ship.id}`);
  store.create(ship.id, {
    transform: { position: ship.position, heading: ship.heading },
    motion: { velocity: ship.velocity },
    hull: { kind: ship.kind, health: ship.hull },
    ownership: { owner: ship.owner, factionId: ship.factionId, role: ship.role },
    propulsion: { condition: ship.engines },
    broadside: { reload: ship.reload },
    cargo: { goods: ship.cargo },
    crew: { count: ship.crew },
    appearance: { name: ship.name, designId: ship.designId, livery: ship.livery },
    pointDefence: freshDefence(),
    cruise: freshCruise(),
    control: { input: { turn: 0, thrust: 0, brake: true, fire: false } },
    ship: { record: ship }
  });
  for (const [key, [component, field]] of Object.entries(fields)) {
    const enumerable = Object.prototype.propertyIsEnumerable.call(ship, key);
    Object.defineProperty(ship, key, {
      configurable: true,
      enumerable,
      /** Read current component data, including a component replaced by an extension system. */
      get() {
        const value = store.get(ship.id, component);
        if (!value && component === 'propulsion') return 0;
        if (!value && component === 'broadside') return [0, 0];
        return (store.require(ship.id, component) as unknown as Record<string, unknown>)[field];
      },
      /** Apply domain writes to existing capabilities; damage cannot reinstall removed propulsion or weapons. */
      set(value: unknown) {
        if (!store.get(ship.id, component)) {
          if (component === 'propulsion' || component === 'broadside') return;
        }
        (store.require(ship.id, component) as unknown as Record<string, unknown>)[field] = value;
        if (!enumerable) Object.defineProperty(ship, key, { enumerable: true });
      }
    });
  }
  const id = ship.id;
  Object.defineProperty(ship, 'id', {
    enumerable: true,
    configurable: true,
    /** Entity identity remains stable while the hull belongs to a spatial world. */
    get() {
      return id;
    },
    /** Reject ID mutation rather than silently orphan component storage. */
    set(value: string) {
      if (value !== id) throw Error('A live entity ID cannot be changed.');
    }
  });
  bindings.set(ship, store);
}

/** Restore plain field descriptors before a structural removal, without recursively destroying the entity. */
export function restoreShip(store: Store, ship: Ship) {
  if (bindings.get(ship) !== store) return;
  const values = { ...ship };
  for (const key of [...Object.keys(fields), 'id']) {
    if (Object.hasOwn(values, key))
      Object.defineProperty(ship, key, {
        value: values[key as keyof Ship],
        writable: true,
        configurable: true,
        enumerable: true
      });
    else delete (ship as unknown as Record<string, unknown>)[key];
  }
  bindings.delete(ship);
}
/** Return a departing actor to plain data and remove its old spatial identity. */
export function detachShip(store: Store, ship: Ship) {
  if (bindings.get(ship) !== store) return;
  restoreShip(store, ship);
  store.destroy(ship.id);
}

/** Project component-only combat entities without requiring crew, cargo, appearance or a domain ship record. */
export function combatBody(store: Store, id: string): CombatBody {
  const view = { id } as CombatBody;
  for (const key of [
    'position',
    'heading',
    'velocity',
    'kind',
    'hull',
    'owner',
    'factionId',
    'role',
    'engines',
    'reload'
  ] as const) {
    const [component, field] = fields[key];
    Object.defineProperty(view, key, {
      enumerable: true,
      /** Resolve live data so replacing a component never leaves a cached body projection stale. */
      get() {
        if (component === 'propulsion' && !store.get(id, component)) return 0;
        if (component === 'broadside' && !store.get(id, component)) return [0, 0];
        return (store.require(id, component) as unknown as Record<string, unknown>)[field];
      },
      /** Preserve physical algorithms' mutation semantics while keeping the component authoritative. */
      set(value: unknown) {
        if ((component === 'propulsion' || component === 'broadside') && !store.get(id, component))
          return;
        (store.require(id, component) as unknown as Record<string, unknown>)[field] = value;
      }
    });
  }
  return view;
}
