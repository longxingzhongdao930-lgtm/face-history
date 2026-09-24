import assert from 'node:assert/strict';
import { test } from 'node:test';
import { euclideanDistance, findBestMatch, isValidDescriptor } from '../src/matcher.js';

const vec = (v) => Array(128).fill(v);

test('isValidDescriptor は 128 次元の有限数値配列のみ許可する', () => {
  assert.equal(isValidDescriptor(vec(0.1)), true);
  assert.equal(isValidDescriptor(vec(0.1).slice(1)), false);
  assert.equal(isValidDescriptor([...vec(0).slice(1), NaN]), false);
  assert.equal(isValidDescriptor([...vec(0).slice(1), '1']), false);
  assert.equal(isValidDescriptor(null), false);
});

test('euclideanDistance', () => {
  assert.equal(euclideanDistance(vec(0), vec(0)), 0);
  assert.ok(Math.abs(euclideanDistance(vec(0), vec(0.1)) - Math.sqrt(128 * 0.01)) < 1e-9);
});

test('findBestMatch は最小距離のユーザーを返し、しきい値で判定する', () => {
  const users = [
    { id: 'a', descriptors: [vec(0.5), vec(0.3)] },
    { id: 'b', descriptors: [vec(0.0)] },
  ];
  const near = findBestMatch(vec(0.31), users, 0.5);
  assert.equal(near.user.id, 'a');
  assert.equal(near.matched, true);

  const far = findBestMatch(vec(0.9), users, 0.5);
  assert.equal(far.user.id, 'a');
  assert.equal(far.matched, false);

  assert.deepEqual(findBestMatch(vec(0), [], 0.5), { user: null, distance: null, matched: false });
});
