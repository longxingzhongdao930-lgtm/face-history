#!/usr/bin/env node
// スマホ版（サーバー不要の静的サイト）を dist/mobile に組み立てる。
//   GitHub Pages / Cloudflare Pages / Netlify などにそのまま置ける。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist', 'mobile'));
const FACE_API = path.join(ROOT, 'node_modules', '@vladmandic', 'face-api');
const MODELS = ['ssd_mobilenetv1_model', 'tiny_face_detector_model', 'face_landmark_68_model', 'face_recognition_model'];
const SHARED = ['liveness.js', 'matcher.js', 'backup-format.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'mobile'), OUT, { recursive: true });

fs.mkdirSync(path.join(OUT, 'shared'), { recursive: true });
for (const f of SHARED) fs.copyFileSync(path.join(ROOT, 'public', 'shared', f), path.join(OUT, 'shared', f));

fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(FACE_API, 'dist', 'face-api.esm.js'), path.join(OUT, 'vendor', 'face-api.esm.js'));

fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
for (const m of MODELS) {
  for (const f of [`${m}-weights_manifest.json`, `${m}.bin`]) {
    fs.copyFileSync(path.join(FACE_API, 'model', f), path.join(OUT, 'models', f));
  }
}

// キャッシュの版（更新時に古いキャッシュを捨てるため）
let version;
try {
  version = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  version = Date.now().toString(36);
}
const sw = path.join(OUT, 'sw.js');
fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace('__BUILD_VERSION__', `${version}-${Date.now().toString(36)}`));

// GitHub Pages で _ で始まるファイル等を無視させないため
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const size = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, e) => sum + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size),
    0,
  );
console.log(`スマホ版を組み立てました: ${OUT}（${(size(OUT) / 1024 / 1024).toFixed(1)} MB）`);
