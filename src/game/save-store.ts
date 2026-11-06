/** Durable browser storage is an adapter, never part of the simulation tick. */
export type SaveSlot = 'trading' | 'raid';
/**
 * Persistence capability implemented by browser adapters and test doubles; the simulation
 * depends on this shape rather than a database API.
 */
export interface SaveStore {
  readonly label: string;
  /**
   * Read a serialized save by scenario slot; resolve to null for a missing slot and reject
   * actual storage failures.
   */
  read(slot: SaveSlot): Promise<string | null>;
  /**
   * Commit the entire serialized slot payload; fulfillment means this adapter completed its
   * write.
   */
  write(slot: SaveSlot, payload: string): Promise<void>;
}
/**
 * Persist independent save slots in the browser's transactional IndexedDB database,
 * outside the simulation loop.
 */
export class IndexedDbSaveStore implements SaveStore {
  readonly label = 'IndexedDB';
  /** Retain the open IndexedDB connection used to create short-lived transactions. */
  constructor(private db: IDBDatabase) {}
  /**
   * Open or initialize the save database and reject unavailable, failed or blocked upgrades
   * rather than claim durable saving succeeded.
   */
  static open(factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbSaveStore> {
    /**
     * Translate IndexedDB's event-driven open request into a Promise consumed by the adapter
     * selector.
     */
    return new Promise((resolve, reject) => {
      if (!factory) {
        reject(Error('IndexedDB unavailable'));
        return;
      }
      const request = factory.open('blackwake', 1);
      let settled = false;
      /** Create the keyed save store during the initial IndexedDB schema upgrade. */
      request.onupgradeneeded = () => {
        request.result.createObjectStore('saves', { keyPath: 'slot' });
      };
      /**
       * Reject opening when another tab blocks the schema upgrade; a later success must close
       * its unused connection.
       */
      request.onblocked = () => {
        settled = true;
        reject(Error('Save database upgrade is blocked by another open game tab.'));
      };
      /**
       * Reject the database-opening promise with the browser's error, preserving the failure for
       * fallback selection.
       */
      request.onerror = () => reject(request.error ?? Error('Cannot open save database.'));
      /**
       * Complete database opening or close a connection that arrived after the operation had
       * already failed.
       */
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        const db = request.result;
        /** Close this tab's connection so a later database upgrade is not blocked by an idle game. */
        db.onversionchange = () => db.close();
        resolve(new IndexedDbSaveStore(db));
      };
    });
  }
  /** Read a slot in a readonly transaction and resolve only after the transaction completes. */
  read(slot: SaveSlot): Promise<string | null> {
    /**
     * Translate the read transaction's completion and abort events into one asynchronous slot
     * result.
     */
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('saves', 'readonly'),
        r = tx.objectStore('saves').get(slot);
      /**
       * Resolve the saved payload only after the read transaction succeeds; a missing slot
       * returns null.
       */
      tx.oncomplete = () => resolve(r.result?.payload ?? null);
      /**
       * Reject an aborted read so callers do not mistake a storage failure for an empty save
       * slot.
       */
      tx.onabort = () => reject(tx.error ?? Error('Save read failed.'));
      /**
       * Let transaction abort report the final failure once, avoiding competing error completion
       * paths.
       */
      tx.onerror = () => {};
    });
  }
  /**
   * Queue a readwrite transaction containing the complete serialized session and a commit
   * timestamp.
   */
  write(slot: SaveSlot, payload: string): Promise<void> {
    /**
     * Translate transaction commit or abort into the write Promise, rather than resolve when
     * the request is merely queued.
     */
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put({ slot, payload, savedAt: Date.now() });
      /**
       * Resolve a write only after IndexedDB commits the transaction, not merely after its
       * request was queued.
       */
      tx.oncomplete = () => resolve();
      /** Reject an aborted write so the UI can report that progress was not committed. */
      tx.onabort = () => reject(tx.error ?? Error('Save transaction failed.'));
      /**
       * Let transaction abort report the final failure once, avoiding competing error completion
       * paths.
       */
      tx.onerror = () => {};
    });
  }
  /** Release the IndexedDB connection when the adapter is no longer needed. */
  close() {
    this.db.close();
  }
}
/**
 * Adapt browser localStorage to the asynchronous save contract when IndexedDB cannot be
 * opened.
 */
export class LocalSaveStore implements SaveStore {
  readonly label = 'Browser local storage';
  /**
   * Retain the browser storage adapter; its availability is probed before this fallback is
   * selected.
   */
  constructor(private storage: Storage) {}
  /**
   * Read the legacy-compatible localStorage key for a slot; async exposes the same Promise
   * contract as IndexedDB.
   */
  async read(slot: SaveSlot) {
    return this.storage.getItem(`blackwake-save-${slot}`);
  }
  /**
   * Replace the slot's localStorage payload; storage exceptions propagate to the save-status
   * UI.
   */
  async write(slot: SaveSlot, payload: string) {
    this.storage.setItem(`blackwake-save-${slot}`, payload);
  }
}
/** Keep saves only for this running page when durable browser storage is unavailable. */
export class MemorySaveStore implements SaveStore {
  readonly label = 'Session only';
  private slots = new Map<SaveSlot, string>();
  /** Read an in-memory slot, returning null when no save exists in this page session. */
  async read(slot: SaveSlot) {
    return this.slots.get(slot) ?? null;
  }
  /** Replace the slot's session-only payload without claiming it survives closing the page. */
  async write(slot: SaveSlot, payload: string) {
    this.slots.set(slot, payload);
  }
}
/**
 * Serialize writes and reads so autosave, import and scenario switches cannot commit out
 * of order.
 */
export class SaveCoordinator {
  private pending: Promise<void> = Promise.resolve();
  /** Retain the selected persistence adapter and initialize the ordered write queue. */
  constructor(readonly store: SaveStore) {}
  /**
   * Append a save to the commit queue and return its own result; recover the queue after a
   * failure so later writes still run.
   */
  write(slot: SaveSlot, payload: string) {
    const write = this.pending.then(
      /** Start this adapter write only after earlier queued writes have settled. */
      () => this.store.write(slot, payload)
    );
    this.pending = write.catch(
      /**
       * Recover the shared queue after a rejected write while preserving that write's rejection
       * for its caller.
       */
      () => {}
    );
    return write;
  }
  /**
   * Wait for earlier writes before reading, so callers receive the latest committed save in
   * this session.
   */
  async read(slot: SaveSlot) {
    await this.pending;
    return this.store.read(slot);
  }
  /**
   * Return the current queue promise so callers can wait until all scheduled writes have
   * settled.
   */
  flush() {
    return this.pending;
  }
}
/**
 * Select IndexedDB, localStorage or session memory in that order and return an honest
 * persistence notice.
 */
export async function openBrowserSaves(): Promise<{ saves: SaveCoordinator; notice: string }> {
  try {
    return { saves: new SaveCoordinator(await IndexedDbSaveStore.open()), notice: '' };
  } catch {}
  try {
    const storage = globalThis.localStorage;
    storage.setItem('blackwake-storage-probe', '1');
    storage.removeItem('blackwake-storage-probe');
    return {
      saves: new SaveCoordinator(new LocalSaveStore(storage)),
      notice: 'IndexedDB is unavailable. Saves use browser local storage.'
    };
  } catch {
    return {
      saves: new SaveCoordinator(new MemorySaveStore()),
      notice:
        'Browser storage is unavailable. Progress lasts only for this session; use Export save to keep it.'
    };
  }
}
/**
 * Upgrade legacy save keys only when their target slots are empty, retaining original data
 * and reporting failed migrations.
 */
export async function migrateBrowserSaves(
  saves: SaveCoordinator,
  legacy: Pick<Storage, 'getItem'>,
  upgrade: (raw: string) => string
) {
  const failures: string[] = [];
  for (const slot of ['trading', 'raid'] as const) {
    try {
      if (await saves.read(slot)) continue;
      const raw =
        legacy.getItem(slot === 'trading' ? 'blackwake-v2' : 'blackwake-raid-v2') ??
        (slot === 'raid' ? legacy.getItem('blackwake-v1') : null);
      if (raw) await saves.write(slot, upgrade(raw));
    } catch {
      failures.push(slot);
    }
  }
  return failures;
}
