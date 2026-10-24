# ブラウザーを起動しないストーリー・ハイライト用HTTPモード

`browser.type: "http"` ではChromium・Playwrightのブラウザープロセスを起動せず、Node.jsのHTTP通信で操作します。既存のストーリー・ハイライトAPI、プレビュー、素材検証、投稿台帳、アカウント照合、プロファイル排他を共用します。公開要求・ハイライト保存の自動再送はありません。既存ブラウザー方式も選択できます。

## 設定

Node.js 24・pnpm 11.5.0で依存関係を導入してビルドします。動画の検証にffprobe、動画本体を加工せずサムネイル1枚を作るためにffmpegを使用します。

```json
{
  "name": "account1",
  "home": "https://www.instagram.com/",
  "browser": {
    "type": "http",
    "sessionFile": "../../private_sessions/account1.json"
  }
}
```

`sessionFile`の相対パスはRelayの作業ディレクトリ（通常は`packages/server/`）が基準です。`stories.enabled`、許可素材ディレクトリ、Bearer設定は従来と共通です。必要なら`stories.ffmpegPath`にffmpegの実行パスを指定できます。

HTTPモードはURL投稿Skillのストーリー・ハイライト専用です。公開情報の従来4操作・DM・メンション受付は移植していません。HTTPプロファイルがある設定では`direct.enabled`・`storyMentions.enabled`を無効にしてください。公開情報の4操作はブラウザープロファイルを使用します。

## ログインの移行

ユーザーが許可した自分の専用Chromiumプロファイルだけを対象にします。ログイン・2FA・challengeは手動で完了してください。パスワード入力や追加認証の自動化は行いません。専用ブラウザーを正常終了してから、yt-dlpの入ったPythonで次を実行します。

```bash
python scripts/import-browser-session.py \
  --user-data-dir packages/server/user_data/account1 \
  --account-id '<確認済みの自分の数値ID>' \
  --username '<確認済みの自分のユーザー名>' \
  --output private_sessions/account1.json \
  --keyring BASICTEXT
```

`BASICTEXT`はこのLinux PCのPlaywright専用プロファイル（`--password-store=basic`）向けです。別の保存方式では対応するkeyringを指定してください。通常使っているブラウザーのセッションへ対象を広げません。

セッションはGit管理外の`private_sessions/`へ保存し、ディレクトリを700、ファイルを600にします。既存ファイルは上書きしません。通常運用では移行を繰り返す必要はありません。起動時に実ログインアカウントを読み取り、Cookieが更新された場合は同じローカルファイルへ権限600で保存します。認証値は応答・ログ・DriveのSkill同期へ含めません。

再ログインが必要なときはHTTPモードを停止し、保存してある専用ブラウザー設定に戻して手動ログインします。その後、旧HTTPセッションを保全した別ファイルに移行し、`sessionFile`を切り替えます。台帳・元の専用ブラウザープロファイルを削除しません。

## 固定通信と検証

- 実アカウント：Webの`GET /api/v1/accounts/edit/web_form_data/`を読み取り、サーバーが返したユーザー名と保存済みのアカウントを照合します。編集・保存は行いません。
- ハイライト一覧・登録済みメディア：`PolarisProfileStoryHighlightsTrayContentQuery`と`PolarisStoriesV3HighlightsPageQuery`の固定2クエリだけを使います。ページングが完了しない場合は途中結果を返しません。
- 素材：検証したコピーを固定rupload先へ送ります。動画本体の再エンコードは行いません。
- 公開：固定の`/api/v1/media/configure_to_story/`を1回だけ呼び、メディアID・所有者・親しい友達の`audience: besties`・指定キャプションを照合します。根拠がなければ`unknown`です。
- ハイライト登録：固定の`/api/v1/highlights/highlight:<ID>/edit_reel/`へ対象IDの追加だけを送り、削除・名前・カバーの変更をしません。`applying`保存後に1回だけ呼び、登録済み一覧を読み戻して対象と既存選択を検証します。
- ストーリーのコメント：通常投稿の `media/<ID>/comment/` と分離し、固定の `media/story_comment/post/` へフォームの `comment_text` と所有者込みの `media_id` を送ります。`media/story_comment/fetch/` の全件読み戻しで、自分の同じ文面を一意に確認できた場合だけ完了します。受付応答だけでは完了にしません。

リダイレクト、追加認証、利用制限では停止します。別ホストへの認証転送、任意URL・任意GraphQLの外部公開、自動再ログインは追加していません。内部APIや固定クエリの仕様が変わった場合はエラーとして停止します。

2026-10-17に、ユーザー指定のYouTube動画の冒頭60秒をURL投稿Skillで縦変換し、HTTPモードで素材アップロード・通常公開・既存「Music」ハイライトへの新規追加と登録後のID照合まで確認しました。2026-10-25には親しい友達での60秒動画の公開と、同じメディアの既存idolハイライト内への追加を読み戻して確認しました。キャプションは保存されませんでした。コメントは通常投稿用経路で対象外と拒否され、専用経路でも受付応答だけで保存を確認できていません。実アカウントでのコメント成功は未確認です。SkillはRelayへ渡す前に横動画を変換し、Relayのアップロード処理自体は動画本体を再エンコードしません。

通信形式の参考：

- [Instagram配信コードのハイライト編集処理](https://www.instagram.com/)：2026-10-17に`PolarisStoryAPIActions`の`editHighlight`で追加・削除IDと固定pathを確認。
- [gallery-dlのハイライト読み取り更新](https://codeberg.org/mikf/gallery-dl/commit/8770e6e9c0)：固定2クエリと必要なリクエスト項目。
- [instagrapiのアップロード実装](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/video.py)：ruploadの開始位置・ヘッダー・メタデータ。

ストーリー専用コメント経路の調査では、[アプリのコメント投稿処理を再構成したコード](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/com/instagram/reels/comments/repository/StoryCommentsRepository.java)と[応答のパーサー](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/X/C56214Huh.java)を参照しました。公式のサポート契約ではなく、互換性や実アカウントでの利用可否を保証するものではありません。

旧経路の結果不明は通常のコメントAPI呼び出しで自動再送しません。今回の手動修復では、記録済みのHTTP 400と拒否キー、専用欄の空の全件一覧を照合し、元の状態・日時・拒否理由を`comment.recovery`に残しました。専用経路への送信前も`sending`を永続化し、受付応答だけの場合は`unknown`を維持します。本文や認証情報は回復履歴に含めません。
