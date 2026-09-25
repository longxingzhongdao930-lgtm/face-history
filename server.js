import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { AdminAuth } from './src/admin.js';
import { scheduleBackups } from './src/backup.js';
import { createApp } from './src/app.js';
import { Store } from './src/store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const THRESHOLD = Number(process.env.FACE_THRESHOLD ?? 0.5);
const LIVENESS = (process.env.LIVENESS ?? 'on').toLowerCase() !== 'off';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
// トンネル等でインターネットに公開している（HOST は 127.0.0.1 のままでも外部から届く）
const PUBLIC = process.env.PUBLIC === '1';
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR ?? path.join(DATA_DIR, 'backups'));
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 0);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 7);
// Express の trust proxy: 数値はプロキシの段数、true/false、それ以外は信頼する IP・サブネットの指定
const TRUST_PROXY = (() => {
  const v = process.env.TRUST_PROXY;
  if (v == null || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
})();

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!Number.isFinite(THRESHOLD) || THRESHOLD <= 0 || THRESHOLD >= 2) {
  fail('FACE_THRESHOLD は 0〜2 の数値で指定してください（推奨 0.4〜0.6）');
}
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  fail('HTTPS を使う場合は TLS_CERT と TLS_KEY の両方を指定してください');
}
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if ((PUBLIC || !isLoopback) && !ADMIN_PASSWORD) {
  // 顔データ（生体情報）の登録・削除・履歴を、ネットワーク上の誰でも操作できてしまうため
  fail(`${PUBLIC ? 'インターネットに公開する' : `HOST=${HOST} で公開する`}場合は ADMIN_PASSWORD を設定してください`);
}
if (!Number.isFinite(BACKUP_INTERVAL_HOURS) || BACKUP_INTERVAL_HOURS < 0) {
  fail('BACKUP_INTERVAL_HOURS は 0 以上の数値で指定してください（0 で定期バックアップなし）');
}
if (!Number.isInteger(BACKUP_KEEP) || BACKUP_KEEP < 1) {
  fail('BACKUP_KEEP は 1 以上の整数で指定してください');
}
if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 8) {
  fail('ADMIN_PASSWORD は 8 文字以上にしてください');
}

const store = await new Store(DATA_DIR).init();
const app = createApp(store, {
  threshold: THRESHOLD,
  liveness: LIVENESS,
  admin: new AdminAuth({ password: ADMIN_PASSWORD }),
  trustProxy: TRUST_PROXY,
  backupDir: BACKUP_DIR,
});

if (BACKUP_INTERVAL_HOURS > 0) {
  scheduleBackups(store, BACKUP_DIR, { intervalMs: BACKUP_INTERVAL_HOURS * 3600 * 1000, keep: BACKUP_KEEP });
}

const server = TLS_CERT
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : app;

server.listen(PORT, HOST, () => {
  const scheme = TLS_CERT ? 'https' : 'http';
  console.log(`face-history: ${scheme}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(
    `data dir: ${DATA_DIR} / threshold: ${THRESHOLD} / liveness: ${LIVENESS ? 'on' : 'off'}` +
      ` / admin login: ${ADMIN_PASSWORD ? 'on' : 'off'}` +
      ` / auto backup: ${BACKUP_INTERVAL_HOURS > 0 ? `every ${BACKUP_INTERVAL_HOURS}h (keep ${BACKUP_KEEP})` : 'off'}`,
  );
});
