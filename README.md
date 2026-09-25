# face-history

ブラウザのカメラで **顔登録・顔認証** を行い、**認証履歴を保存** する Web アプリです。

- 顔の検出と特徴量（128 次元ベクトル）の抽出はブラウザ内で [@vladmandic/face-api](https://github.com/vladmandic/face-api) が行います。
- サーバー（Node.js + Express）は特徴量の照合と、ユーザー・履歴の保存を担当します。**顔画像そのものは登録時に保存しません。**
- モデルファイルは npm パッケージから配信するため、外部 CDN なしで動きます。
- **ライブネス検知**（まばたき・顔の向き・口の動きによるチャレンジ）で、写真や静止画面によるなりすましを防ぎます。

## 使い方

```bash
npm install
npm start
# → http://127.0.0.1:3000 を開く
```

1. 「カメラを起動」を押してカメラを許可します。
2. **登録**タブ: 名前を入力して「撮影して登録」を押し、画面の指示に従います（ライブネス検知の後、正面を向いたまま 3 枚自動撮影）。
3. **認証**タブ: 「認証する」を押し、カメラ映像に表示される指示（例:「顔をゆっくり左に向けてください」→「ゆっくりまばたきしてください」）に従います。最後に正面を向くと照合され、結果は自動で履歴に保存されます。
4. **履歴**タブ: 認証の成功／失敗、登録・削除の記録を新しい順に表示します。認証時の顔のサムネイルも残ります。ライブネス検知に失敗した試行は「なりすまし疑い」として、提示された顔の人物名とともに記録されます。
5. **ユーザー**タブ: サンプル追加（精度向上）とユーザー削除ができます。サンプル追加もライブネス検知が必要で、そのユーザー本人の顔（登録済みの顔と一致するもの）しか追加できません。

> カメラはセキュアコンテキスト（`localhost` または HTTPS）でのみ使えます。スマートフォンから使う場合は下記「スマートフォンから使う（HTTPS）」を参照してください。

### 管理者ログイン

`ADMIN_PASSWORD` を設定すると、**登録・履歴・ユーザー管理** の各タブと対応する API が管理者専用になります。**顔認証** は誰でも利用できます（受付端末などでの利用を想定）。

```bash
ADMIN_PASSWORD='十分に長いパスワード' npm start
```

- 右上の「管理者ログイン」、または管理用タブを開くとパスワード入力画面が表示されます。
- セッションは 8 時間有効（HttpOnly / SameSite=Strict の Cookie）。サーバーを再起動するとログアウトされます。
- ログインに 5 回失敗すると、その IP からは 15 分間ログインできません。
- `HOST` を `127.0.0.1` 以外（LAN やインターネットに公開）にする場合、`ADMIN_PASSWORD` は **必須** です（未設定だと起動しません）。

### バックアップと復元

顔データ（生体情報）と履歴を 1 つの JSON ファイルにまとめて保存・復元できます。**ファイルには顔データが含まれるため、安全な場所に保管してください。**

- **ダウンロード**: ユーザータブの「バックアップをダウンロード」（認証時の顔画像を含めるか選べます）。取得したことは履歴に残ります。
- **復元**: ユーザータブで方法を選んでファイルを指定します。
  - **すべて置き換える**: 現在のデータをバックアップの内容で置き換えます。置き換える前の状態は `data/backups/pre-restore-<日時>.json` に自動保存されます。
  - **追加する**: 現在のデータに無いユーザー・履歴だけを追加します（同じ id・同じ名前のユーザーは追加しません）。
- **定期バックアップ**: `BACKUP_INTERVAL_HOURS=24` のように設定すると、サーバーが `data/backups/auto-<日時>.json` を定期的に書き出し、新しい `BACKUP_KEEP` 件（既定 7）を残します。
- **コマンド**: `npm run backup` で `data/backups/manual-<日時>.json` を書き出します（サーバー稼働中でも可）。cron での定期実行にも使えます。

```bash
npm run backup                          # data/backups/manual-<日時>.json
npm run backup -- --out ./backup.json   # 保存先を指定
npm run backup -- --no-snapshots        # 顔画像を含めない（ファイルが小さくなる）
npm run backup -- --keep 7              # manual-*.json を新しい 7 件だけ残す
```

### インターネットに公開する（Cloudflare Tunnel）

自分の PC で動かしたまま、`https://〜.trycloudflare.com` の URL でどこからでも開けるようにします。**サーバー契約は不要（無料）で、顔データは手元の PC に保存されたまま** です。PC を起動している間だけ公開されます。

**1. cloudflared をインストール（初回のみ）**

```bash
# Windows（PowerShell）
winget install --id Cloudflare.cloudflared
# Mac
brew install cloudflared
```

インストール後はターミナルを開き直してください。

**2. 公開する**

```bash
# Mac / Linux
ADMIN_PASSWORD='十分に長いパスワード' npm run public

# Windows（PowerShell）
$env:ADMIN_PASSWORD="十分に長いパスワード"; npm run public
```

接続できると、次のように公開 URL が表示されます。スマートフォンなどでこの URL を開いてください（HTTPS なのでカメラも使えます）。

```
================================================================
  インターネットに公開しました
  URL: https://xxxx-xxxx-xxxx.trycloudflare.com
  ...
================================================================
```

- 停止は `Ctrl+C`（サーバーとトンネルの両方が止まります）。
- `ADMIN_PASSWORD`（8 文字以上）は必須です。登録・履歴・ユーザー管理はログインしないと使えません。顔認証は誰でも使えます。
- 認証・ログインなど誰でも呼べる API は、アクセス元 IP ごとに 1 分 30 回までに制限しています。
- **URL は起動するたびに変わります。** 固定したい場合は下記「URL を固定する」を参照してください。
- 「トンネルに接続できません」と表示される場合は、ネットワーク（会社・学校など）で Cloudflare への通信が制限されている可能性があります。別の回線で試すか、`CLOUDFLARED_PROTOCOL=http2` を付けて実行してください。
- Cloudflare の無料プランでは 1 回のアップロードが 100MB までのため、それより大きなバックアップはトンネル経由では復元できません（PC 上で `http://127.0.0.1:3000` を開いて復元してください）。

**URL を固定する（任意）**

- **Tailscale Funnel（無料・おすすめ）**: 下記「固定 URL で公開する（Tailscale Funnel）」を参照してください。
- **Cloudflare ＋ 独自ドメイン**: `face.example.com` のような好きな URL にできます。Cloudflare のアカウントと、Cloudflare で管理している独自ドメインが必要です。

1. Cloudflare ダッシュボードの **Zero Trust → Networks → Tunnels** でトンネルを作成し、表示されるトークンを控える
2. トンネルの **Public Hostname** に、使いたいホスト名（例: `face.example.com`）とサービス `http://localhost:3000` を設定する
3. トークンを指定して起動する

```bash
ADMIN_PASSWORD='十分に長いパスワード' TUNNEL_TOKEN='控えたトークン' npm run public
```

### 固定 URL で公開する（Tailscale Funnel）

無料で、`https://<PC名>.<tailnet名>.ts.net` の **固定 URL** で公開できます。Cloudflare Tunnel と同じく、顔データは手元の PC に保存されたままです。

**1. 準備（初回のみ）**

1. https://login.tailscale.com/start で Tailscale の無料アカウントを作成（Google アカウント等でログイン可）
2. Tailscale をインストールし、アプリを起動してログイン

   ```bash
   # Windows（PowerShell）
   winget install --id tailscale.tailscale
   # Mac
   brew install --cask tailscale
   ```

3. ターミナルを開き直す

**2. 公開する**

```bash
# Mac / Linux
ADMIN_PASSWORD='十分に長いパスワード' npm run public:tailscale

# Windows（PowerShell）
$env:ADMIN_PASSWORD="十分に長いパスワード"; npm run public:tailscale
```

- **初回だけ**、`https://login.tailscale.com/...` というリンクが表示されます。ブラウザで開き、Funnel（と HTTPS）の利用を許可してください。許可すると自動で公開が始まります。
- 「インターネットに公開しました」と固定 URL が表示されたら完了です。次回以降も同じ URL です。
- 停止は `Ctrl+C`（サーバーと Funnel の両方が止まります）。
- URL の `<PC名>` の部分は、Tailscale の管理画面（Machines → 対象の PC → Edit machine name）で `face-history` などに変更できます。
- Funnel のこの使い方には Tailscale 1.52 以降が必要です。
- `listener already exists for port 443` と表示されて止まる場合は、以前の Funnel / Serve の設定が残っています。Windows なら `Stop-Process -Name tailscale -ErrorAction SilentlyContinue` → `tailscale serve reset` を実行してから再度起動してください（この PC の Serve / Funnel 設定がすべて消去されます）。
- 異常終了などで Funnel が残った場合は `tailscale funnel --https=443 off` で無効にできます。
- Windows では、公開中の PowerShell の画面をクリックすると「選択」モードになり処理が一時停止します。タイトルに「選択」と出たら `Esc` で解除してください。

### スマートフォンから使う（HTTPS）

スマートフォンのブラウザでカメラを使うには HTTPS が必要です。証明書を用意して `TLS_CERT` / `TLS_KEY` を指定すると、HTTPS で起動します。

```bash
# 例: mkcert でローカル用の証明書を作成（https://github.com/FiloSottile/mkcert）
mkcert -install
mkcert 192.168.1.10 localhost        # PC の LAN 内 IP アドレス

HOST=0.0.0.0 ADMIN_PASSWORD='十分に長いパスワード' \
TLS_CERT=./192.168.1.10+1.pem TLS_KEY=./192.168.1.10+1-key.pem npm start
# → スマートフォンで https://192.168.1.10:3000 を開く
```

スマートフォン側で証明書を信頼するには、mkcert のルート証明書（`mkcert -CAROOT` の場所にある `rootCA.pem`）を端末にインストールしてください。nginx などのリバースプロキシで HTTPS 化する場合は、`TRUST_PROXY=1` を設定してください。

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `HOST` | `127.0.0.1` | 待ち受けアドレス。LAN に公開する場合は `0.0.0.0` |
| `DATA_DIR` | `./data` | 保存先ディレクトリ |
| `FACE_THRESHOLD` | `0.5` | 照合のしきい値（ユークリッド距離）。小さいほど厳格。推奨 0.4〜0.6 |
| `ADMIN_PASSWORD` | （なし） | 管理者パスワード（8 文字以上）。設定すると登録・履歴・ユーザー管理がログイン必須になる |
| `TLS_CERT` / `TLS_KEY` | （なし） | HTTPS で起動する場合の証明書・秘密鍵ファイルのパス |
| `PUBLIC` | （なし） | `1` でインターネット公開モード（`ADMIN_PASSWORD` 必須）。`npm run public` が自動で設定 |
| `TUNNEL_TOKEN` | （なし） | `npm run public` で Cloudflare の固定 URL トンネルを使う場合のトークン |
| `TUNNEL` | `cloudflare` | `npm run public` で使うトンネル（`cloudflare` / `tailscale`）。`npm run public:tailscale` は `tailscale` と同じ |
| `TRUST_PROXY` | （なし） | リバースプロキシ配下で動かす場合に設定（Express の `trust proxy`。例: `1`） |
| `BACKUP_INTERVAL_HOURS` | `0` | 定期バックアップの間隔（時間）。`0` で無効 |
| `BACKUP_KEEP` | `7` | 定期バックアップを残す件数 |
| `BACKUP_DIR` | `<DATA_DIR>/backups` | 自動・定期・コマンドでのバックアップの保存先 |
| `LIVENESS` | `on` | ライブネス検知（認証・登録・サンプル追加）。`off` で無効（画像ファイルでの認証・登録が可能になる） |

## 仕組み

- 各ユーザーは最大 10 件の顔特徴量サンプルを持ち、認証時は全サンプルとの最小距離で判定します。
- 距離がしきい値以下なら成功。既に登録済みの顔や同名での二重登録は拒否します。
- 履歴は最大 5,000 件を保持し、古いものからスナップショットごと削除します。

### ライブネス検知

```
ブラウザ                                   サーバー
  │  POST /api/liveness/challenge  ──────▶  ランダムな動作を 2 つ発行（1 回限り・120 秒有効）
  │  ◀──────  例: [turn_left, blink]
  │  指示を表示し、68 点ランドマークを毎フレーム記録
  │  正面に戻ったら照合用の顔を撮影
  │  POST /api/auth  ─────────────────────▶  ① 同じ判定ロジックでランドマーク列を再検証
  │    descriptor, snapshot,                 ② 記録時間がチャレンジ発行からの経過時間内か
  │    liveness { challengeId, frames,       ③ 動作中の顔と照合する顔が同一人物か
  │               checkpoints }              ④ 登録済みの顔と照合 → 履歴に保存
```

- 動作は「まばたき」「左を向く」「右を向く」「口を開ける」から 2 つをランダムな順番で指示します。録画の再生では順番に追従できません。
- 各動作は **ニュートラル（目を開ける・正面・口を閉じる）→ 動作** の遷移で判定するため、最初から横を向いた写真や口を開けた写真では通りません。
- 判定ロジックは `public/shared/liveness.js` にあり、ブラウザ（指示の表示）とサーバー（検証）で同じコードを使います。
- 指標: 目の開き（EAR）、口の開き（MAR）、顔の左右の向き（鼻先から左右の顎端までの距離比）。しきい値は同ファイルの `LIVENESS` で調整できます。
- ライブネス検知は **認証・登録・サンプル追加** のすべてに適用されます。有効な間は写真と区別できないため「画像で認証」「画像から登録」は表示されません。
- 登録・サンプル追加では、動作中の顔と撮影した全サンプルが同一人物かも確認します。失敗した試行は「なりすまし疑い」として履歴に残ります。

### データ保存

```
data/
├── db.json          # ユーザー（名前・顔特徴量）と履歴
├── snapshots/*.jpg  # 認証時の顔サムネイル（160px）
└── backups/*.json   # 復元前の自動保存・定期バックアップ・コマンドでのバックアップ
```

`data/` は生体情報を含むため `.gitignore` 済みです。バックアップや削除はこのディレクトリ単位で行ってください。

## API

🔒 は `ADMIN_PASSWORD` 設定時に管理者ログインが必要な API です（未ログインは 401 `{ code: "admin_required" }`）。

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/admin/status` | 管理者ログインの有効/無効とログイン状態 |
| `POST` | `/api/admin/login` | 管理者ログイン `{ password }` |
| `POST` | `/api/admin/logout` | ログアウト |
| `GET` | `/api/config` | しきい値・ライブネス検知の有効/無効など |
| `POST` | `/api/liveness/challenge` | ライブネス検知のチャレンジ発行 |
| `GET` | `/api/users` 🔒 | ユーザー一覧（特徴量は返さない） |
| `POST` | `/api/users` 🔒 | 顔登録 `{ name, descriptors: number[128][], liveness? }`（ライブネス失敗時は 422） |
| `POST` | `/api/users/:id/samples` 🔒 | サンプル追加 `{ descriptors, liveness? }`（本人の顔と一致しない場合は 403） |
| `DELETE` | `/api/users/:id` 🔒 | ユーザー削除 |
| `POST` | `/api/auth` | 顔認証 `{ descriptor: number[128], snapshot?: "data:image/jpeg;base64,...", liveness?: { challengeId, frames: { t, points: number[68][2] }[], checkpoints: number[128][] } }`（`liveness` は検知有効時に必須。登録・サンプル追加も同じ形式） |
| `GET` | `/api/history` 🔒 | 履歴 `?limit&offset&type=auth\|register\|samples\|delete\|backup\|restore&result=success\|failure&userId` |
| `GET` | `/api/history/:id/snapshot` 🔒 | 認証時のサムネイル |
| `DELETE` | `/api/history` 🔒 | 履歴を全削除 |
| `GET` | `/api/backup` 🔒 | バックアップのダウンロード `?snapshots=0` で顔画像なし |
| `POST` | `/api/backup/restore` 🔒 | 復元 `?mode=replace\|merge`（本文はバックアップファイルの JSON、最大 200MB） |

## 注意事項

- ライブネス検知はカメラ映像の動きに基づく簡易的なもので、認証を受けた PAD（なりすまし検知）製品ではありません。写真・静止画面・録画の再生は防げますが、精巧なマスクや、API を直接呼び出して偽のランドマークを送る攻撃は防げません。入退室管理など厳密な本人確認には単独で使わないでください。
- 既定では `127.0.0.1` でのみ待ち受けます。外部に公開する場合は `ADMIN_PASSWORD` の設定（必須）に加え、HTTPS で運用してください（HTTP ではパスワードが平文で流れます）。`npm run public`（Cloudflare Tunnel）は自動的に HTTPS になります。
- 公開 URL を知っている人は誰でも顔認証を試せます（結果は履歴に残ります）。URL は必要な人にだけ共有してください。

## テスト

```bash
npm test
```
