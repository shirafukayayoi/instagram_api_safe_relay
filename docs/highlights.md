# 既存ハイライトへのストーリー追加

`stories.enabled` が有効な場合に、自分の既存ハイライトへRelayで公開済みのストーリーを追加できます。新規ハイライト作成、削除、名前・カバー編集は提供しません。公開情報の4操作カタログとは別のAPIです。

すべてのAPIに既存のBearer認証と`x-profile-name`を使います。サーバーは`127.0.0.1`にのみbindします。

1. `GET /v1/highlights`: 実ログインアカウントと既存ハイライトの`id`・`title`を返します。
2. `POST /v1/highlights/:id/stories`: `Idempotency-Key`と`{"storyJobId":"<UUID>"}`を渡すと202と登録ジョブを返します。
3. `GET /v1/highlight-jobs/:id`: 登録ジョブの状態を照会します。

```json
{
  "data": {
    "state": "completed",
    "highlight": { "id": "123456", "title": "idol" },
    "mediaId": "987654",
    "audience": "close_friends",
    "alreadyPresent": false
  }
}
```

上記は応答の抜粋です。ジョブには`id`、`profile`、`storyJobId`、`account`、日時、`errorCode`も含まれます。登録済みのストーリーは`alreadyPresent: true`で完了し、保存操作を省きます。

Relayのストーリー台帳で`published`、メディアID、アカウントを確認できた投稿だけを受け付けます。実アカウントと自分のハイライトを照合し、プロファイルの共通実行キューでWebの編集画面を操作します。サムネイルDOMの`ig_cache_key`からメディアIDを照合し、対象以外の選択を維持します。元の公開範囲を変更する操作は行いません。Cookieや認証値をNode.jsへ持ち出さず、任意URL・GraphQL・raw proxyを追加しません。

専用台帳は`stories.stateDir/highlights/`に保存され、既存の`story_data/`と同じくGit管理対象外です。保存直前の`applying`を永続化し、保存後に編集画面の選択済み一覧を開き直して確認します。保存後の失敗や再起動時の`applying`は`unknown`になり、同じキーや同じアカウント・ハイライト・メディアの再要求でも自動再登録しません。

## URL投稿Skill

配布版は[`../skills/instagram-story-from-url/SKILL.md`](../skills/instagram-story-from-url/SKILL.md)にあります。個人用の実体はGoogleドライブのSkills配下に置きます。別のRelayディレクトリを使う場合は`INSTAGRAM_RELAY_REPOSITORY`を設定してください。

投稿コマンドに`--highlight 'idol'`を付けると投稿完了後に登録します。登録先の名前は完全一致です。同名が複数ある場合は`--highlight-id '<数値ID>'`を使用してください。元の公開済み操作を再投稿せず登録するには、同じURL・公開範囲・プロファイル・キャプション・操作IDと`--highlight-only --highlight 'idol'`を指定します。プレビュー・取得のみの実行では登録しません。

登録先と登録ジョブIDを操作JSONに保存し、再開時は状態照会だけを行います。ストーリー公開とハイライト登録の完了は別々に確認します。

## 検証と範囲

日本語・英語のWeb画面に対応し、アーカイブの初期表示にある直近の投稿を対象とします。対象を一意に識別できない場合は停止します。古いストーリーのページ送り、新規ハイライト作成には対応していません。

通常テストはモックで公開済み判定、アカウント照合、重複防止、保存前後の失敗、再起動、認証、無効化を確認します。模擬Web画面を使ったブラウザsmokeでも、対象IDの照合・既存選択の保持・保存前記録・保存後確認・登録済み判定を検証します。

```powershell
pnpm --filter instagram-api-safe-relay exec node --import tsx/esm scripts/highlights-ui-smoke.ts
```

このsmokeにはPlaywright Chromiumが必要です。外部ネットワークはモックし、実アカウントは使用しません。2026-10-08の実アカウントでは、登録済み動画の検出と再実行時の状態照会を検証しました。未登録の動画を新規保存するフローは、実アカウントでは未検証です。
