/** Stable domain IDs are also entity IDs; numeric array positions are never persistent identities. */
export type EntityId = string;
/** A typed query row exposes the actual component records, not detached copies. */
export type QueryRow<C, K extends keyof C> = { id: EntityId; components: Pick<C, K> };

/** Small, inspectable ECS storage with one map per component and deterministic entity insertion order. */
export class EntityStore<C extends object> {
  /** Optionally detach external record adapters before their components disappear. */
  constructor(private beforeDestroy?: (id: EntityId) => void) {}
  private updating = false;
  private ids = new Set<EntityId>();
  private stores = new Map<keyof C, Map<EntityId, unknown>>();

  /** Create an identity with optional data components; duplicate identities are always an error. */
  create(id: EntityId, components: Partial<C> = {}) {
    this.assertStructural();
    for (const key of Object.keys(components) as (keyof C)[])
      if (components[key] == null) throw Error(`Missing component data: ${String(key)}`);
    if (!id || this.ids.has(id)) throw Error(`Duplicate or empty entity: ${id}`);
    this.ids.add(id);
    for (const key of Object.keys(components) as (keyof C)[])
      this.set(id, key, components[key] as C[keyof C]);
    return id;
  }
  /** Test identity membership without implying that any particular capability exists. */
  has(id: EntityId) {
    return this.ids.has(id);
  }
  /** Attach or replace a component on an existing entity; data remains owned by this store. */
  set<K extends keyof C>(id: EntityId, key: K, value: C[K]) {
    this.assertStructural();
    if (!this.ids.has(id)) throw Error(`Unknown entity: ${id}`);
    if (value === undefined || value === null)
      throw Error(`Missing component data: ${String(key)}`);
    let store = this.stores.get(key);
    if (!store) {
      store = new Map();
      this.stores.set(key, store);
    }
    store.set(id, value);
    return value;
  }
  /** Read an optional capability; the generic key determines its compile-time data shape. */
  get<K extends keyof C>(id: EntityId, key: K): C[K] | undefined {
    return this.stores.get(key)?.get(id) as C[K] | undefined;
  }
  /** Require a capability at a validated adapter boundary and report broken entity composition explicitly. */
  require<K extends keyof C>(id: EntityId, key: K): C[K] {
    const value = this.get(id, key);
    if (value === undefined) throw Error(`Entity ${id} lacks ${String(key)}`);
    return value;
  }
  /** Remove one capability while retaining identity and all unrelated components. */
  remove<K extends keyof C>(id: EntityId, key: K) {
    this.assertStructural();
    return this.stores.get(key)?.delete(id) ?? false;
  }
  /** Remove an identity and every component, allowing no orphaned component state. */
  destroy(id: EntityId) {
    this.assertStructural();
    if (!this.ids.has(id)) return false;
    this.beforeDestroy?.(id);
    this.ids.delete(id);
    for (const store of this.stores.values()) store.delete(id);
    return true;
  }
  /** Snapshot matching membership in insertion order while retaining live component references. */
  query<const K extends readonly (keyof C)[]>(...keys: K): QueryRow<C, K[number]>[] {
    const rows: QueryRow<C, K[number]>[] = [];
    for (const id of this.ids) {
      const components = {} as Pick<C, K[number]>;
      let match = true;
      for (const key of keys) {
        const value = this.get(id, key);
        if (value === undefined) {
          match = false;
          break;
        }
        components[key as K[number]] = value;
      }
      if (match) rows.push({ id, components });
    }
    return rows;
  }
  /** Preserve a materialization's legacy ship order while leaving non-ship entities deterministic. */
  prioritize(ids: readonly EntityId[]) {
    this.assertStructural();
    if (new Set(ids).size !== ids.length) throw Error('Duplicate ordered entity');
    for (const id of ids) if (!this.has(id)) throw Error(`Unknown entity: ${id}`);
    this.ids = new Set([...ids, ...this.ids]);
  }
  /** Lock entity composition for a tick; systems still mutate their live component data normally. */
  beginUpdate() {
    if (this.updating) throw Error('Nested ECS update');
    this.updating = true;
  }
  /** Release the structural lock before applying deferred entity/component operations. */
  endUpdate() {
    this.updating = false;
  }
  /** Reject mid-tick structural edits and direct extensions toward the explicit command buffer. */
  private assertStructural() {
    if (this.updating) throw Error('Defer structural changes until the end of the ECS tick.');
  }
  /** Count live identities independently of how many components each one owns. */
  get size() {
    return this.ids.size;
  }
}

/** A main-thread phase receives explicit frame resources and changes only its declared domain. */
export type SimulationSystem<Context> = {
  name: string;
  /** Execute one ordered phase; component queries select the entities it affects. */
  update: (context: Context) => void;
};
/** Explicit scheduling preserves deterministic order and keeps registration free of worker or task machinery. */
export class SystemSchedule<Context> {
  private systems: SimulationSystem<Context>[] = [];
  /** Register a uniquely named phase at the end or before an existing phase. */
  add(system: SimulationSystem<Context>, before?: string) {
    if (
      this.systems.some(
        /** Reject duplicate phase names so order remains inspectable. */ (s) =>
          s.name === system.name
      )
    )
      throw Error(`Duplicate system: ${system.name}`);
    const index =
      before === undefined
        ? this.systems.length
        : this.systems.findIndex(
            /** Locate the explicit insertion point for an extension phase. */ (s) =>
              s.name === before
          );
    if (index < 0) throw Error(`Unknown phase: ${before}`);
    this.systems.splice(index, 0, system);
  }
  /** Return an independent ordered name list for diagnostics, documentation and tests. */
  get order() {
    return this.systems.map(
      /** Expose ordering without leaking mutable phase registrations. */ (s) => s.name
    );
  }
  /** Execute a stable phase list; registrations made during a tick apply to the next tick. */
  run(context: Context) {
    for (const system of [...this.systems]) system.update(context);
  }
}

/** Queue structural changes explicitly so phase queries cannot observe half-constructed entities. */
export class EntityCommands {
  private pending: (() => void)[] = [];
  /** Record a lifecycle operation; component-value changes need no command and remain immediate. */
  defer(operation: () => void) {
    this.pending.push(operation);
  }
  /** Apply a FIFO snapshot; commands added while flushing are reserved for the next boundary. */
  flush() {
    const operations = this.pending.splice(0);
    for (const operation of operations) operation();
  }
  /** Discard an incomplete tick's uncommitted lifecycle requests after a failed phase. */
  clear() {
    this.pending = [];
  }
}
