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

// Cloudflare Tunnel 経由と同じ構成: cloudflared（ループバック）が X-Forwarded-For / X-Forwarded-Proto を付ける
async function call(method, url, { body, ip, proto } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ip) headers['X-Forwarded-For'] = ip;
  if (proto) headers['X-Forwarded-Proto'] = proto;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  await res.arrayBuffer();
  return res;
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'face-history-sec-'));
  const store = await new Store(dir).init();
  server = createApp(store, {
    liveness: false,
    trustProxy: 'loopback',
    rateLimitPerMinute: 3,
    admin: new AdminAuth({ password: 'secret-pass' }),
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('セキュリティヘッダーを付ける', async () => {
  const res = await call('GET', '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.equal(res.headers.get('strict-transport-security'), null, 'HTTP では HSTS を付けない');
});

test('HTTPS 経由（トンネル）では HSTS と Secure Cookie', async () => {
  const res = await call('GET', '/', { proto: 'https' });
  assert.match(res.headers.get('strict-transport-security'), /max-age=/);
  const login = await call('POST', '/api/admin/login', { body: { password: 'secret-pass' }, proto: 'https', ip: '198.51.100.9' });
  assert.match(login.headers.get('set-cookie'), /; Secure/);
});

test('認証 API は IP ごとに回数制限（アクセス元ごとに別カウント）', async () => {
  const auth = (ip) => call('POST', '/api/auth', { body: { descriptor: vec(0.1) }, ip });
  for (let i = 0; i < 3; i++) assert.equal((await auth('203.0.113.1')).status, 200);
  const blocked = await auth('203.0.113.1');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await auth('203.0.113.2')).status, 200, '別の IP は影響を受けない');
});

test('管理者ログインも回数制限', async () => {
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await call('POST', '/api/admin/login', { body: { password: 'x' }, ip: '203.0.113.50' })).status);
  }
  assert.equal(statuses.at(-1), 429);
});
