import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { BackupError, parseBackup, pruneBackups, writeBackupFile } from '../src/backup.js';
import { Store } from '../src/store.js';
import { vec } from './fixtures.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-09-25T00:00:00.000Z';

function sampleBackup(overrides = {}) {
  return {
    format: 'face-history-backup',
    version: 1,
    createdAt: NOW,
    users: [{ id: UUID(1), name: 'Alice', descriptors: [vec(0.1)], createdAt: NOW, updatedAt: NOW }],
    history: [{ id: UUID(2), timestamp: NOW, type: 'auth', result: 'success', userId: UUID(1), userName: 'Alice', distance: 0.1 }],
    snapshots: { [UUID(2)]: JPEG.toString('base64') },
    ...overrides,
  };
}

// ---------------------------------------------------------------- parseBackup

test('parseBackup: 正常なバックアップを正規化する', () => {
  const b = sampleBackup();
  b.history[0].evil = '<script>';
  const { users, history, snapshots } = parseBackup(b);
  assert.equal(users[0].name, 'Alice');
  assert.equal(history[0].hasSnapshot, true);
  assert.equal(history[0].evil, undefined, '未知のフィールドは取り込まない');
  assert.deepEqual(snapshots.get(UUID(2)), JPEG);
});

test('parseBackup: 不正な内容は BackupError', () => {
  const cases = {
    形式違い: { format: 'other' },
    バージョン違い: sampleBackup({ version: 2 }),
    パストラバーサル: sampleBackup({ history: [{ ...sampleBackup().history[0], id: '../../etc/passwd' }] }),
    顔データ不正: sampleBackup({ users: [{ ...sampleBackup().users[0], descriptors: [[1, 2]] }] }),
    名前重複: sampleBackup({ users: [sampleBackup().users[0], { ...sampleBackup().users[0], id: UUID(9) }] }),
    JPEGではない: sampleBackup({ snapshots: { [UUID(2)]: Buffer.from('hello').toString('base64') } }),
    種別不正: sampleBackup({ history: [{ ...sampleBackup().history[0], type: 'hack' }] }),
  };
  for (const [name, data] of Object.entries(cases)) {
    assert.throws(() => parseBackup(data), BackupError, name);
  }
});

test('parseBackup: 履歴にないスナップショットは無視する', () => {
  const { snapshots } = parseBackup(sampleBackup({ snapshots: { [UUID(3)]: JPEG.toString('base64') } }));
  assert.equal(snapshots.size, 0);
});

test('writeBackupFile / pruneBackups: 新しいものを指定件数だけ残す', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-bk-'));
  try {
    const store = await new Store(path.join(dir, 'data')).init();
    const out = path.join(dir, 'backups');
    for (const name of ['auto-2026-01-01.json', 'auto-2026-01-02.json', 'auto-2026-01-03.json', 'other.json']) {
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(path.join(out, name), '{}');
    }
    const file = await writeBackupFile(store, out, 'auto');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).format, 'face-history-backup');
    await pruneBackups(out, 'auto', 2);
    const left = (await fs.readdir(out)).sort();
    assert.deepEqual(left, ['auto-2026-01-03.json', path.basename(file), 'other.json'].sort());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- API

const servers = [];
async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-bkapi-'));
  const store = await new Store(dir).init();
  const server = createApp(store, { liveness: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  servers.push({ server, dir });
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { dir, base, call };
}

let src;
let dst;
let backup;

before(async () => {
  src = await startServer();
  dst = await startServer();
  await src.call('POST', '/api/users', { name: 'Alice', descriptors: [vec(0.1)] });
  await src.call('POST', '/api/users', { name: 'Bob', descriptors: [vec(0.5)] });
  await src.call('POST', '/api/auth', { descriptor: vec(0.1), snapshot: JPEG_URL });
});

after(async () => {
  for (const { server, dir } of servers) {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('GET /api/backup: 全データをファイルとしてダウンロードし、取得を履歴に残す', async () => {
  const res = await src.call('GET', '/api/backup');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="face-history-backup-.*\.json"/);
  backup = res.body;
  assert.equal(backup.users.length, 2);
  assert.equal(backup.users[0].descriptors.length, 1, '顔データを含む');
  assert.equal(Object.keys(backup.snapshots).length, 1);

  const h = (await src.call('GET', '/api/history?type=backup')).body.items[0];
  assert.match(h.detail, /ユーザー 2 件/);

  const noImages = await src.call('GET', '/api/backup?snapshots=0');
  assert.deepEqual(noImages.body.snapshots, {});
});

test('POST /api/backup/restore (replace): 別のサーバーへ復元でき、認証・画像も使える', async () => {
  await dst.call('POST', '/api/users', { name: 'Carol', descriptors: [vec(0.9)] });
  const res = await dst.call('POST', '/api/backup/restore?mode=replace', backup);
  assert.equal(res.status, 200);
  assert.equal(res.body.users, 2);
  assert.match(res.body.preRestoreBackup, /^pre-restore-.*\.json$/);

  // 復元前のデータ（Carol）が退避されている
  const saved = JSON.parse(await fs.readFile(path.join(dst.dir, 'backups', res.body.preRestoreBackup), 'utf8'));
  assert.deepEqual(saved.users.map((u) => u.name), ['Carol']);

  const users = (await dst.call('GET', '/api/users')).body.map((u) => u.name).sort();
  assert.deepEqual(users, ['Alice', 'Bob'], 'Carol は置き換えで消える');
  assert.equal((await dst.call('POST', '/api/auth', { descriptor: vec(0.11) })).body.user.name, 'Alice');

  const auth = (await dst.call('GET', '/api/history?type=auth&result=success')).body.items.find((h) => h.hasSnapshot);
  const snap = await fetch(`${dst.base}/api/history/${auth.id}/snapshot`);
  assert.equal(snap.status, 200);
  assert.deepEqual(Buffer.from(await snap.arrayBuffer()), JPEG);

  const restore = (await dst.call('GET', '/api/history?type=restore')).body.items[0];
  assert.match(restore.detail, /置き換え: ユーザー 2 件/);
});

test('POST /api/backup/restore (merge): 既存と重複するユーザーは追加しない', async () => {
  await dst.call('DELETE', `/api/users/${backup.users.find((u) => u.name === 'Bob').id}`);
  const res = await dst.call('POST', '/api/backup/restore?mode=merge', backup);
  assert.equal(res.body.users, 1, 'Bob だけ追加');
  assert.deepEqual(res.body.skippedUsers, ['Alice']);
  assert.equal(res.body.preRestoreBackup, null);
  assert.equal((await dst.call('GET', '/api/users')).body.length, 2);
});

test('POST /api/backup/restore: 不正なファイルは 400 で、データは変わらない', async () => {
  const before = (await dst.call('GET', '/api/users')).body.length;
  assert.equal((await dst.call('POST', '/api/backup/restore', { format: 'other' })).status, 400);
  assert.equal((await dst.call('POST', '/api/backup/restore', '{broken')).status, 400);
  assert.equal((await dst.call('GET', '/api/users')).body.length, before);
});

test('POST /api/backup/restore: 2MB を超える大きなバックアップも受け付ける', async () => {
  const big = Buffer.alloc(250 * 1024, 0);
  JPEG.copy(big);
  const history = Array.from({ length: 12 }, (_, i) => ({ id: UUID(100 + i), timestamp: NOW, type: 'auth', result: 'failure' }));
  const snapshots = Object.fromEntries(history.map((h) => [h.id, big.toString('base64')]));
  const res = await dst.call('POST', '/api/backup/restore?mode=merge', sampleBackup({ users: [], history, snapshots }));
  assert.equal(res.status, 200);
  assert.equal(res.body.history, 12);
});
