import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';

test('履歴が上限を超えると古いものとスナップショットを削除する', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-store-'));
  try {
    const store = await new Store(dir, { maxHistory: 3 }).init();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const first = await store.addHistory({ type: 'auth', result: 'failure' }, jpeg);
    // 並行書き込みでも欠落しない
    await Promise.all([1, 2, 3].map((i) => store.addHistory({ type: 'auth', result: 'failure', n: i }, jpeg)));
    const { total, items } = store.listHistory();
    assert.equal(total, 3);
    assert.equal(items.some((h) => h.id === first.id), false);
    assert.equal((await fs.readdir(store.snapshotDir)).length, 3);
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'db.json'), 'utf8'));
    assert.equal(persisted.history.length, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
