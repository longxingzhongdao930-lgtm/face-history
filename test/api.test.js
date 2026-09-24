import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { vec } from './fixtures.js';

// 最小の JPEG ヘッダ（マジックバイト確認用）
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')}`;

let dir;
let server;
let base;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-'));
  const store = await new Store(dir, { maxHistory: 50 }).init();
  server = createApp(store, { threshold: 0.5, maxSamples: 5, liveness: false }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

let alice;

test('顔登録: 正常系', async () => {
  const res = await call('POST', '/api/users', { name: ' Alice ', descriptors: [vec(0.1), vec(0.12)] });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Alice');
  assert.equal(res.body.samples, 2);
  assert.equal(res.body.descriptors, undefined, '特徴量は API で返さない');
  alice = res.body;
});

test('顔登録: 入力チェック', async () => {
  assert.equal((await call('POST', '/api/users', { name: '', descriptors: [vec(0.9)] })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: 'x'.repeat(51), descriptors: [vec(0.9)] })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: 'Bob', descriptors: [] })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: 'Bob', descriptors: [[1, 2, 3]] })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: 'Bob', descriptors: Array(6).fill(vec(0.9)) })).status, 400);
});

test('顔登録: 同名・同一顔は 409', async () => {
  const sameName = await call('POST', '/api/users', { name: 'Alice', descriptors: [vec(0.9)] });
  assert.equal(sameName.status, 409);
  const sameFace = await call('POST', '/api/users', { name: 'Alice2', descriptors: [vec(0.11)] });
  assert.equal(sameFace.status, 409);
  assert.equal(sameFace.body.existingUser.name, 'Alice');
});

test('顔認証: 一致すれば成功し、履歴とスナップショットが保存される', async () => {
  const res = await call('POST', '/api/auth', { descriptor: vec(0.11), snapshot: JPEG });
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'success');
  assert.equal(res.body.user.id, alice.id);
  assert.ok(res.body.distance <= 0.5);

  const snap = await fetch(`${base}/api/history/${res.body.historyId}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.headers.get('content-type'), 'image/jpeg');
});

test('顔認証: 不一致は失敗として履歴に残る', async () => {
  const res = await call('POST', '/api/auth', { descriptor: vec(0.9) });
  assert.equal(res.body.result, 'failure');
  assert.equal(res.body.user, null);
  const snap = await fetch(`${base}/api/history/${res.body.historyId}/snapshot`);
  assert.equal(snap.status, 404);
});

test('顔認証: 入力チェック', async () => {
  assert.equal((await call('POST', '/api/auth', { descriptor: [1] })).status, 400);
  assert.equal((await call('POST', '/api/auth', { descriptor: vec(0.1), snapshot: 'data:image/png;base64,AAAA' })).status, 400);
  const notJpeg = `data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}`;
  assert.equal((await call('POST', '/api/auth', { descriptor: vec(0.1), snapshot: notJpeg })).status, 400);
});

test('履歴: 新しい順・フィルタ・ページング', async () => {
  const all = await call('GET', '/api/history');
  assert.equal(all.body.total, 3); // register + auth success + auth failure
  assert.deepEqual(all.body.items.map((h) => h.type), ['auth', 'auth', 'register']);
  assert.equal(all.body.items[0].result, 'failure');

  const success = await call('GET', '/api/history?type=auth&result=success');
  assert.equal(success.body.total, 1);
  assert.equal(success.body.items[0].userName, 'Alice');

  const byUser = await call('GET', `/api/history?userId=${alice.id}`);
  assert.equal(byUser.body.total, 2);

  const paged = await call('GET', '/api/history?limit=1&offset=1');
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.items[0].result, 'success');
});

test('サンプル追加', async () => {
  const res = await call('POST', `/api/users/${alice.id}/samples`, { descriptors: [vec(0.13), vec(0.14), vec(0.15), vec(0.16)] });
  assert.equal(res.status, 200);
  assert.equal(res.body.samples, 5, 'maxSamples で古いものから切り捨てる');
  assert.equal((await call('POST', '/api/users/nope/samples', { descriptors: [vec(0.1)] })).status, 404);
});

test('永続化: 再読み込みしてもデータが残る', async () => {
  const reloaded = await new Store(dir).init();
  assert.equal(reloaded.listUsers().length, 1);
  assert.equal(reloaded.listHistory().total, 3);
});

test('ユーザー削除後は認証に失敗し、削除も履歴に残る', async () => {
  assert.equal((await call('DELETE', `/api/users/${alice.id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/users/${alice.id}`)).status, 404);
  const res = await call('POST', '/api/auth', { descriptor: vec(0.11) });
  assert.equal(res.body.result, 'failure');
  const del = await call('GET', '/api/history?type=delete');
  assert.equal(del.body.total, 1);
});

test('履歴の全削除でスナップショットも消える', async () => {
  const res = await call('DELETE', '/api/history');
  assert.equal(res.body.removed, 5);
  assert.equal((await call('GET', '/api/history')).body.total, 0);
  assert.deepEqual(await fs.readdir(path.join(dir, 'snapshots')), []);
});

test('静的ファイルと face-api モデルを配信する', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/face-api/face-api.esm.js`)).status, 200);
  assert.equal((await fetch(`${base}/models/face_recognition_model-weights_manifest.json`)).status, 200);
  assert.equal((await call('GET', '/api/unknown')).status, 404);
});
