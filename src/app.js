import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, verifyFrames } from '../public/shared/liveness.js';
import { AdminAuth } from './admin.js';
import { BackupError, backupFileName, parseBackup, writeBackupFile } from './backup.js';
import { ChallengeStore } from './challenges.js';
import { rateLimit, securityHeaders } from './security.js';
import { euclideanDistance, findBestMatch, isValidDescriptor } from './matcher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACE_API_DIR = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api');

const MAX_NAME_LENGTH = 50;
const MAX_SNAPSHOT_BYTES = 300 * 1024;
const MAX_CHECKPOINTS = 10;
const MAX_IDENTIFY_FACES = 10;
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
function checkLiveness(challenge, evidence, descriptors, { consistency, now }) {
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
  if (checkpoints.some((c) => descriptors.some((d) => euclideanDistance(c, d) > consistency))) {
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
    admin = new AdminAuth(),
    trustProxy = false,
    backupDir = path.join(store.dataDir, 'backups'),
    // 誰でも呼べる API（認証・チャレンジ・ログイン）の IP ごとの上限（1 分あたり）
    rateLimitPerMinute = 30,
  } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  // リバースプロキシ配下では、ログイン失敗の IP 判定と Secure Cookie のために必要
  app.set('trust proxy', trustProxy);
  app.use(securityHeaders);

  const limit = (message) => rateLimit({ windowMs: 60_000, max: rateLimitPerMinute, message });
  const tooMany = 'リクエストが多すぎます。しばらくしてから再度お試しください';
  const authLimit = limit(tooMany);
  const challengeLimit = limit(tooMany);
  const loginLimit = limit(tooMany);
  // カメラ映像の名前表示は 1 秒に数回呼ばれるため上限を別にする
  const identifyLimit = rateLimit({ windowMs: 60_000, max: rateLimitPerMinute * 10, message: tooMany });
  // 復元は大きなファイル（スナップショット込み）を受け取るため、専用の上限を使う
  const RESTORE_PATH = '/api/backup/restore';
  const jsonBody = express.json({ limit: '2mb' });
  app.use((req, res, next) => (req.path === RESTORE_PATH ? next() : jsonBody(req, res, next)));

  // ---- static ----
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor/face-api', express.static(path.join(FACE_API_DIR, 'dist')));
  app.use('/models', express.static(path.join(FACE_API_DIR, 'model')));

  // ---- api ----
  const api = express.Router();

  /**
   * リクエストのライブネス証跡を検証する。
   * 証跡の欠落・無効なチャレンジは 400（リクエスト不正）、動作の不一致などは結果として返す。
   * @param {number[][]} descriptors この操作で使う顔（認証なら 1 件、登録なら撮影した全サンプル）
   * @returns {{ status: 'skipped' | 'passed' | 'failed', reason: string | null }}
   */
  function verifyLiveness(evidence, descriptors) {
    if (!liveness) return { status: 'skipped', reason: null };
    if (!evidence || typeof evidence !== 'object') {
      throw new HttpError(400, 'ライブネス検知の結果（liveness）が必要です');
    }
    const challenge = challenges.consume(evidence.challengeId);
    if (!challenge) {
      throw new HttpError(400, 'チャレンジが無効か期限切れです。もう一度やり直してください');
    }
    const reason = checkLiveness(challenge, evidence, descriptors, {
      consistency: livenessConsistency,
      now: Date.now(),
    });
    return { status: reason ? 'failed' : 'passed', reason };
  }

  class LivenessError extends HttpError {
    constructor(reason) {
      super(422, `ライブネス検知に失敗しました: ${reason}`, { reason: 'liveness', detail: reason });
    }
  }

  // 登録・削除・履歴など管理操作の保護（顔認証そのものは誰でも実行できる）
  const requireAdmin = (req, res, next) => {
    if (admin.isLoggedIn(req)) return next();
    res.status(401).json({ error: '管理者ログインが必要です', code: 'admin_required' });
  };

  api.get('/admin/status', (req, res) => {
    res.json({ enabled: admin.enabled, loggedIn: admin.isLoggedIn(req) });
  });

  api.post('/admin/login', loginLimit, (req, res) => {
    if (!admin.enabled) throw new HttpError(404, '管理者パスワードが設定されていません');
    const result = admin.login(req, res, req.body?.password);
    if (result.ok) return res.status(204).end();
    if (result.locked) throw new HttpError(429, 'ログインの失敗が続いたため、しばらくしてから再度お試しください');
    throw new HttpError(401, 'パスワードが違います');
  });

  api.post('/admin/logout', (req, res) => {
    admin.logout(req, res);
    res.status(204).end();
  });

  api.get('/config', (req, res) => {
    res.json({ threshold, maxSamples, liveness, challengeTtlMs: challenges.ttlMs });
  });

  // ライブネス検知: ランダムな動作指示を発行
  api.post('/liveness/challenge', challengeLimit, (req, res) => {
    if (!liveness) throw new HttpError(404, 'ライブネス検知は無効です');
    const c = challenges.issue();
    res.status(201).json({
      id: c.id,
      actions: c.actions.map((id) => ({ id, label: ACTIONS[id] })),
      expiresAt: new Date(c.expiresAt).toISOString(),
      ttlMs: challenges.ttlMs,
    });
  });

  api.get('/users', requireAdmin, (req, res) => {
    res.json(store.listUsers().map(publicUser));
  });

  // 顔登録
  api.post('/users', requireAdmin, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new HttpError(400, `名前は 1〜${MAX_NAME_LENGTH} 文字で入力してください`);
    }
    const descriptors = parseDescriptors(req.body.descriptors, maxSamples);

    if (store.findUserByName(name)) {
      throw new HttpError(409, `「${name}」は既に登録されています`);
    }

    // 写真・画面による他人の顔の登録を防ぐ
    const live = verifyLiveness(req.body.liveness, descriptors);
    if (live.status === 'failed') {
      await store.addHistory({
        type: 'register',
        result: 'failure',
        userId: null,
        userName: name,
        liveness: 'failed',
        reason: 'liveness',
        detail: live.reason,
      });
      throw new LivenessError(live.reason);
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
    await store.addHistory({
      type: 'register',
      result: 'success',
      userId: user.id,
      userName: user.name,
      liveness: live.status,
    });
    res.status(201).json(publicUser(user));
  });

  // 既存ユーザーへのサンプル追加（認証精度の向上用）
  api.post('/users/:id/samples', requireAdmin, async (req, res) => {
    const descriptors = parseDescriptors(req.body?.descriptors, maxSamples);
    const user = store.getUser(req.params.id);
    if (!user) throw new HttpError(404, 'ユーザーが見つかりません');
    for (const d of descriptors) {
      const match = findBestMatch(d, store.listUsers(), threshold);
      if (match.matched && match.user.id !== user.id) {
        throw new HttpError(409, `この顔は「${match.user.name}」として登録されています`);
      }
      // 他人の顔を追加されると、その人がこのユーザーとして認証できてしまう
      if (!findBestMatch(d, [user], threshold).matched) {
        throw new HttpError(403, `「${user.name}」の登録済みの顔と一致しないため追加できません`);
      }
    }

    const live = verifyLiveness(req.body.liveness, descriptors);
    if (live.status === 'failed') {
      await store.addHistory({
        type: 'samples',
        result: 'failure',
        userId: user.id,
        userName: user.name,
        liveness: 'failed',
        reason: 'liveness',
        detail: live.reason,
      });
      throw new LivenessError(live.reason);
    }

    const updated = await store.addSamples(user.id, descriptors, maxSamples);
    await store.addHistory({
      type: 'samples',
      result: 'success',
      userId: user.id,
      userName: user.name,
      liveness: live.status,
    });
    res.json(publicUser(updated));
  });

  api.delete('/users/:id', requireAdmin, async (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) throw new HttpError(404, 'ユーザーが見つかりません');
    await store.deleteUser(user.id);
    await store.addHistory({ type: 'delete', result: 'success', userId: user.id, userName: user.name });
    res.status(204).end();
  });

  // 顔認証（結果は必ず履歴に保存）
  // カメラに映っている顔が誰かを返す（画面に名前を表示するため）。
  // 写真で登録者の名前を調べられないよう管理者のみ。履歴には残さない。
  api.post('/identify', requireAdmin, identifyLimit, (req, res) => {
    const list = req.body?.descriptors;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IDENTIFY_FACES || !list.every(isValidDescriptor)) {
      throw new HttpError(400, `descriptors は 1〜${MAX_IDENTIFY_FACES} 件の顔データで指定してください`);
    }
    const users = store.listUsers();
    const results = list.map((d) => {
      const match = findBestMatch(d, users, threshold);
      return {
        name: match.matched ? match.user.name : null,
        distance: match.distance == null ? null : Number(match.distance.toFixed(4)),
      };
    });
    res.json({ results });
  });

  api.post('/auth', authLimit, async (req, res) => {
    const descriptor = req.body?.descriptor;
    if (!isValidDescriptor(descriptor)) {
      throw new HttpError(400, 'descriptor の形式が不正です（128 次元の数値配列が必要）');
    }
    const snapshot = parseSnapshot(req.body.snapshot);

    const live = verifyLiveness(req.body.liveness, [descriptor]);
    const livenessStatus = live.status;
    const livenessReason = live.reason;

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

  api.get('/history', requireAdmin, (req, res) => {
    const { userId, result, type } = req.query;
    const page = store.listHistory({
      limit: parseLimit(req.query.limit, 100, 1000),
      offset: parseLimit(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
      userId: typeof userId === 'string' ? userId : undefined,
      result: result === 'success' || result === 'failure' ? result : undefined,
      type: ['auth', 'register', 'samples', 'delete', 'backup', 'restore'].includes(type) ? type : undefined,
    });
    res.json(page);
  });

  api.get('/history/:id/snapshot', requireAdmin, (req, res) => {
    const file = store.snapshotPath(req.params.id);
    if (!file) throw new HttpError(404, 'スナップショットがありません');
    res.type('jpeg').sendFile(file);
  });

  // バックアップのダウンロード（生体情報を含むため、取得したことを履歴に残す）
  api.get('/backup', requireAdmin, async (req, res) => {
    const includeSnapshots = req.query.snapshots !== '0';
    const data = await store.exportData({ includeSnapshots });
    await store.addHistory({
      type: 'backup',
      result: 'success',
      detail: `ユーザー ${data.users.length} 件・履歴 ${data.history.length} 件${includeSnapshots ? '' : '（画像なし）'}`,
    });
    res.attachment(backupFileName());
    res.json(data);
  });

  // バックアップからの復元。replace の前には現在のデータを自動で退避する
  api.post('/backup/restore', requireAdmin, express.json({ limit: '200mb' }), async (req, res) => {
    const mode = req.query.mode === 'merge' ? 'merge' : 'replace';
    let parsed;
    try {
      parsed = parseBackup(req.body, { maxSamples });
    } catch (err) {
      if (err instanceof BackupError) throw new HttpError(400, err.message);
      throw err;
    }

    const preRestoreBackup =
      mode === 'replace' ? path.basename(await writeBackupFile(store, backupDir, 'pre-restore')) : null;
    const result = await store.restoreData(parsed, { mode });
    await store.addHistory({
      type: 'restore',
      result: 'success',
      detail:
        `${mode === 'replace' ? '置き換え' : '追加'}: ユーザー ${result.users} 件・履歴 ${result.history} 件` +
        (result.skippedUsers.length ? `（重複のためスキップ: ${result.skippedUsers.join('、')}）` : ''),
    });
    res.json({ mode, ...result, preRestoreBackup });
  });

  api.delete('/history', requireAdmin, async (req, res) => {
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
