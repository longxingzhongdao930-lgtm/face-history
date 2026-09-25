// バックアップ形式の検証。サーバーとスマホ版（ブラウザ）で共有する。
import { isValidDescriptor } from './matcher.js';

/** base64 → バイト列（Node では Buffer、ブラウザでは Uint8Array） */
function decodeBase64(b64) {
  if (globalThis.Buffer) return globalThis.Buffer.from(b64, 'base64');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * バックアップファイル（JSON）の形式:
 * {
 *   format: 'face-history-backup', version: 1, createdAt,
 *   users:     [{ id, name, descriptors, createdAt, updatedAt }],
 *   history:   [{ id, timestamp, type, result, ... }],
 *   snapshots: { [historyId]: '<JPEG の base64>' }   // 含めない場合は {}
 * }
 */
export const BACKUP_FORMAT = 'face-history-backup';
export const BACKUP_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_TYPES = new Set(['auth', 'register', 'samples', 'delete', 'backup', 'restore']);
const HISTORY_RESULTS = new Set(['success', 'failure']);
const MAX_NAME_LENGTH = 50;
const MAX_TEXT_LENGTH = 500;
const MAX_SNAPSHOT_BYTES = 300 * 1024;

export class BackupError extends Error {}

const isIsoDate = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const optionalText = (v, max = MAX_TEXT_LENGTH) =>
  v == null ? undefined : typeof v === 'string' && v.length <= max ? v : null;

/** 履歴 1 件を検証し、既知のフィールドだけを取り出す */
function normalizeHistory(h, i) {
  const where = `履歴 ${i + 1} 件目`;
  if (!h || typeof h !== 'object') throw new BackupError(`${where}: 形式が不正です`);
  // id はスナップショットのファイル名に使うため厳密に検証する
  if (typeof h.id !== 'string' || !UUID_RE.test(h.id)) throw new BackupError(`${where}: id が不正です`);
  if (!isIsoDate(h.timestamp)) throw new BackupError(`${where}: timestamp が不正です`);
  if (!HISTORY_TYPES.has(h.type)) throw new BackupError(`${where}: type が不正です`);
  if (!HISTORY_RESULTS.has(h.result)) throw new BackupError(`${where}: result が不正です`);

  const out = { id: h.id, timestamp: h.timestamp, type: h.type, result: h.result };
  for (const key of ['userId', 'userName', 'candidateId', 'candidateName', 'liveness', 'reason', 'detail']) {
    const v = optionalText(h[key]);
    if (v === null) throw new BackupError(`${where}: ${key} が不正です`);
    if (v !== undefined) out[key] = v;
  }
  if (h.distance != null) {
    if (typeof h.distance !== 'number' || !Number.isFinite(h.distance)) {
      throw new BackupError(`${where}: distance が不正です`);
    }
    out.distance = h.distance;
  }
  return out;
}

function normalizeUser(u, i, maxSamples) {
  const where = `ユーザー ${i + 1} 件目`;
  if (!u || typeof u !== 'object') throw new BackupError(`${where}: 形式が不正です`);
  if (typeof u.id !== 'string' || !UUID_RE.test(u.id)) throw new BackupError(`${where}: id が不正です`);
  const name = typeof u.name === 'string' ? u.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) throw new BackupError(`${where}: 名前が不正です`);
  if (!Array.isArray(u.descriptors) || u.descriptors.length === 0 || !u.descriptors.every(isValidDescriptor)) {
    throw new BackupError(`${where}（${name}）: 顔データが不正です`);
  }
  if (!isIsoDate(u.createdAt) || !isIsoDate(u.updatedAt)) throw new BackupError(`${where}: 日時が不正です`);
  return {
    id: u.id,
    name,
    descriptors: u.descriptors.slice(-maxSamples),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/**
 * バックアップの内容を検証して正規化する。不正な場合は BackupError を投げる。
 * @returns {{ users: object[], history: object[], snapshots: Map<string, Buffer> }}
 */
export function parseBackup(data, { maxSamples = 10 } = {}) {
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) {
    throw new BackupError('face-history のバックアップファイルではありません');
  }
  if (data.version !== BACKUP_VERSION) {
    throw new BackupError(`対応していないバージョンです（${data.version}）`);
  }
  if (!Array.isArray(data.users) || !Array.isArray(data.history)) {
    throw new BackupError('users / history がありません');
  }

  const users = data.users.map((u, i) => normalizeUser(u, i, maxSamples));
  const ids = new Set();
  const names = new Set();
  for (const u of users) {
    if (ids.has(u.id)) throw new BackupError(`ユーザー id が重複しています（${u.id}）`);
    if (names.has(u.name)) throw new BackupError(`ユーザー名が重複しています（${u.name}）`);
    ids.add(u.id);
    names.add(u.name);
  }

  const history = data.history.map(normalizeHistory);
  const historyIds = new Set();
  for (const h of history) {
    if (historyIds.has(h.id)) throw new BackupError(`履歴 id が重複しています（${h.id}）`);
    historyIds.add(h.id);
  }

  const snapshots = new Map();
  const rawSnapshots = data.snapshots ?? {};
  if (typeof rawSnapshots !== 'object' || Array.isArray(rawSnapshots)) {
    throw new BackupError('snapshots の形式が不正です');
  }
  for (const [id, b64] of Object.entries(rawSnapshots)) {
    // 履歴にないスナップショットは取り込まない（id の検証も兼ねる）
    if (!historyIds.has(id)) continue;
    if (typeof b64 !== 'string') throw new BackupError(`スナップショット（${id}）の形式が不正です`);
    const buf = decodeBase64(b64);
    if (buf.length > MAX_SNAPSHOT_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      throw new BackupError(`スナップショット（${id}）が JPEG ではないか大きすぎます`);
    }
    snapshots.set(id, buf);
  }
  for (const h of history) h.hasSnapshot = snapshots.has(h.id);

  return { users, history, snapshots };
}
