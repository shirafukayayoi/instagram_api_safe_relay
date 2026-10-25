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
- 投稿時コメント（現在停止中）：実験実装はモバイルAPIで実アカウントを照合し、公開要求の`story_captions`に`[{"text":"指定文面","is_quick_caption":true,"sticker_id":-1}]`をJSON文字列で送ります。動画は実際の寸法・長さと`?video=1`を使います。通常の`caption`は空にします。公開応答に指定文面がなければ同じIDの`media/<ID>/info/`を1回読み戻し、所有者・公開範囲・文面を照合します。根拠がなければIDを保持して`unknown`とし、公開要求を再送しません。
- ハイライト登録：固定の`/api/v1/highlights/highlight:<ID>/edit_reel/`へ対象IDの追加だけを送り、削除・名前・カバーの変更をしません。`applying`保存後に1回だけ呼び、登録済み一覧を読み戻して対象と既存選択を検証します。
- 公開後のコメント（URL投稿Skillからは呼ばない別機能）：通常投稿の `media/<ID>/comment/` と分離し、固定の `media/story_comment/post/` へ `signed_body` 形式で送ります。内容は `comment_text`、所有者込みの `media_id`、`container_module: stories_viewer`、保存済み端末の `_uuid`、本人の `_uid` です。`media/story_comment/fetch/` の全件読み戻しで、自分の同じ文面を一意に確認できた場合だけ完了します。受付応答だけでは完了にしません。

リダイレクト、追加認証、利用制限では停止します。別ホストへの認証転送、任意URL・任意GraphQLの外部公開、自動再ログインは追加していません。内部APIや固定クエリの仕様が変わった場合はエラーとして停止します。

2026-10-17に、ユーザー指定のYouTube動画の冒頭60秒をURL投稿Skillで縦変換し、HTTPモードで素材アップロード・通常公開・既存「Music」ハイライトへの新規追加と登録後のID照合まで確認しました。2026-10-25には親しい友達での60秒動画の公開と、同じメディアの既存idolハイライト内への追加を読み戻して確認しました。キャプションは保存されませんでした。コメントは通常投稿用経路で対象外と拒否され、専用経路でも受付応答だけで保存を確認できていません。ユーザーの意図は投稿画面で一緒に添える文面と確認できたため、Skillを投稿時クイックキャプションへ変更しました。この形式でもユーザーの許可に基づく1回の再投稿を実施しましたが、投稿情報・ストーリー一覧・専用コメント一覧のいずれにも指定文面を確認できませんでした。動画は親しい友達へ公開され、既存idol内の同じIDを確認済みです。ジョブはメディアIDを保持して`unknown`のままとし、追加の削除・再投稿は行いません。現在は文面付きの新規操作をアップロード前に停止しています。SkillはRelayへ渡す前に横動画を変換し、Relayのアップロード処理自体は動画本体を再エンコードしません。

通信形式の参考：

- [Instagram配信コードのハイライト編集処理](https://www.instagram.com/)：2026-10-17に`PolarisStoryAPIActions`の`editHighlight`で追加・削除IDと固定pathを確認。
- [gallery-dlのハイライト読み取り更新](https://codeberg.org/mikf/gallery-dl/commit/8770e6e9c0)：固定2クエリと必要なリクエスト項目。
- [instagrapiのアップロード実装](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/video.py)：ruploadの開始位置・ヘッダー・メタデータ。

ストーリー専用コメント経路の調査では、[アプリのコメント投稿処理を再構成したコード](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/com/instagram/reels/comments/repository/StoryCommentsRepository.java)と[応答のパーサー](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/X/C56214Huh.java)を参照しました。公式のサポート契約ではなく、互換性や実アカウントでの利用可否を保証するものではありません。

旧経路の結果不明は通常のコメントAPI呼び出しで自動再送しません。今回の手動修復では、記録済みのHTTP 400と拒否キー、専用欄の空の全件一覧を照合し、元の状態・日時・拒否理由を`comment.recovery`に残しました。専用経路への送信前も`sending`を永続化し、受付応答だけの場合は`unknown`を維持します。本文や認証情報は回復履歴に含めません。

投稿時クイックキャプションは、アプリの[公開要求builder](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/X/C64177LSe.java)と[文面serializer](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/X/C282695Ej.java)を参照しました。公式のAPI契約ではありません。従来の公開後コメントの台帳は保持し、投稿時文面への自動変換・再送は行いません。`--comment`と`--caption`は同義のため、初回からどちらか一方を指定します。

ユーザーのスマホでも、この再投稿の文面が表示されないことを確認しました。投稿時コメントは失敗として扱います。アプリの[クイックキャプション生成処理](https://github.com/carter-0/instagram-decompiled/blob/52284f22a48cecfd448ae9516cf49bcdfaa03db2/sources/X/AnonymousClass8ME.java)と比較し、`text`、`is_quick_caption: true`、`sticker_id: -1`の形式は一致していますが、それだけで保存・表示されることは保証されません。必要な条件は未特定であり、推測した追加パラメーターで実公開を繰り返しません。次の切り分けには、アプリで文面表示に成功した既存ストーリーのデータとの比較が必要です。

## スマホの成功例との比較（2026-10-25）

同じアカウントの親しい友達ストーリーで、ユーザーが投稿時に添えた文面を確認しました。`media/<ID>/info/` の`caption`はnullで、`story_captions`もありませんでした。一方、自分のストーリー一覧には`story_comments`があり、専用の`media/story_comment/fetch/`でも同じコメントID・本文・投稿者ID・メディアIDと`is_created_by_media_owner: true`を確認できました。必要な機能は、この本人コメントであり、クイックキャプションではありません。成功例の本文・認証値・素材URLはログやリポジトリへ保存していません。

Relayで公開済みの自分の60秒動画へ、専用経路の2項目フォームで指定文面を1回追記しましたが、応答は`status: ok`のみで、保存を確認できませんでした。動画の削除・再公開は行っていません。この結果不明は専用のローカル記録に保持し、再送しません。送信成功は未解決のため、文面付き新規投稿の停止を維持します。読み戻しは本文と本人IDだけでなく、対象メディアIDと本人コメントの印も照合します。

## 現在版アプリとの送信形式の比較

2026-10-25に、[Android版449.0.0.52.84の配布パッケージ](https://apkpure.net/instagram-app/com.instagram.android/download/449.0.0.52.84)をインストールせず静的解析しました。XAPKのSHA256は`5da1cc2385064cf39f24385cfa3a07815e308f207b96bfc86078e984c48f617a`で配布ページと一致し、本体署名のSHA1は`c56fb7d591ba6704df047fd98f535372fea00211`でした。

`CommentPostingRequestExtensionsKt.A01`では、専用POSTに本文・メディアIDだけでなく`container_module`を渡し、リクエストbuilderの署名形式を有効にしていました。builderは本人の`_uid`と端末の`_uuid`を含め、`SIGNATURE.`を付けたJSONを`signed_body`へ格納します。`ReelViewerFragment.A19`で確認した通常のストーリー表示の文脈`stories_viewer`を使います。任意項目の`story_ranking_token`や`nav_chain`は捏造せず省略します。メディアIDはアプリのモデルと同じ所有者込みの形式を維持します。

この差分に基づいて送信形式を修正しました。過去の結果不明を自動再送する変更ではありません。URL投稿Skillの文面付き新規投稿は、実アカウントでの保存検証が完了するまで停止を維持します。
