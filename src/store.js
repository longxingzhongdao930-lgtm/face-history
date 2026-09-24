import { randomUUID } from 'node:crypto';
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
