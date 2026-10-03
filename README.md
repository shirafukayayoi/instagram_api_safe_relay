# instagram-api-safe

ログイン済みのInstagram Webページ内で公開情報を取得し、明示的に有効化した場合は画像・動画のストーリーズ投稿を行う実験的なTypeScriptモノレポです。

## 重要な注意

Instagramの利用規約は、明示的な許可のない自動アクセスや情報収集を禁止しています。このプロジェクトは、許可済みの試験環境・所有アカウントでの研究用途を想定しており、規約準拠やアカウント停止回避を保証しません。検知回避、CAPTCHA回避、プロキシローテーション、ストーリーズ以外の投稿、いいね、フォロー、コメント投稿は実装しません。DM取得・テキスト送信は明示的に有効化する別サービスです。

`safe` はCookie、CSRF値、LSD、認証ヘッダーをNode.jsやHTTPクライアントへ渡さず、任意の内部APIを公開しない設計を表します。

## パッケージ

- `instagram-api-safe-contracts`: 4操作の入力・出力・エラー契約
- `instagram-api-safe-inject`: MAIN worldのread-onlyカタログ実行器
- `instagram-api-safe-request`: Playwrightクライアント
- `instagram-api-safe-wxt`: ブラウザ拡張向けWXTアダプター
- `instagram-api-safe-relay`: localhost限定のHTTP relay
- `instagram-api-safe-dashboard`: マスク済み状態表示

公開情報の読み取り操作は次の4つに固定されています。ストーリーズ投稿は別の契約・実行サービスです。

- `getPublicProfile`
- `listPublicProfileMedia`
- `getPublicMedia`
- `listPublicMediaComments`

任意URL、任意path、任意GraphQL、raw request/response、汎用`dispatch()`は公開しません。

## セットアップ

```powershell
corepack enable
pnpm install
pnpm build
Copy-Item settings.example.json settings.json
$env:INSTAGRAM_RELAY_API_TOKEN = -join ((1..48) | ForEach-Object { [char](Get-Random -Minimum 48 -Maximum 123) })
pnpm dev:relay
```

初回はheadedブラウザが開くため、手動でInstagramへログインします。Relayは常に`127.0.0.1`へbindします。

Relayはセッションを定期確認し、`ready`、`login_required`、`two_factor_required`、`challenge_required`、`unknown`を`/profiles`へ反映します。ログイン、2FA、challengeはブラウザ上で手動完了してください。ページのclose/crashやブラウザ切断時は、ページ再読込、同じcontextで新規page、context再起動の順に自動復旧します。確認間隔と再試行間隔は`sessionCheckIntervalSeconds`、`recoveryRetrySeconds`で変更できます。

## HTTP API

```powershell
$headers = @{ Authorization = "Bearer $env:INSTAGRAM_RELAY_API_TOKEN" }
Invoke-RestMethod -Headers $headers http://127.0.0.1:3000/v1/profiles/instagram
Invoke-RestMethod -Headers $headers 'http://127.0.0.1:3000/v1/profiles/instagram/media?kind=all&limit=12'
Invoke-RestMethod -Headers $headers http://127.0.0.1:3000/v1/media/SHORTCODE
Invoke-RestMethod -Headers $headers 'http://127.0.0.1:3000/v1/media/SHORTCODE/comments?limit=20'
```

複数プロファイルを設定した場合は`x-profile-name`ヘッダーが必須です。すべての応答は`Cache-Control: no-store`です。

## 開発

### DM取得・送信

設定例の`direct.enabled`は既定で`false`です。`direct: { "enabled": true, "stateDir": "./dm_data", "operationTimeoutMs": 60000 }`を設定して再起動します。Bearer認証・`x-profile-name`は他のAPIと共通です。

- `GET /v1/dm/threads?limit=20&cursor=...`: ログインアカウントの会話一覧、参加者、ページ情報を取得します。
- `GET /v1/dm/threads/:id/messages?limit=20&cursor=...`: 会話のメッセージID、送信者、時刻（Instagramのマイクロ秒文字列）、種類、テキストを取得します。非テキストの本文は`null`です。
- `POST /v1/dm/messages`: 既存会話へテキストを送信します。必須の`Idempotency-Key`と`{"threadId":"会話ID","text":"本文"}`を指定し、`202`とジョブを受け取ります。本文はUTF-16で1〜1000文字、要求は8KiB以下です。
- `GET /v1/dm/jobs/:id`: `queued → validating → sending → sent`の進捗を取得します。送信前の失敗は`failed`、送信後の成否不明は`unknown`です。`sent`はInstagramによる受付確認で、相手の既読確認ではありません。

```powershell
$headers = @{ Authorization = "Bearer $env:INSTAGRAM_RELAY_API_TOKEN"; "x-profile-name" = "account1" }
$inbox = Invoke-RestMethod -Headers $headers 'http://127.0.0.1:3000/v1/dm/threads?limit=10'
# $inbox.data.threads の参加者と id を確認してから宛先を指定
$headers["Idempotency-Key"] = "dm-20261003-001"
$body = @{ threadId = "確認した会話ID"; text = "送信する本文" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' -Body $body http://127.0.0.1:3000/v1/dm/messages
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3000/v1/dm/jobs/$($job.data.id)"
```

宛先は既存の会話IDで指定し、ユーザー名からの新規会話作成、添付ファイル送信、リアクション、削除、リクエスト承認、自動返信、既読操作は未対応です。暗号化・読み取り専用・未承認リクエストの会話は送信しません。取得もこの固定APIで読める範囲に限定され、暗号化された内容の取得は保証しません。

送信前にアカウントと会話を照合し、プロファイル単位で既存操作と直列化します。固定の`direct_v2`通信はブラウザ内で実行し、認証値とraw応答を外へ出しません。本文は台帳・ログ・ジョブ応答に含めず、宛先と本文のハッシュで重複を判定します。同じキーの異なる本文・宛先は`409`です。再起動後の`sending`は`unknown`、`queued`・`validating`は`failed`となり、自動再送しません。`unknown`はInstagram上で確認し、台帳を削除したり新しいキーで再送したりしないでください。

DM一覧・メッセージ取得は実アカウントで確認済みです。実際のDM送信は未検証で、通常テストにはモックを使用します。送信試験は宛先と本文を指定した明示的な依頼で行います。

### ストーリーズ投稿

既定では無効です。Chromiumと`ffprobe`が必要です。`settings.json`へ設定し、relayを再起動してください。

```json
"stories": {
  "enabled": true,
  "allowedMediaDirectories": ["C:/Users/you/Videos/Instagram"],
  "stateDir": "./story_data",
  "ffprobePath": "ffprobe",
  "operationTimeoutMs": 300000
}
```

素材は許可ディレクトリ内の絶対パスで指定します。ディレクトリへのリンク・ジャンクションも実体パスで検証します。相対設定パスの基準はrelayの作業ディレクトリです。ルートの`pnpm start:relay`では`packages/server/`が基準になります。`ffprobe`がPATHにない場合は実行ファイルの絶対パスを設定してください。

```powershell
$headers = @{ Authorization = "Bearer $env:INSTAGRAM_RELAY_API_TOKEN"; "Idempotency-Key" = "story-20261002-001" }
# 複数プロファイルがある場合は $headers["x-profile-name"] = "account1" も指定
$body = @{ filePath = "C:/Users/you/Videos/Instagram/story.mp4"; audience = "close_friends"; caption = "コメントの文面" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" -Body $body http://127.0.0.1:3000/v1/stories
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3000/v1/story-jobs/$($job.data.id)"
```

`POST /v1/stories`は素材を検証・コピーして`202`と`data.id`を返します。`GET /v1/story-jobs/:id`で状態を取得します。JSONの入力は`filePath`と任意の`audience`です。`audience`の既定値は`all`です。`close_friends`は親しい友達への限定公開です。公開応答の`audience: besties`を確認できた場合だけ成功にし、通常公開への置換は行いません。キーは1〜128文字の英数字・`._:-`で指定してください。投稿は選択プロファイルの現在のログインアカウントへ行い、公開直前にもアカウントを照合します。Facebookへの同時投稿は行いません。

JPEG・PNGは8MiB以下、MP4は100MiB以下、H.264映像と任意のAAC音声、1〜60秒、各辺4096px以下に限定します。これはrelay独自の保守的な制限で、Instagram側の受け入れを保証する値ではありません。文字・音楽・リンク・自動変換・分割は未対応です。動画の必要なサムネイルだけをブラウザ内で生成し、動画本体は加工しません。

任意の`caption`で投稿データのキャプションを指定できます（UTF-16で2200文字以内、既定値は空文字）。画像・動画上に文字は描画しません。文面を指定した場合は公開応答の`media.caption.text`との一致を確認し、根拠がなければ`unknown`にします。キャプション付き投稿の実アカウント検証は未実施です。

公開範囲はジョブの`audience`に保存します。同じキーで素材パス・公開範囲・キャプションを変えると`409`になります。本文はジョブ応答・Relayログに含めず、重複判定にはハッシュを使います。旧台帳は通常公開・キャプションなしとして読み込みます。YouTube／TikTokのURLから投稿する個人SkillはGoogle Driveの`Agent/Skills/instagram-story-from-url`にあり、yt-dlpで配信元のH.264/AAC MP4を選び、ffprobeで検証します。Skillでの文面指定は`--caption "コメントの文面"`です。

ジョブは`queued → uploading → publishing → published`と進みます。公開前の失敗は`failed`、公開後の応答喪失などは`unknown`です。アップロードだけでは成功としません。同じプロファイル・キー・パスの再要求は既存ジョブを返し、異なるパスで同じキーを使うと`409`になります。同じパスのファイルを差し替えても、同じキーでは新規投稿しません。

台帳は再起動後も保持します。再起動時の`publishing`は`unknown`、`queued`と`uploading`は`failed / INTERRUPTED`になり、再送しません。`unknown`ではInstagram上で確認し、新しいキーによる再投稿を控えてください。素材の専用コピーは処理後に削除しますが、元の素材と台帳は保持します。**台帳を削除すると重複防止の記録も失われます。** 台帳を同時に使う複数relayや破損した台帳は拒否します。

モバイルWebの画像用画面は動画選択に対応していないため、画像・動画ともInstagram配信コードの確認済みアップロード関数と`configure_to_story`を専用タブ内で使用します。Cookie・認証ヘッダーはブラウザ内に留め、書き込み先を固定し、公開要求はジョブごとに1回に制限します。モジュールを確認できない場合は`CATALOG_STALE`として失敗します。非公開APIの将来の互換性は保証しません。通常のCIはInstagramへ投稿しません。

### 検証コマンド

```powershell
pnpm type-check
pnpm test
pnpm build
pnpm lint
```

実Instagramへアクセスするsmoke testは通常CIに含めません。ログイン済みブラウザを閉じてから、明示的に実行します。

```powershell
$env:INSTAGRAM_SMOKE_USERNAME = "masamidrums"
pnpm test:live
```

4つの公開操作を順番に確認し、操作名・件数・所要時間だけを表示します。内部APIのpathやレスポンス構造が変わった場合、未知の通信を試行せず`CATALOG_STALE`または`UPSTREAM_CHANGED`を返します。非公開または公開性不明のコメント投稿者はブラウザ内で除外され、Node.js側へ渡りません。

## ライセンスと帰属

MIT License。本プロジェクトの構造と一部の実装方針は [fa0311/twitter_api_safe_relay](https://github.com/fa0311/twitter_api_safe_relay) を参考にしています。
