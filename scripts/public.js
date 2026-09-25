#!/usr/bin/env node
// face-history をインターネットに公開する（Cloudflare Tunnel）。
//   サーバー（127.0.0.1 のみで待ち受け）とトンネルを同時に起動し、公開 URL を表示する。
//   顔データは手元の PC に保存されたまま。Ctrl+C で両方とも停止する。
//
//   ADMIN_PASSWORD=... npm run public            → https://<ランダム>.trycloudflare.com（起動ごとに変わる）
//   ADMIN_PASSWORD=... TUNNEL_TOKEN=... npm run public
//                                                 → Cloudflare で作成した固定 URL のトンネル
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ?? '3000';
const CLOUDFLARED = process.env.CLOUDFLARED ?? 'cloudflared';
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;
const isWindows = process.platform === 'win32';

function fail(lines) {
  console.error(['', ...lines, ''].join('\n'));
  process.exit(1);
}

// ---- 事前チェック ----

const password = process.env.ADMIN_PASSWORD ?? '';
if (password.length < 8) {
  fail([
    'インターネットに公開するには、管理者パスワード（8 文字以上）の設定が必要です。',
    '',
    isWindows
      ? '  PowerShell:  $env:ADMIN_PASSWORD="十分に長いパスワード"; npm run public'
      : '  ADMIN_PASSWORD="十分に長いパスワード" npm run public',
  ]);
}

const version = spawnSync(CLOUDFLARED, ['--version'], { encoding: 'utf8' });
if (version.error) {
  fail([
    'cloudflared が見つかりません。インストールしてから再度実行してください。',
    '',
    '  Windows:  winget install --id Cloudflare.cloudflared',
    '  Mac:      brew install cloudflared',
    '  その他:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    '',
    'インストール後はターミナルを開き直してください（PATH を反映するため）。',
  ]);
}

// ---- サーバー起動 ----

const children = [];
function shutdown(code = 0) {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PUBLIC: '1',
    HOST: '127.0.0.1',
    PORT,
    // cloudflared（同じ PC 上）経由のアクセス元 IP・HTTPS を正しく判定するため
    TRUST_PROXY: 'loopback',
  },
});
children.push(server);
server.on('exit', (code) => {
  console.error(`サーバーが停止しました（終了コード ${code}）`);
  shutdown(code ?? 1);
});

async function waitForServer(timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/config`);
      if (res.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error('サーバーが起動しませんでした');
  shutdown(1);
}
await waitForServer();

// ---- トンネル起動 ----

const protocol = process.env.CLOUDFLARED_PROTOCOL ? ['--protocol', process.env.CLOUDFLARED_PROTOCOL] : [];
const args = TUNNEL_TOKEN
  ? ['tunnel', '--no-autoupdate', ...protocol, 'run', '--token', TUNNEL_TOKEN]
  : ['tunnel', '--no-autoupdate', ...protocol, '--url', `http://127.0.0.1:${PORT}`];
const tunnel = spawn(CLOUDFLARED, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);

const recent = [];
let announced = false;
let quickUrl = null;

// 接続できない場合の案内（社内ネットワーク等でポート 7844 が塞がれていることが多い）
const connectTimer = setTimeout(() => {
  if (announced) return;
  console.error(
    [
      '',
      'トンネルに接続できません。ネットワークで Cloudflare への通信（ポート 7844）が制限されている可能性があります。',
      '  ・別のネットワーク（自宅の回線・スマートフォンのテザリング等）で試す',
      '  ・QUIC が使えない環境では CLOUDFLARED_PROTOCOL=http2 を指定して再実行する',
      '  ・詳しいログを見るには CLOUDFLARED_LOG=1 を指定する',
      '',
    ].join('\n'),
  );
}, 30_000);
function announce(url) {
  if (announced) return;
  announced = true;
  clearTimeout(connectTimer);
  const bar = '='.repeat(64);
  console.log(
    [
      '',
      bar,
      '  インターネットに公開しました',
      url ? `  URL: ${url}` : '  URL: Cloudflare のダッシュボードで設定したホスト名',
      '',
      '  ・スマートフォン等でこの URL を開くと顔認証を利用できます',
      '  ・登録・履歴・ユーザー管理には管理者パスワードが必要です',
      TUNNEL_TOKEN ? '' : '  ・URL は起動するたびに変わります（固定するには README を参照）',
      '  ・停止するには Ctrl+C',
      bar,
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
}

for (const stream of [tunnel.stdout, tunnel.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > 30) recent.shift();
      if (process.env.CLOUDFLARED_LOG === '1') console.log(`[cloudflared] ${line}`);
      // URL は発行されても接続が確立するまでは使えないため、接続を確認してから案内する
      quickUrl ??= line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
      if (/Registered tunnel connection/.test(line)) announce(quickUrl);
    }
  });
}

tunnel.on('exit', (code) => {
  console.error(`cloudflared が停止しました（終了コード ${code}）`);
  if (!announced) console.error(recent.join('\n'));
  shutdown(code ?? 1);
});
