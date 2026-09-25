#!/usr/bin/env node
// face-history をインターネットに公開する。
//   サーバー（127.0.0.1 のみで待ち受け）とトンネルを同時に起動し、公開 URL を表示する。
//   顔データは手元の PC に保存されたまま。Ctrl+C で両方とも停止する。
//
//   ADMIN_PASSWORD=... npm run public            → Cloudflare: https://<ランダム>.trycloudflare.com（起動ごとに変わる）
//   ADMIN_PASSWORD=... TUNNEL_TOKEN=... npm run public
//                                                 → Cloudflare: ダッシュボードで設定した固定 URL
//   ADMIN_PASSWORD=... npm run public:tailscale   → Tailscale Funnel: https://<PC名>.<tailnet>.ts.net（固定）
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ?? '3000';
const isWindows = process.platform === 'win32';
const LOG = process.env.TUNNEL_LOG === '1' || process.env.CLOUDFLARED_LOG === '1';

function fail(lines) {
  console.error(['', ...lines, ''].join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- トンネルの種類

const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;

const providers = {
  cloudflare: {
    name: 'cloudflared',
    bin: process.env.CLOUDFLARED ?? 'cloudflared',
    versionArgs: ['--version'],
    install: [
      '  Windows:  winget install --id Cloudflare.cloudflared',
      '  Mac:      brew install cloudflared',
      '  その他:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    ],
    args() {
      const protocol = process.env.CLOUDFLARED_PROTOCOL ? ['--protocol', process.env.CLOUDFLARED_PROTOCOL] : [];
      return TUNNEL_TOKEN
        ? ['tunnel', '--no-autoupdate', ...protocol, 'run', '--token', TUNNEL_TOKEN]
        : ['tunnel', '--no-autoupdate', ...protocol, '--url', `http://127.0.0.1:${PORT}`];
    },
    fixedUrl: Boolean(TUNNEL_TOKEN),
    // URL は発行されても接続が確立するまでは使えないため、接続を確認してから案内する
    state: { url: null },
    onLine(line) {
      this.state.url ??= line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
      if (/Registered tunnel connection/.test(line)) return { connected: true, url: this.state.url };
      return null;
    },
    hintAfterMs: 30_000,
    hint: [
      'トンネルに接続できません。ネットワークで Cloudflare への通信（ポート 7844）が制限されている可能性があります。',
      '  ・別のネットワーク（自宅の回線・スマートフォンのテザリング等）で試す',
      '  ・QUIC が使えない環境では CLOUDFLARED_PROTOCOL=http2 を指定して再実行する',
      '  ・詳しいログを見るには TUNNEL_LOG=1 を指定する',
    ],
  },

  tailscale: {
    name: 'tailscale',
    bin: process.env.TAILSCALE ?? 'tailscale',
    versionArgs: ['version'],
    install: [
      '  Windows:  winget install --id tailscale.tailscale',
      '  Mac:      brew install --cask tailscale',
      '  その他:   https://tailscale.com/download',
      '',
      'インストール後、Tailscale アプリを起動してログインしてください。',
    ],
    // Funnel をバックグラウンド設定で有効にする（コマンドは設定後すぐ終了する）。
    // フォアグラウンド実行（tailscale funnel <port>）は Windows で設定が維持されず、
    // 公開 DNS にも登録されないことがあったため使わない。停止時に off で無効に戻す。
    args: () => ['funnel', '--bg', PORT],
    background: true,
    offArgs: ['funnel', '--https=443', 'off'],
    fixedUrl: true,
    state: { url: null },
    onLine(line) {
      const url = line.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\/?/)?.[0];
      if (url) this.state.url = url.replace(/\/$/, '');
      // tailscale が案内する無効化コマンドがあればそれを使う
      const off = line.match(/tailscale (funnel .*\boff)\s*$/)?.[1];
      if (off) this.offArgs = off.trim().split(/\s+/);
      return null;
    },
    // Funnel が未許可の場合は、tailscale 自身が有効化用の URL を表示して待つ
    alwaysShowOutput: true,
    hintAfterMs: 45_000,
    hint: [
      'Tailscale Funnel を開始できていません。次を確認してください。',
      '  ・上に「https://login.tailscale.com/...」が表示されていれば、ブラウザで開いて Funnel（と HTTPS）を有効にする',
      '  ・Tailscale アプリが起動していて、ログイン済みであること（タスクトレイ / メニューバーのアイコン）',
      '  ・Tailscale を最新版に更新する（Funnel のこの使い方には 1.52 以降が必要）',
    ],
  },
};

const providerName = process.argv.includes('--tailscale')
  ? 'tailscale'
  : (process.env.TUNNEL ?? 'cloudflare').toLowerCase();
const provider = providers[providerName];
if (!provider) fail([`TUNNEL は cloudflare または tailscale を指定してください（指定値: ${providerName}）`]);

// ---------------------------------------------------------------- 事前チェック

const password = process.env.ADMIN_PASSWORD ?? '';
if (password.length < 8) {
  const script = providerName === 'tailscale' ? 'npm run public:tailscale' : 'npm run public';
  fail([
    'インターネットに公開するには、管理者パスワード（8 文字以上）の設定が必要です。',
    '',
    isWindows
      ? `  PowerShell:  $env:ADMIN_PASSWORD="十分に長いパスワード"; ${script}`
      : `  ADMIN_PASSWORD="十分に長いパスワード" ${script}`,
  ]);
}

const version = spawnSync(provider.bin, provider.versionArgs, { encoding: 'utf8' });
if (version.error) {
  fail([
    `${provider.name} が見つかりません。インストールしてから再度実行してください。`,
    '',
    ...provider.install,
    '',
    'インストール後はターミナルを開き直してください（PATH を反映するため）。',
  ]);
}

// ---------------------------------------------------------------- サーバー起動

const children = [];
let funnelActive = false;
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (funnelActive) {
    // バックグラウンド設定の Funnel は明示的に無効にしないと残り続ける
    const off = spawnSync(provider.bin, provider.offArgs, { encoding: 'utf8' });
    if (off.status === 0) console.log('Tailscale Funnel を無効にしました');
    else console.error(`Funnel を無効にできませんでした。手動で実行してください: tailscale ${provider.offArgs.join(' ')}`);
  }
  for (const child of children) if (child.exitCode === null) child.kill('SIGINT');
  setTimeout(() => process.exit(code), 500).unref();
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
    // トンネル（同じ PC 上）経由のアクセス元 IP・HTTPS を正しく判定するため
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

// ---------------------------------------------------------------- トンネル起動

const tunnel = spawn(provider.bin, provider.args(), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);

const recent = [];
let announced = false;

const hintTimer = setTimeout(() => {
  if (!announced) console.error(['', ...provider.hint, ''].join('\n'));
}, provider.hintAfterMs);

function announce(url) {
  if (announced) return;
  announced = true;
  clearTimeout(hintTimer);
  const bar = '='.repeat(64);
  const lines = [
    '',
    bar,
    '  インターネットに公開しました',
    url ? `  URL: ${url}` : '  URL: Cloudflare のダッシュボードで設定したホスト名',
    '  ・スマートフォン等でこの URL を開くと顔認証を利用できます',
    '  ・登録・履歴・ユーザー管理には管理者パスワードが必要です',
    provider.fixedUrl
      ? '  ・この URL は次回起動しても変わりません'
      : '  ・URL は起動するたびに変わります（固定するには README を参照）',
    '  ・停止するには Ctrl+C',
    bar,
    '',
  ];
  console.log(lines.join('\n'));
}

for (const stream of [tunnel.stdout, tunnel.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > 30) recent.shift();
      if (LOG || (provider.alwaysShowOutput && !announced)) console.log(`[${provider.name}] ${line}`);
      const result = provider.onLine(line);
      if (result?.connected) announce(result.url);
    }
  });
}

tunnel.on('exit', (code) => {
  // バックグラウンド設定型（Tailscale）: 設定が済むとコマンドは正常終了する
  if (provider.background && code === 0) {
    funnelActive = true;
    announce(provider.state.url);
    return;
  }
  console.error(`${provider.name} が停止しました（終了コード ${code}）`);
  if (!announced && !provider.alwaysShowOutput) console.error(recent.join('\n'));
  if (providerName === 'tailscale' && recent.some((l) => /listener already exists/.test(l))) {
    // 以前の Funnel（フォアグラウンド実行の残りや別の設定）が 443 番を使っている
    console.error(
      [
        '',
        '以前の Tailscale Funnel / Serve の設定が残っています。次を実行してから、もう一度起動してください。',
        isWindows ? '  Stop-Process -Name tailscale -ErrorAction SilentlyContinue' : '  pkill -x tailscale',
        '  tailscale serve reset',
        '',
        '（tailscale serve reset は、この PC の Tailscale Serve / Funnel の設定をすべて消去します）',
      ].join('\n'),
    );
  }
  shutdown(code ?? 1);
});
