import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { face, framesFor, vec } from './fixtures.js';

let dir;
let server;
let base;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function challenge() {
  const res = await call('POST', '/api/liveness/challenge');
  assert.equal(res.status, 201);
  return res.body;
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-live-'));
  const store = await new Store(dir).init();
  server = createApp(store, { threshold: 0.5 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/users', { name: 'Alice', descriptors: [vec(0.1)] });
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('config と チャレンジ発行', async () => {
  assert.equal((await call('GET', '/api/config')).body.liveness, true);
  const c = await challenge();
  assert.equal(c.actions.length, 2);
  assert.ok(c.actions.every((a) => typeof a.id === 'string' && typeof a.label === 'string'));
});

test('ライブネスの証跡がない・チャレンジが無効なら 400', async () => {
  assert.equal((await call('POST', '/api/auth', { descriptor: vec(0.1) })).status, 400);
  const res = await call('POST', '/api/auth', {
    descriptor: vec(0.1),
    liveness: { challengeId: 'nope', frames: framesFor(['blink']), checkpoints: [vec(0.1), vec(0.1)] },
  });
  assert.equal(res.status, 400);
});

test('指示どおりの動作 + 本人の顔なら認証成功（チャレンジは再利用不可）', async () => {
  const c = await challenge();
  const body = {
    descriptor: vec(0.11),
    liveness: { challengeId: c.id, frames: framesFor(c.actions.map((a) => a.id)), checkpoints: [vec(0.1), vec(0.12)] },
  };
  const res = await call('POST', '/api/auth', body);
  assert.equal(res.body.result, 'success');
  assert.equal(res.body.liveness, 'passed');
  assert.equal(res.body.user.name, 'Alice');

  assert.equal((await call('POST', '/api/auth', body)).status, 400, '同じチャレンジは使えない');
});

test('静止画（写真）は本人の顔でも失敗し、なりすまし疑いとして履歴に残る', async () => {
  const c = await challenge();
  const frames = Array.from({ length: 20 }, (_, i) => ({ t: i * 100, points: face() }));
  const res = await call('POST', '/api/auth', {
    descriptor: vec(0.1),
    liveness: { challengeId: c.id, frames, checkpoints: [vec(0.1), vec(0.1)] },
  });
  assert.equal(res.body.result, 'failure');
  assert.equal(res.body.reason, 'liveness');
  assert.equal(res.body.user, null);

  const h = (await call('GET', `/api/history?limit=1`)).body.items[0];
  assert.equal(h.reason, 'liveness');
  assert.equal(h.liveness, 'failed');
  assert.equal(h.candidateName, 'Alice');
  assert.equal(h.userId, null);
});

test('動作中に別の顔へ差し替えると失敗', async () => {
  const c = await challenge();
  const res = await call('POST', '/api/auth', {
    descriptor: vec(0.1),
    liveness: { challengeId: c.id, frames: framesFor(c.actions.map((a) => a.id)), checkpoints: [vec(0.9), vec(0.1)] },
  });
  assert.equal(res.body.result, 'failure');
  assert.match(res.body.detail, /別の顔/);
});

test('チャレンジ発行からの経過時間より長い記録は不正', async () => {
  const c = await challenge();
  const res = await call('POST', '/api/auth', {
    descriptor: vec(0.1),
    liveness: {
      challengeId: c.id,
      frames: framesFor(c.actions.map((a) => a.id), { step: 5000 }),
      checkpoints: [vec(0.1), vec(0.1)],
    },
  });
  assert.equal(res.body.result, 'failure');
  assert.match(res.body.detail, /時刻/);
});

test('ライブネスは通っても未登録の顔なら no_match', async () => {
  const c = await challenge();
  const res = await call('POST', '/api/auth', {
    descriptor: vec(0.9),
    liveness: { challengeId: c.id, frames: framesFor(c.actions.map((a) => a.id)), checkpoints: [vec(0.9), vec(0.9)] },
  });
  assert.equal(res.body.result, 'failure');
  assert.equal(res.body.reason, 'no_match');
  assert.equal(res.body.liveness, 'passed');
});
