// スマホ版のデータ保存（ブラウザの IndexedDB）。データは端末の外に出ない。
//   users:   { id, name, descriptors, createdAt, updatedAt }
//   history: { id, timestamp, type, result, userName?, distance?, liveness?, reason?, detail?, snapshot? }
//            snapshot は認証時の顔サムネイル（JPEG の base64）
//   meta:    { key, value }（復元前のデータの退避など）
import { BACKUP_FORMAT, BACKUP_VERSION } from './shared/backup-format.js';

const DB_NAME = 'face-history';
const MAX_HISTORY = 2000;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('users', { keyPath: 'id' });
      db.createObjectStore('history', { keyPath: 'id' }).createIndex('timestamp', 'timestamp');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存に失敗しました'));
  });

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function getAll(store) {
  const db = await open();
  return request(db.transaction(store).objectStore(store).getAll());
}

async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
  return value;
}

// ---------------------------------------------------------------- users

export async function listUsers() {
  const users = await getAll('users');
  return users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addUser({ name, descriptors }) {
  const now = new Date().toISOString();
  return put('users', { id: crypto.randomUUID(), name, descriptors, createdAt: now, updatedAt: now });
}

export async function addSamples(id, descriptors, maxSamples) {
  const db = await open();
  const user = await request(db.transaction('users').objectStore('users').get(id));
  if (!user) return null;
  user.descriptors = [...user.descriptors, ...descriptors].slice(-maxSamples);
  user.updatedAt = new Date().toISOString();
  return put('users', user);
}

export async function deleteUser(id) {
  const db = await open();
  const tx = db.transaction('users', 'readwrite');
  tx.objectStore('users').delete(id);
  await done(tx);
}

// ---------------------------------------------------------------- history

export async function addHistory(entry, snapshot = null) {
  const record = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...entry };
  if (snapshot) record.snapshot = snapshot;
  await put('history', record);
  await trimHistory();
  return record;
}

async function trimHistory() {
  const db = await open();
  const tx = db.transaction('history', 'readwrite');
  const store = tx.objectStore('history');
  const count = await request(store.count());
  let excess = count - MAX_HISTORY;
  if (excess > 0) {
    // 古い順に削除
    const cursorReq = store.index('timestamp').openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && excess > 0) {
        cursor.delete();
        excess -= 1;
        cursor.continue();
      }
    };
  }
  await done(tx);
}

/** 新しい順に返す */
export async function listHistory({ type, result } = {}) {
  let items = await getAll('history');
  if (type) items = items.filter((h) => h.type === type);
  if (result) items = items.filter((h) => h.result === result);
  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function clearHistory() {
  const db = await open();
  const tx = db.transaction('history', 'readwrite');
  tx.objectStore('history').clear();
  await done(tx);
}

// ---------------------------------------------------------------- backup

/** PC 版と同じ形式のバックアップを作る */
export async function exportData({ includeSnapshots = true } = {}) {
  const [users, history] = await Promise.all([listUsers(), getAll('history')]);
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const snapshots = {};
  const plain = history.map(({ snapshot, ...h }) => {
    if (includeSnapshots && snapshot) snapshots[h.id] = snapshot;
    return h;
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    users,
    history: plain,
    snapshots,
  };
}

const toBase64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
};

/**
 * parseBackup で検証済みのデータを取り込む。
 *   replace: すべて置き換える（置き換え前のデータは meta に退避し、取り消せるようにする）
 *   merge:   無いユーザー・履歴だけ追加する（同じ id・同じ名前のユーザーは追加しない）
 */
export async function restoreData({ users, history, snapshots }, { mode = 'replace' } = {}) {
  const current = await exportData();
  let addUsers = users;
  let addHistory = history;
  const skippedUsers = [];
  if (mode === 'merge') {
    const ids = new Set(current.users.map((u) => u.id));
    const names = new Set(current.users.map((u) => u.name));
    addUsers = users.filter((u) => {
      const ok = !ids.has(u.id) && !names.has(u.name);
      if (!ok) skippedUsers.push(u.name);
      return ok;
    });
    const historyIds = new Set(current.history.map((h) => h.id));
    addHistory = history.filter((h) => !historyIds.has(h.id));
  }

  const db = await open();
  const tx = db.transaction(['users', 'history', 'meta'], 'readwrite');
  if (mode === 'replace') {
    tx.objectStore('meta').put({ key: 'preRestore', value: current });
    tx.objectStore('users').clear();
    tx.objectStore('history').clear();
  }
  for (const u of addUsers) tx.objectStore('users').put(u);
  for (const { hasSnapshot, ...h } of addHistory) {
    const snap = snapshots.get(h.id);
    tx.objectStore('history').put(snap ? { ...h, snapshot: toBase64(snap) } : h);
  }
  await done(tx);
  await trimHistory();
  return { users: addUsers.length, history: addHistory.length, skippedUsers };
}

export async function getPreRestore() {
  const db = await open();
  const row = await request(db.transaction('meta').objectStore('meta').get('preRestore'));
  return row?.value ?? null;
}

export async function clearPreRestore() {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete('preRestore');
  await done(tx);
}

/** すべてのデータを削除する */
export async function deleteAll() {
  const db = await open();
  const tx = db.transaction(['users', 'history', 'meta'], 'readwrite');
  for (const s of ['users', 'history', 'meta']) tx.objectStore(s).clear();
  await done(tx);
}
