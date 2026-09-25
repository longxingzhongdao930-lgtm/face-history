import { randomUUID } from 'node:crypto';
import { BACKUP_FORMAT, BACKUP_VERSION } from './backup.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY_DB = { users: [], history: [] };

/**
 * JSON ファイルベースの永続ストア。
 *   <dataDir>/db.json          ユーザー（顔特徴量）と履歴
 *   <dataDir>/snapshots/*.jpg  認証時のスナップショット
 * 書き込みは直列化し、一時ファイル + rename で原子的に保存する。
 */
export class Store {
  constructor(dataDir, { maxHistory = 5000 } = {}) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'db.json');
    this.snapshotDir = path.join(dataDir, 'snapshots');
    this.maxHistory = maxHistory;
    this.db = structuredClone(EMPTY_DB);
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.db = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.#persist();
    }
    return this;
  }

  // ---- users ----

  listUsers() {
    return this.db.users;
  }

  getUser(id) {
    return this.db.users.find((u) => u.id === id) ?? null;
  }

  findUserByName(name) {
    return this.db.users.find((u) => u.name === name) ?? null;
  }

  addUser({ name, descriptors }) {
    return this.#mutate(() => {
      const now = new Date().toISOString();
      const user = { id: randomUUID(), name, descriptors, createdAt: now, updatedAt: now };
      this.db.users.push(user);
      return user;
    });
  }

  addSamples(id, descriptors, maxSamples) {
    return this.#mutate(() => {
      const user = this.getUser(id);
      if (!user) return null;
      user.descriptors = [...user.descriptors, ...descriptors].slice(-maxSamples);
      user.updatedAt = new Date().toISOString();
      return user;
    });
  }

  deleteUser(id) {
    return this.#mutate(() => {
      const before = this.db.users.length;
      this.db.users = this.db.users.filter((u) => u.id !== id);
      return this.db.users.length !== before;
    });
  }

  // ---- history ----

  listHistory({ limit = 100, offset = 0, userId, result, type } = {}) {
    let items = this.db.history;
    if (userId) items = items.filter((h) => h.userId === userId);
    if (result) items = items.filter((h) => h.result === result);
    if (type) items = items.filter((h) => h.type === type);
    // 新しい順
    const sorted = [...items].reverse();
    return { total: sorted.length, items: sorted.slice(offset, offset + limit) };
  }

  getHistory(id) {
    return this.db.history.find((h) => h.id === id) ?? null;
  }

  /**
   * @param {object} entry { type, result, userId, userName, distance }
   * @param {Buffer|null} snapshot JPEG バイナリ
   */
  addHistory(entry, snapshot = null) {
    return this.#mutate(async () => {
      const id = randomUUID();
      let hasSnapshot = false;
      if (snapshot) {
        await fs.writeFile(this.#snapshotPath(id), snapshot);
        hasSnapshot = true;
      }
      const record = { id, timestamp: new Date().toISOString(), ...entry, hasSnapshot };
      this.db.history.push(record);
      const overflow = this.db.history.length - this.maxHistory;
      if (overflow > 0) {
        const removed = this.db.history.splice(0, overflow);
        await this.#removeSnapshots(removed);
      }
      return record;
    });
  }

  clearHistory() {
    return this.#mutate(async () => {
      const removed = this.db.history;
      this.db.history = [];
      await this.#removeSnapshots(removed);
      return removed.length;
    });
  }

  snapshotPath(historyId) {
    const record = this.getHistory(historyId);
    return record?.hasSnapshot ? this.#snapshotPath(record.id) : null;
  }

  // ---- backup / restore ----

  /** 全データをバックアップ形式で書き出す（書き込み中の状態を読まないよう直列化） */
  exportData({ includeSnapshots = true } = {}) {
    return this.#exclusive(async () => {
      const snapshots = {};
      if (includeSnapshots) {
        for (const h of this.db.history) {
          if (!h.hasSnapshot) continue;
          try {
            snapshots[h.id] = (await fs.readFile(this.#snapshotPath(h.id))).toString('base64');
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
          }
        }
      }
      return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        users: structuredClone(this.db.users),
        history: this.db.history.map(({ hasSnapshot, ...h }) => h),
        snapshots,
      };
    });
  }

  /**
   * バックアップ（parseBackup で検証済み）から復元する。
   *   replace: 現在のデータをすべて置き換える
   *   merge:   現在のデータに無いユーザー・履歴だけを追加する（同じ id / 同じ名前のユーザーは追加しない）
   */
  restoreData({ users, history, snapshots }, { mode = 'replace' } = {}) {
    return this.#mutate(async () => {
      let addUsers = users;
      let addHistory = history;
      const skippedUsers = [];
      if (mode === 'replace') {
        await this.#removeSnapshots(this.db.history);
        this.db = { users: [], history: [] };
      } else {
        const ids = new Set(this.db.users.map((u) => u.id));
        const names = new Set(this.db.users.map((u) => u.name));
        addUsers = users.filter((u) => {
          const ok = !ids.has(u.id) && !names.has(u.name);
          if (!ok) skippedUsers.push(u.name);
          return ok;
        });
        const historyIds = new Set(this.db.history.map((h) => h.id));
        addHistory = history.filter((h) => !historyIds.has(h.id));
      }

      for (const h of addHistory) {
        if (h.hasSnapshot) await fs.writeFile(this.#snapshotPath(h.id), snapshots.get(h.id));
      }
      this.db.users.push(...addUsers);
      this.db.history.push(...addHistory);
      this.db.history.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      const overflow = this.db.history.length - this.maxHistory;
      if (overflow > 0) await this.#removeSnapshots(this.db.history.splice(0, overflow));

      return { users: addUsers.length, history: addHistory.length, skippedUsers };
    });
  }

  // ---- internals ----

  #snapshotPath(id) {
    return path.join(this.snapshotDir, `${id}.jpg`);
  }

  async #removeSnapshots(records) {
    await Promise.all(
      records
        .filter((r) => r.hasSnapshot)
        .map((r) => fs.rm(this.#snapshotPath(r.id), { force: true })),
    );
  }

  /** 書き込みと同じ列に並べて実行する（永続化はしない） */
  #exclusive(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  #mutate(fn) {
    const run = this.queue.then(async () => {
      const result = await fn();
      await this.#persist();
      return result;
    });
    // 失敗しても後続の書き込みを止めない
    this.queue = run.catch(() => {});
    return run;
  }

  async #persist() {
    const tmp = `${this.dbPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.db));
    await fs.rename(tmp, this.dbPath);
  }
}
