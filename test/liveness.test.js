import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChallengeTracker, faceMetrics, randomActions, verifyFrames } from '../public/shared/liveness.js';
import { ChallengeStore } from '../src/challenges.js';
import { face, framesFor } from './fixtures.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('faceMetrics: 合成ランドマークから狙った値が得られる', () => {
  const m = faceMetrics(face({ ear: 0.3, mar: 0.5, yaw: 0.2 }));
  assert.ok(close(m.ear, 0.3));
  assert.ok(close(m.mar, 0.5));
  assert.ok(close(m.yaw, 0.2));
});

test('verifyFrames: 指示どおりの動作なら成功', () => {
  for (const actions of [['blink', 'turn_left'], ['turn_right', 'open_mouth'], ['open_mouth', 'blink']]) {
    assert.deepEqual(verifyFrames(actions, framesFor(actions)), { ok: true }, actions.join(','));
  }
});

test('verifyFrames: 静止画（動きなし）は失敗', () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({ t: i * 100, points: face() }));
  const r = verifyFrames(['blink', 'turn_left'], frames);
  assert.equal(r.ok, false);
  assert.match(r.reason, /まばたき/);
});

test('verifyFrames: 順番が違う・別の動作では失敗', () => {
  assert.equal(verifyFrames(['turn_left', 'blink'], framesFor(['blink', 'turn_left'])).ok, false);
  assert.equal(verifyFrames(['turn_right', 'blink'], framesFor(['turn_left', 'blink'])).ok, false);
});

test('verifyFrames: 最初から動作状態の写真（口を開けたまま）では通らない', () => {
  const open = face({ mar: 0.6 });
  // 基準計測後もずっと口が開いたまま＝ニュートラルを経由しない
  const frames = [face(), face(), face(), open, open, open].map((points, i) => ({ t: i * 100, points }));
  assert.equal(verifyFrames(['open_mouth', 'blink'], frames).ok, false);
});

test('verifyFrames: 正面の顔がないと基準値が取れず失敗', () => {
  const frames = Array.from({ length: 10 }, (_, i) => ({ t: i * 100, points: face({ yaw: 0.4 }) }));
  assert.match(verifyFrames(['blink'], frames).reason, /正面/);
});

test('verifyFrames: 入力チェック', () => {
  assert.equal(verifyFrames(['blink'], []).ok, false);
  assert.equal(verifyFrames(['blink'], Array(401).fill({ t: 0, points: face() })).ok, false);
  const bad = framesFor(['blink']);
  bad[2] = { t: bad[2].t, points: bad[2].points.slice(1) };
  assert.equal(verifyFrames(['blink'], bad).ok, false);
  const backwards = framesFor(['blink']);
  backwards[3].t = -1;
  assert.match(verifyFrames(['blink'], backwards).reason, /時刻/);
});

test('ChallengeTracker: 進捗を 1 つずつ返す', () => {
  const tracker = new ChallengeTracker(['turn_left', 'open_mouth']);
  const done = framesFor(['turn_left', 'open_mouth']).map((f, i) => tracker.push(f.points, i)).filter(Boolean);
  assert.deepEqual(done, ['turn_left', 'open_mouth']);
  assert.equal(tracker.done, true);
});

test('randomActions: 重複しない指定数の動作', () => {
  for (let i = 0; i < 50; i++) {
    const a = randomActions(2);
    assert.equal(a.length, 2);
    assert.notEqual(a[0], a[1]);
  }
});

test('ChallengeStore: 1 回限り・期限切れは無効', () => {
  let now = 1000;
  const store = new ChallengeStore({ ttlMs: 500, maxPending: 2, now: () => now });
  const a = store.issue();
  assert.equal(store.consume(a.id).id, a.id);
  assert.equal(store.consume(a.id), null, '再利用不可');

  const b = store.issue();
  now += 501;
  assert.equal(store.consume(b.id), null, '期限切れ');

  const c1 = store.issue();
  store.issue();
  store.issue();
  assert.equal(store.pending.size, 2);
  assert.equal(store.consume(c1.id), null, '上限超過で古いものから破棄');
  assert.equal(store.consume(undefined), null);
});
