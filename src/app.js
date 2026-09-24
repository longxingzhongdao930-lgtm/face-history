import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, verifyFrames } from '../public/shared/liveness.js';
import { ChallengeStore } from './challenges.js';
import { euclideanDistance, findBestMatch, isValidDescriptor } from './matcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACE_API_DIR = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api');

const MAX_NAME_LENGTH = 50;
const MAX_SNAPSHOT_BYTES = 300 * 1024;
const MAX_CHECKPOINTS = 10;
/** クライアントとサーバーの時刻処理の差を吸収する許容誤差 */
const CLOCK_SLACK_MS = 2000;

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

/**
 * ライブネスの証跡を検証する。
 * @returns {string|null} 失敗理由（成功なら null）
 */
function checkLiveness(challenge, evidence, descriptor, { consistency, now }) {
  const { frames, checkpoints } = evidence;
  const result = verifyFrames(challenge.actions, frames);
  if (!result.ok) return result.reason;

  // 記録された時間がチャレンジ発行からの経過時間を超えることはない
  const span = frames.at(-1).t - frames[0].t;
  if (span > now - challenge.issuedAt + CLOCK_SLACK_MS) return 'フレームの時刻が不正です';

  // 動作中の顔と最終的に照合する顔が同一人物か（途中で写真に差し替えていないか）
  if (
    !Array.isArray(checkpoints) ||
    checkpoints.length < 1 ||
    checkpoints.length > MAX_CHECKPOINTS ||
    !checkpoints.every(isValidDescriptor)
  ) {
    return '動作中の顔データが不正です';
  }
  if (checkpoints.some((c) => euclideanDistance(c, descriptor) > consistency)) {
    return '動作中に別の顔が検出されました';
  }
  return null;
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
export function createApp(
  store,
  {
    threshold = 0.5,
    maxSamples = 10,
    liveness = true,
    livenessConsistency = 0.6,
    challenges = new ChallengeStore(),
  } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---- static ----
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor/face-api', express.static(path.join(FACE_API_DIR, 'dist')));
  app.use('/models', express.static(path.join(FACE_API_DIR, 'model')));

  // ---- api ----
  const api = express.Router();

  api.get('/config', (req, res) => {
    res.json({ threshold, maxSamples, liveness, challengeTtlMs: challenges.ttlMs });
  });

  // ライブネス検知: ランダムな動作指示を発行
  api.post('/liveness/challenge', (req, res) => {
    if (!liveness) throw new HttpError(404, 'ライブネス検知は無効です');
    const c = challenges.issue();
    res.status(201).json({
      id: c.id,
      actions: c.actions.map((id) => ({ id, label: ACTIONS[id] })),
      expiresAt: new Date(c.expiresAt).toISOString(),
      ttlMs: challenges.ttlMs,
    });
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

    let livenessStatus = 'skipped';
    let livenessReason = null;
    if (liveness) {
      const evidence = req.body.liveness;
      if (!evidence || typeof evidence !== 'object') {
        throw new HttpError(400, 'ライブネス検知の結果（liveness）が必要です');
      }
      const challenge = challenges.consume(evidence.challengeId);
      if (!challenge) {
        throw new HttpError(400, 'チャレンジが無効か期限切れです。もう一度やり直してください');
      }
      livenessReason = checkLiveness(challenge, evidence, descriptor, {
        consistency: livenessConsistency,
        now: Date.now(),
      });
      livenessStatus = livenessReason ? 'failed' : 'passed';
    }

    const match = findBestMatch(descriptor, store.listUsers(), threshold);
    const distance = match.distance == null ? null : Number(match.distance.toFixed(4));
    const success = match.matched && livenessStatus !== 'failed';

    const entry = {
      type: 'auth',
      result: success ? 'success' : 'failure',
      userId: success ? match.user.id : null,
      userName: success ? match.user.name : null,
      distance,
      liveness: livenessStatus,
    };
    if (!success) {
      entry.reason = livenessStatus === 'failed' ? 'liveness' : 'no_match';
      if (livenessReason) entry.detail = livenessReason;
      // なりすまし疑いの場合、誰の顔が提示されたかを記録する
      if (livenessStatus === 'failed' && match.matched) {
        entry.candidateId = match.user.id;
        entry.candidateName = match.user.name;
      }
    }
    const record = await store.addHistory(entry, snapshot);

    res.json({
      result: record.result,
      reason: record.reason ?? null,
      detail: record.detail ?? null,
      liveness: livenessStatus,
      user: success ? publicUser(match.user) : null,
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
