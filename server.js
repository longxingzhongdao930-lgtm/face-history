import path from 'node:path';
import { createApp } from './src/app.js';
import { Store } from './src/store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data');
const THRESHOLD = Number(process.env.FACE_THRESHOLD ?? 0.5);

if (!Number.isFinite(THRESHOLD) || THRESHOLD <= 0 || THRESHOLD >= 2) {
  console.error('FACE_THRESHOLD は 0〜2 の数値で指定してください（推奨 0.4〜0.6）');
  process.exit(1);
}

const store = await new Store(DATA_DIR).init();
const app = createApp(store, { threshold: THRESHOLD });

app.listen(PORT, HOST, () => {
  console.log(`face-history: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`data dir: ${DATA_DIR} / threshold: ${THRESHOLD}`);
});
