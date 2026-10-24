# instagram-api-safe

ログイン済みのInstagram Webページ内で公開情報を取得し、明示的に有効化した場合は画像・動画のストーリーズ投稿を行う実験的なTypeScriptモノレポです。

## 重要な注意

Instagramの利用規約は、明示的な許可のない自動アクセスや情報収集を禁止しています。このプロジェクトは、許可済みの試験環境・所有アカウントでの研究用途を想定しており、規約準拠やアカウント停止回避を保証しません。検知回避、CAPTCHA回避、プロキシローテーション、ストーリーズ以外の投稿、いいね、フォローは実装しません。コメント送信は明示指定された自分のストーリーへの文面に限ります。DM取得・テキスト送信は明示的に有効化する別サービスです。

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

## アカウント切り替え

DashboardまたはURL投稿Skillから、実ログインアカウントを照合して次の投稿先を選択できます。選択は再起動後も保持し、処理中・再開中の投稿は元のアカウントに固定します。[一覧・切り替え・別アカウントの登録](docs/accounts.md)を参照してください。

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

DM通信がログインページへ転送された場合は `SESSION_NOT_READY` を返します。プロファイルの `ready` 表示だけではDMセッションの有効性を保証しません。再ログイン後、まず会話一覧と対象会話を取得して確認してください。送信ジョブが `unknown` の場合は、再ログインしても自動再送しません。

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

送信前にアカウントと会話を照合し、プロファイル単位で既存操作と直列化します。取得用の固定`direct_v2`通信はブラウザ内で実行し、送信はInstagramの通常のDM画面を操作します。Webの会話IDを照合してからEnterを1回だけ押し、送信前に存在しなかった自分のメッセージをAPIで読み戻せた場合だけ`sent`にします。認証値とraw応答は外へ出しません。画面を開くことで、その会話の未読メッセージが既読になる場合があります。本文は台帳・ログ・ジョブ応答に含めず、宛先と本文のハッシュで重複を判定します。同じキーの異なる本文・宛先は`409`です。再起動後の`sending`は`unknown`、`queued`・`validating`は`failed`となり、自動再送しません。`unknown`はInstagram上で確認し、台帳を削除したり新しいキーで再送したりしないでください。

DM一覧・メッセージ取得と通常の一対一会話へのテキスト送信は実アカウントで確認済みです。グループ会話の実送信は未検証です。通常テストにはモックを使用します。送信試験は宛先と本文を指定した明示的な依頼で行います。

### 投稿カードをストーリーへ共有

HTTPモードで、Instagram投稿を元投稿リンク付きの画像カードとしてストーリーへ共有できます。通常公開・元投稿参照の読み戻し・試験投稿の削除まで実アカウントで検証済みです。`stories.feedPostSharingEnabled: true` で有効化します。公開・共有許可、投稿者、公開後の参照を検証します。操作方法とAPIは [投稿カードの共有](docs/feed-post-stories.md) を参照してください。

### メンション受付・ネイティブ再投稿

`storyMentions: { "enabled": true, "stateDir": "./story_mention_data", "operationTimeoutMs": 300000 }`で受付を有効化します。DMやローカル素材投稿とは別サービスです。自動更新・自動公開・Dashboard操作は追加していません。

- `POST /v1/story-mentions/refresh`: 全送信者の通常DM・リクエスト一覧と会話をページングし、自分宛てのメンションだけを更新します。空本文または`{}`で指定し、`202`と更新ジョブを受け取ります。
- `GET /v1/story-mention-refresh-jobs/:id`: 更新の進捗・結果を取得します。全ページの取得が完了した場合だけ一覧を更新します。
- `GET /v1/story-mentions?limit=20&cursor=...`: 自分のアカウントの依頼一覧を取得します。`available / expired / removed / unavailable / unknown`と理由、送信者、元メディアIDを返します。署名付き素材URLやDM本文は返しません。
- `POST /v1/story-mentions/:id/repost`: 必須の`Idempotency-Key`で再投稿ジョブを作成します。公開範囲は通常公開のみで、要求本文は空または`{}`です。
- `GET /v1/story-repost-jobs/:id`: `queued / validating / publishing / published / failed / unknown`を取得します。

**現在のネイティブ再投稿方式は未検証です。** 元ストーリーが再投稿可能でも、公開ジョブは`failed / NATIVE_REPOST_UNAVAILABLE`として公開前に停止します。`available`は元投稿側の許可であり、Relayで公開できる保証ではありません。素材のダウンロード・再アップロードに置き換えません。

現在のWebでは旧メッセージリクエストAPIが`404`になるため、リクエスト0件を確認できた場合だけ全件更新を完了します。リクエストが存在する、または件数を確認できない場合は`PENDING_INBOX_UNAVAILABLE`で更新を停止し、途中取得を全件成功として扱いません。暗号化などで読み取れない会話がある場合も更新ジョブは失敗し、既存一覧を維持します。

同じキーの同じ要求は既存ジョブ、異なる要求は`409`です。公開開始後はアカウント・元メディア単位で新しいキーによる重複も防ぎます。再起動時の`publishing`は`unknown`、公開前の途中ジョブは`failed`にし、自動再送しません。`unknown`はInstagramで公開済みか確認し、台帳を削除して再送しないでください。台帳には受付メタデータとジョブだけを保存し、`story_mention_data/`をコミットしません。

```powershell
$headers = @{ Authorization = "Bearer $env:INSTAGRAM_RELAY_API_TOKEN"; "x-profile-name" = "account1" }
$refresh = Invoke-RestMethod -Method Post -Headers $headers http://127.0.0.1:3000/v1/story-mentions/refresh
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3000/v1/story-mention-refresh-jobs/$($refresh.data.id)"
$requests = Invoke-RestMethod -Headers $headers http://127.0.0.1:3000/v1/story-mentions
# 元投稿と送信者を確認した依頼IDを指定
$headers["Idempotency-Key"] = "mention-repost-001"
$job = Invoke-RestMethod -Method Post -Headers $headers "http://127.0.0.1:3000/v1/story-mentions/確認した依頼ID/repost"
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3000/v1/story-repost-jobs/$($job.data.id)"
```

### ローカル素材のストーリーズ投稿

ブラウザーを常駐させずに使う場合は、ストーリー・ハイライト専用の[HTTPモード](docs/http-mode.md)を設定できます。既存の台帳・プレビューを共用し、認証はGit管理外のローカルセッションファイルに保存します。

Dashboardには素材・実ログインアカウント・通常公開／親しい友達を表示する投稿前プレビューがあります。明示確認後の専用`/publish`呼出しで公開し、再読込・通信切断後は同じ操作IDの照会だけを行います。詳細と従来APIの互換性は[投稿前プレビューと確認](packages/server/README.md#投稿前プレビューと確認)を参照してください。

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
$body = @{ filePath = "C:/Users/you/Videos/Instagram/story.mp4"; audience = "close_friends" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers $headers -ContentType "application/json" -Body $body http://127.0.0.1:3000/v1/stories
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3000/v1/story-jobs/$($job.data.id)"
```

`POST /v1/stories`は素材を検証・コピーして`202`と`data.id`を返します。`GET /v1/story-jobs/:id`で状態を取得します。JSONの入力は`filePath`と任意の`audience`です。`audience`の既定値は`all`です。`close_friends`は親しい友達への限定公開です。公開応答の`audience: besties`を確認できた場合だけ成功にし、通常公開への置換は行いません。キーは1〜128文字の英数字・`._:-`で指定してください。投稿は選択プロファイルの現在のログインアカウントへ行い、公開直前にもアカウントを照合します。Facebookへの同時投稿は行いません。

JPEG・PNGは8MiB以下、MP4は100MiB以下、H.264映像と任意のAAC音声、1〜60秒、各辺4096px以下に限定します。これはrelay独自の保守的な制限で、Instagram側の受け入れを保証する値ではありません。文字・音楽・リンク・自動変換・分割は未対応です。動画の必要なサムネイルだけをブラウザ内で生成し、動画本体は加工しません。

任意の`caption`で投稿データのキャプションを指定できます（UTF-16で2200文字以内、既定値は空文字）。画像・動画上に文字は描画しません。文面を指定した場合は公開応答の`media.caption.text`との一致を確認し、根拠がなければ`unknown`にします。キャプション付き投稿の実アカウント検証は未実施です。

公開範囲はジョブの`audience`に保存します。同じキーで素材パス・公開範囲・キャプションを変えると`409`になります。本文はジョブ応答・Relayログに含めず、重複判定にはハッシュを使います。旧台帳は通常公開・キャプションなしとして読み込みます。YouTube／TikTokのURLから投稿する個人SkillはGoogle Driveの`Agent/Skills/instagram-story-from-url`にあり、yt-dlpで配信元のH.264/AAC MP4を選び、ffprobeで検証します。Skillでコメント欄へ文面を送る指定は`--comment "コメントの文面"`です。`caption`ではコメント欄へ書き込めません。

`POST /v1/story-jobs/:id/comments` は公開済みの自分のストーリーだけに、`{ "text": "文面" }`を1回送信します。専用のIdempotency-Keyと元のプロファイルを指定します。アカウント・公開範囲・メディアID・既存コメントを照合し、応答と読み戻しが一致した場合だけ`comment.state: completed`になります。本文はジョブ応答へ返さず、結果不明では再送しません。ストーリー専用経路を使用しますが、実アカウントでは受付応答後の保存を確認できておらず、コメント送信は現在成功未確認です。Skillはコメントの成否とは独立して指定済みハイライトを処理します。

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

## ハイライト登録

Relayで公開済みのストーリーを、自分の既存ハイライトへ追加できます。URL投稿Skillの`--highlight`で投稿後の登録まで実行できます。[API・再開と重複防止・検証範囲](docs/highlights.md)と[配布用Skill](skills/instagram-story-from-url/SKILL.md)を参照してください。
