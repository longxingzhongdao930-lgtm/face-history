import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AdminAuth } from '../src/admin.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { vec } from './fixtures.js';

let dir;
let server;
let base;
let now = 1_000_000;

async function call(method, url, { body, cookie } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return {
    status: res.status,
    body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
    setCookie: res.headers.get('set-cookie'),
  };
}

const cookieOf = (setCookie) => setCookie.split(';')[0];

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-admin-'));
  const store = await new Store(dir).init();
  const admin = new AdminAuth({ password: 'secret-pass', sessionTtlMs: 60_000, maxFailures: 3, now: () => now });
  server = createApp(store, { liveness: false, admin }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('未ログインでは管理 API が 401、顔認証と設定は利用できる', async () => {
  assert.deepEqual((await call('GET', '/api/admin/status')).body, { enabled: true, loggedIn: false });
  for (const [method, url, body] of [
    ['GET', '/api/users'],
    ['POST', '/api/users', { name: 'A', descriptors: [vec(0.1)] }],
    ['POST', '/api/users/x/samples', { descriptors: [vec(0.1)] }],
    ['DELETE', '/api/users/x'],
    ['GET', '/api/history'],
    ['GET', '/api/history/x/snapshot'],
    ['DELETE', '/api/history'],
  ]) {
    const res = await call(method, url, { body });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal(res.body.code, 'admin_required');
  }
  assert.equal((await call('GET', '/api/config')).status, 200);
  assert.equal((await call('POST', '/api/auth', { body: { descriptor: vec(0.1) } })).body.result, 'failure');
});

test('ログインすると管理 API を使え、Cookie は HttpOnly / SameSite=Strict', async () => {
  const login = await call('POST', '/api/admin/login', { body: { password: 'secret-pass' } });
  assert.equal(login.status, 204);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  const cookie = cookieOf(login.setCookie);

  assert.equal((await call('GET', '/api/admin/status', { cookie })).body.loggedIn, true);
  const reg = await call('POST', '/api/users', { cookie, body: { name: 'Alice', descriptors: [vec(0.1)] } });
  assert.equal(reg.status, 201);
  assert.equal((await call('GET', '/api/history', { cookie })).status, 200);

  // ログアウトで Cookie が消える
  const logout = await call('POST', '/api/admin/logout', { cookie });
  assert.match(logout.setCookie, /Max-Age=0/);
});

test('改ざん・期限切れの Cookie は無効', async () => {
  const cookie = cookieOf((await call('POST', '/api/admin/login', { body: { password: 'secret-pass' } })).setCookie);
  const [name, value] = cookie.split('=');
  const [exp, sig] = value.split('.');
  assert.equal((await call('GET', '/api/users', { cookie: `${name}=${Number(exp) + 999999}.${sig}` })).status, 401);
  assert.equal((await call('GET', '/api/users', { cookie: `${name}=${exp}.${sig.slice(1)}x` })).status, 401);

  now += 60_001;
  assert.equal((await call('GET', '/api/users', { cookie })).status, 401, '期限切れ');
});

test('パスワード違いは 401、失敗が続くと正しいパスワードでも 429', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await call('POST', '/api/admin/login', { body: { password: 'wrong' } })).status, 401);
  }
  assert.equal((await call('POST', '/api/admin/login', { body: { password: 'secret-pass' } })).status, 429);
  now += 15 * 60 * 1000 + 1;
  assert.equal((await call('POST', '/api/admin/login', { body: { password: 'secret-pass' } })).status, 204, 'ロック解除');
});

test('パスワード未設定なら管理 API は保護されない', () => {
  const admin = new AdminAuth();
  assert.equal(admin.enabled, false);
  assert.equal(admin.isLoggedIn({ headers: {} }), true);
});
