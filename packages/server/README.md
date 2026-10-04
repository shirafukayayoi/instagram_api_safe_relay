# instagram-api-safe-relay

ログイン済みInstagram Webを利用するローカル専用の実験的relayです。4つの公開情報読み取り操作と、設定で有効化するストーリーズ投稿・DM取得・DMテキスト送信に対応します。任意URLやraw GraphQLは受け付けません。

```powershell
Copy-Item settings.example.json settings.json
$env:INSTAGRAM_RELAY_API_TOKEN = -join ((1..48) | ForEach-Object { [char](Get-Random -Minimum 48 -Maximum 123) })
pnpm dev:relay
```

最初の起動ではheadedブラウザでInstagramへ手動ログインしてください。明示的な許可なく自動アクセスする行為はInstagramの規約に抵触する可能性があります。

`stories.enabled`は既定で`false`です。有効化にはChromium、`ffprobe`、`stories.allowedMediaDirectories`が必要です。`POST /v1/stories`へ`filePath`と任意の`audience`のJSON、必須の`Idempotency-Key`を送り、`GET /v1/story-jobs/:id`で結果を確認してください。`audience`の既定値は`all`です。`close_friends`は親しい友達への限定公開です。ブラウザ内で固定の`audience: besties`を送信し、公開応答でも同じ値を確認します。確認できなければ`unknown`にし、自動再送しません。認証と`x-profile-name`の規則は読み取りAPIと共通です。

投稿と読み取りは同一プロファイル内で直列化します。投稿中の自動再読込・復旧は終了まで保留します。素材とキーをログや公開応答へ含めず、台帳は`stories.stateDir`へ保存します。結果不明の公開は再送せず、再起動時も`unknown`を保持します。詳細な制限・設定・使用例はルートREADMEを参照してください。

任意の`caption`で投稿データへキャプションを保存します（UTF-16で2200文字以内）。画面上への文字描画は行いません。公開応答で指定文面を確認できなければ`unknown`とし、再送しません。同じキーでキャプションを変更すると`409`です。本文はジョブ応答やログへ出しません。

## 投稿前プレビューと確認

Dashboardでは次のフローを使います。すべてBearer認証とプロファイル選択が必要です。

| 呼出し | 動作 |
| --- | --- |
| `POST /v1/story-previews` | 従来と同じ素材入力を検証・コピーし、実ログインアカウント、素材情報、公開範囲、操作IDを返す。Instagramへのアップロード・公開は行わない |
| `GET /v1/story-previews/:id/media` | 表示済みコピーの内容を検証して素材を返す。任意パスやURLを受け付けない |
| `GET /v1/story-previews/:id` | 未受理のプレビュー、または受理済みの永続ジョブを照会する |
| `DELETE /v1/story-previews/:id` | 未受理の操作を中止する。受理済み操作には`409`を返す |
| `POST /v1/story-previews/:id/publish` | 厳密な`{"confirmed":true}`を要求し、アップロード・公開を開始する |

プレビューの期限は10分で、Relay再起動後は再作成が必要です。公開はプレビューと同じIDで台帳に記録し、再送・再起動後も同じジョブを返します。公開要求からアカウント・素材・公開範囲・キャプションを変更することはできません。原本の内容が変わった場合は再確認を要求し、アップロード前と公開直前にも実アカウントを照合します。公開済み・`failed`・`unknown`を同じ操作で再実行しません。

互換性のため従来の`POST /v1/stories`は維持しています。これは確認フローを経由せずアップロード・公開を開始するAPIで、既存の`Idempotency-Key`契約も維持します。Dashboardの公開操作は新しい`/publish`だけを使います。公開情報の4操作カタログとWXT契約は変更していません。

## DM

`direct.enabled`を有効にすると、`/v1/dm/threads`、`/v1/dm/threads/:id/messages`、`POST /v1/dm/messages`、`/v1/dm/jobs/:id`が利用できます。送信は既存会話へのテキストのみです。Bearer・プロファイル選択・共通排他処理を維持し、送信台帳は`direct.stateDir`へ保存します。送信前に`sending`を永続化し、結果不明を再送しません。本文をログ・台帳・ジョブ応答へ含めないでください。詳細な設定と制限はルートREADMEを参照してください。
