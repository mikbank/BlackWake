import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  IndexedDbSaveStore,
  SaveCoordinator,
  MemorySaveStore,
  migrateBrowserSaves,
  type SaveStore
} from './game/save-store';
/**
 * Verify the scenario: IndexedDB commits both independent slots and survives
 * closing/reopening the connection.
 */
test('IndexedDB commits both independent slots and survives closing/reopening the connection', async () => {
  const factory = new IDBFactory(),
    store = await IndexedDbSaveStore.open(factory),
    saves = new SaveCoordinator(store);
  assert.equal(await saves.read('trading'), null);
  await Promise.all([
    saves.write('trading', 'first'),
    saves.write('raid', 'raid'),
    saves.write('trading', 'latest')
  ]);
  store.close();
  const reopened = await IndexedDbSaveStore.open(factory);
  assert.equal(await reopened.read('trading'), 'latest');
  assert.equal(await reopened.read('raid'), 'raid');
  reopened.close();
});
/** Verify the scenario: a failed save is observable and later commits still run in order. */
test('a failed save is observable and later commits still run in order', async () => {
  let count = 0;
  const stored: string[] = [],
    adapter: SaveStore = {
      label: 'test',
      /**
       * Provide the test adapter's slot read operation so storage ordering and failure behavior
       * can be observed without a browser.
       */
      async read() {
        return stored.at(-1) ?? null;
      },
      /**
       * Provide a controllable test write that can fail once before later commits are allowed to
       * succeed.
       */
      async write(_slot, payload) {
        if (++count === 1) throw Error('quota');
        stored.push(payload);
      }
    };
  const saves = new SaveCoordinator(adapter);
  const first = saves.write('trading', 'bad'),
    second = saves.write('trading', 'good');
  await assert.rejects(first, /quota/);
  await second;
  assert.equal(await saves.read('trading'), 'good');
});
/**
 * Verify the scenario: legacy migration validates and upgrades without overwriting
 * existing slots or deleting originals.
 */
test('legacy migration validates and upgrades without overwriting existing slots or deleting originals', async () => {
  const saves = new SaveCoordinator(new MemorySaveStore()),
    values = new Map([
      ['blackwake-v2', 'v2'],
      ['blackwake-v1', 'v1']
    ]);
  const legacy = {
    /**
     * Provide the legacy storage lookup used by the migration test without touching the real
     * browser's saved keys.
     */
    getItem: (key: string) => values.get(key) ?? null
  };
  assert.deepEqual(
    await migrateBrowserSaves(
      saves,
      legacy,
      /**
       * Validate or deliberately reject a legacy payload before the migration test can commit
       * it.
       */
      (s) => 'upgraded ' + s
    ),
    []
  );
  assert.equal(await saves.read('trading'), 'upgraded v2');
  assert.equal(await saves.read('raid'), 'upgraded v1');
  await migrateBrowserSaves(
    saves,
    legacy,
    /**
     * Validate or deliberately reject a legacy payload before the migration test can commit
     * it.
     */
    () => {
      throw Error('must not run');
    }
  );
  assert.equal(values.get('blackwake-v2'), 'v2');
  assert.equal(values.get('blackwake-v1'), 'v1');
});
/** Verify the scenario: bad legacy saves are retained and are never committed as new saves. */
test('bad legacy saves are retained and are never committed as new saves', async () => {
  const saves = new SaveCoordinator(new MemorySaveStore());
  const failures = await migrateBrowserSaves(
    saves,
    {
      /**
       * Provide the legacy storage lookup used by the migration test without touching the real
       * browser's saved keys.
       */
      getItem: (key) => (key === 'blackwake-v2' ? 'corrupt' : null)
    },
    /**
     * Validate or deliberately reject a legacy payload before the migration test can commit
     * it.
     */
    () => {
      throw Error('validation');
    }
  );
  assert.deepEqual(failures, ['trading']);
  assert.equal(await saves.read('trading'), null);
});
