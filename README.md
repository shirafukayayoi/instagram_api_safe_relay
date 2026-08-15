# instagram-api-safe

ログイン済みのInstagram Webページ内で、公開情報だけを取得する実験的なTypeScriptモノレポです。

## 重要な注意

Instagramの利用規約は、明示的な許可のない自動アクセスや情報収集を禁止しています。このプロジェクトは、許可済みの試験環境・所有アカウントでの研究用途を想定しており、規約準拠やアカウント停止回避を保証しません。検知回避、CAPTCHA回避、プロキシローテーション、投稿、いいね、フォロー、コメント投稿、DMは実装しません。

`safe` はCookie、CSRF値、LSD、認証ヘッダーをNode.jsやHTTPクライアントへ渡さず、任意の内部APIを公開しない設計を表します。

## パッケージ

- `instagram-api-safe-contracts`: 4操作の入力・出力・エラー契約
- `instagram-api-safe-inject`: MAIN worldのread-onlyカタログ実行器
- `instagram-api-safe-request`: Playwrightクライアント
- `instagram-api-safe-wxt`: ブラウザ拡張向けWXTアダプター
- `instagram-api-safe-relay`: localhost限定のHTTP relay
- `instagram-api-safe-dashboard`: マスク済み状態表示

公開操作は次の4つに固定されています。

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
