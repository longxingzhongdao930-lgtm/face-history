import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBestMatch, isValidDescriptor } from './matcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACE_API_DIR = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api');

const MAX_NAME_LENGTH = 50;
const MAX_SNAPSHOT_BYTES = 300 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    samples: user.descriptors.length,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function parseDescriptors(value, maxSamples) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxSamples) {
    throw new HttpError(400, `descriptors は 1〜${maxSamples} 件の配列で指定してください`);
  }
  if (!value.every(isValidDescriptor)) {
    throw new HttpError(400, 'descriptors の形式が不正です（128 次元の数値配列が必要）');
  }
  return value;
}

function parseSnapshot(value) {
  if (value == null || value === '') return null;
  const m = typeof value === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) throw new HttpError(400, 'snapshot は JPEG の data URL で指定してください');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_SNAPSHOT_BYTES) throw new HttpError(413, 'snapshot が大きすぎます');
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new HttpError(400, 'snapshot が JPEG ではありません');
  }
  return buf;
}

function parseLimit(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/**
 * @param {import('./store.js').Store} store
 * @param {{ threshold?: number, maxSamples?: number }} options
 */
export function createApp(store, { threshold = 0.5, maxSamples = 10 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ---- static ----
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor/face-api', express.static(path.join(FACE_API_DIR, 'dist')));
  app.use('/models', express.static(path.join(FACE_API_DIR, 'model')));

  // ---- api ----
  const api = express.Router();

  api.get('/config', (req, res) => {
    res.json({ threshold, maxSamples });
  });

  api.get('/users', (req, res) => {
    res.json(store.listUsers().map(publicUser));
  });

  // 顔登録
  api.post('/users', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new HttpError(400, `名前は 1〜${MAX_NAME_LENGTH} 文字で入力してください`);
    }
    const descriptors = parseDescriptors(req.body.descriptors, maxSamples);

    if (store.findUserByName(name)) {
      throw new HttpError(409, `「${name}」は既に登録されています`);
    }
    // 同一人物の二重登録を防ぐ
    for (const d of descriptors) {
      const match = findBestMatch(d, store.listUsers(), threshold);
      if (match.matched) {
        throw new HttpError(409, `この顔は「${match.user.name}」として既に登録されています`, {
          existingUser: publicUser(match.user),
        });
      }
    }

    const user = await store.addUser({ name, descriptors });
    await store.addHistory({ type: 'register', result: 'success', userId: user.id, userName: user.name });
    res.status(201).json(publicUser(user));
  });

  // 既存ユーザーへのサンプル追加（認証精度の向上用）
  api.post('/users/:id/samples', async (req, res) => {
    const descriptors = parseDescriptors(req.body?.descriptors, maxSamples);
    const user = store.getUser(req.params.id);
    if (!user) throw new HttpError(404, 'ユーザーが見つかりません');
    for (const d of descriptors) {
      const match = findBestMatch(d, store.listUsers(), threshold);
      if (match.matched && match.user.id !== user.id) {
        throw new HttpError(409, `この顔は「${match.user.name}」として登録されています`);
      }
    }
    const updated = await store.addSamples(user.id, descriptors, maxSamples);
    res.json(publicUser(updated));
  });

  api.delete('/users/:id', async (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) throw new HttpError(404, 'ユーザーが見つかりません');
    await store.deleteUser(user.id);
    await store.addHistory({ type: 'delete', result: 'success', userId: user.id, userName: user.name });
    res.status(204).end();
  });

  // 顔認証（結果は必ず履歴に保存）
  api.post('/auth', async (req, res) => {
    const descriptor = req.body?.descriptor;
    if (!isValidDescriptor(descriptor)) {
      throw new HttpError(400, 'descriptor の形式が不正です（128 次元の数値配列が必要）');
    }
    const snapshot = parseSnapshot(req.body.snapshot);
    const match = findBestMatch(descriptor, store.listUsers(), threshold);
    const distance = match.distance == null ? null : Number(match.distance.toFixed(4));

    const record = await store.addHistory(
      {
        type: 'auth',
        result: match.matched ? 'success' : 'failure',
        userId: match.matched ? match.user.id : null,
        userName: match.matched ? match.user.name : null,
        distance,
      },
      snapshot,
    );

    res.json({
      result: record.result,
      user: match.matched ? publicUser(match.user) : null,
      distance,
      threshold,
      historyId: record.id,
    });
  });

  api.get('/history', (req, res) => {
    const { userId, result, type } = req.query;
    const page = store.listHistory({
      limit: parseLimit(req.query.limit, 100, 1000),
      offset: parseLimit(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
      userId: typeof userId === 'string' ? userId : undefined,
      result: result === 'success' || result === 'failure' ? result : undefined,
      type: ['auth', 'register', 'delete'].includes(type) ? type : undefined,
    });
    res.json(page);
  });

  api.get('/history/:id/snapshot', (req, res) => {
    const file = store.snapshotPath(req.params.id);
    if (!file) throw new HttpError(404, 'スナップショットがありません');
    res.type('jpeg').sendFile(file);
  });

  api.delete('/history', async (req, res) => {
    const removed = await store.clearHistory();
    res.json({ removed });
  });

  app.use('/api', api);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'リクエストが大きすぎます' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON の形式が不正です' });
    }
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  });

  return app;
}
