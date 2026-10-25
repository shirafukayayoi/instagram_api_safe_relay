---
name: instagram-story-from-url
description: YouTube・TikTok動画の投稿と、Instagram投稿URLの元投稿リンク付きカード共有を、ローカルRelayからストーリーズへ行う。指定された既存ハイライトへの登録にも対応する。横動画の縦変換、指定範囲の切り出し、曲名・アーティストのコメントに対応し、公開範囲と登録先を維持する。
---

# URLからInstagramストーリーズ

## 実行環境

このLinux PCでは以下のラッパーを使う。作業ディレクトリに依存せず、Relayの配置先、Node.js 24のPATH、yt-dlp入りPython仮想環境を設定する。以下の例の `python '<skill-dir>/scripts/story_from_url.py'` をラッパーの絶対パスへ置き換え、引数はそのまま渡す。

```bash
/path/to/instagram-story --check --start-relay
```

Relay本体は `/path/to/instagram_api_safe_relay`。このPCは `browser.type: "http"` で設定済み。通常運用でブラウザーを起動しない。投稿先は保存した選択を一覧・プレビューで確認し、固定のアカウントだと決めつけない。

別環境では `INSTAGRAM_RELAY_REPOSITORY` にRelayのルートを指定する。リポジトリ内の配布版は親ディレクトリから検出でき、未指定・未検出時の旧既定値は `C:\Users\example\Documents\Program\instagram_api_safe_relay`。Python、yt-dlp、ffmpeg、ffprobe、Node.jsが必要。yt-dlpは実行に使うPythonへ `python -m pip install -U "yt-dlp[default,curl-cffi]"` で導入する。

`settings.json` の `stories.enabled` を有効にし、`work/story-smoke` を素材許可ディレクトリに含める。Bearerは環境変数またはRelayのGit管理外 `.env` から読む。`.env`、`settings.json`、`private_sessions/`、専用ブラウザープロファイル、投稿・ハイライト台帳、実行環境を保持し、認証情報を出力・Git・SkillのDrive同期へ含めない。

## ブラウザーなしのHTTPモード

ユーザーが内部APIの直接利用を許可した環境では、Relayの `profiles[].browser` を `{"type":"http","sessionFile":"../../private_sessions/account1.json"}` に設定できる。HTTPモードでもこのSkillの引数・台帳・プレビュー・親しい友達・コメント・ハイライトの扱いは共通。Chromiumを起動せず、固定のHTTP通信だけで処理する。設定・専用ブラウザーからの移行・手動再ログインはRelayの `docs/http-mode.md` に従う。認証ファイルはローカルのGit管理外へ権限600で保存し、SkillのDrive同期対象へ入れない。ログイン・2FA・challengeは手動で行い、自動再ログイン・書き込み要求の再送はしない。

## 起動・診断

```bash
python '<skill-dir>/scripts/story_from_url.py' --check --profile account1
# Relayが停止中なら、既存設定・セッション・台帳でバックグラウンド起動する
python '<skill-dir>/scripts/story_from_url.py' --check --start-relay --profile account1
```

`ready: true`とプロファイルの`state: ready`を確認する。`--check --profile` の成功だけでは実アカウントの再照合は保証しないため、投稿前のプレビューでアカウントを確認する。トークン、素材許可、ツール不足、未ログインは理由付きで停止する。`.env`は起動時にも読み込み、接続先ポートは`settings.json`に従う。既存Relayは再起動せず、台帳・セッション・設定を削除しない。起動ログはRelayの`work/skill-relay/`に保存する。ログイン・2FA・challengeが必要ならユーザーが手動で完了する。

再ログイン時だけ `docs/http-mode.md` と保存済みの `work/skill-relay/browser-settings.json` を参照し、専用プロファイルで手動ログインして、旧認証を保全した別ファイルへ移行する。移行・アカウント追加時の専用ブラウザーと、通常運用のHTTPモードを区別する。CDPを利用する場合はユーザーのAGENTS.mdに従う。

依存関係やビルドが不足する場合はRelayのリポジトリで`pnpm install --frozen-lockfile`、`pnpm build`を実行する。Node.js 24・pnpm 11.5.0と、リポジトリのlockfileを使用する。GitHubから更新する際は未コミット変更を保全する。

## アカウント切り替え

このPCでは「オタク垢」は `@example.account1`（`account1`）を指す。追加登録した `@example.account2` は `account2`。呼称で投稿先を指定された場合も、公開前に一覧・プレビューの実アカウントと照合する。

`--list-accounts --start-relay`で登録済みアカウントと現在の選択を表示する。`--use-account '@username'`または`--use-account account2`で実ログイン先を照合して次の投稿先を保存する。いずれもInstagramへのアップロード・公開は行わない。新規操作は`--profile`省略時に選択済みの投稿先を使い、明示した`--profile`はその操作で優先する。既存の操作IDの再開では操作JSONの元のプロファイルを優先し、現在の選択で置き換えない。アカウント管理とURL投稿は別コマンドで行う。

別アカウントは専用プロファイルへ手動ログインし、別の`private_sessions`ファイルへ移行してから、Relayリポジトリの`pnpm accounts:register --name account2 --session-file private_sessions/account2.json`で照合・登録する。既存アカウントを上書きしない。追加後は処理中の投稿がないことを確認してRelayを正常終了・再起動する。詳細は`docs/accounts.md`。登録・切り替えも通常運用ではブラウザーを起動しない。

## 投稿時に添えるコメント

ユーザーの「コメント」は、ストーリーの投稿画面で一緒に添える文面（クイックキャプション）を意味する。新規操作の初回から `--comment '指定文面'` を渡す。`--caption` は同じ指定の別名で、両方を同時に使わない。画像・動画への文字焼き込みや公開後のコメント送信は行わない。

曲・MV・楽曲紹介では `--comment '曲名 / アーティスト名'` を既定とする。ユーザーが別の文面・表記・コメントなしを明示した場合はその指定を優先する。曲名とアーティスト名は配信元の楽曲メタデータ、公式タイトル・説明欄、ユーザーの指定から確認する。投稿者名をアーティスト名とみなさず、特定できなければ公開前に確認する。

HTTPモードは公開要求の `story_captions` に `text`、`is_quick_caption: true`、`sticker_id: -1` を含める。公開前にモバイルAPIの実アカウントを照合し、公開応答または同じメディアの読み戻しで、所有者・公開範囲・指定文面を確認する。文面を確認できなければ `unknown` とし、取れたメディアIDは保持して再送しない。2026-10-25の実公開では、親しい友達への動画公開は確認できたが、投稿情報・ストーリー一覧・専用コメント一覧のいずれにも指定文面を確認できなかった。現在はHTTP・ブラウザー方式とも文面付きの新規操作を `COMMENT_UNAVAILABLE` でアップロード前に停止する。ユーザーの文面を省略して投稿しない。

旧方式の `comment` フィールドを持つ操作は自動変換・追記・再投稿せず停止する。過去の公開後コメント送信の失敗履歴も保持する。削除・再投稿はユーザーが対象を指定した範囲だけ行い、元操作・削除確認・新操作との対応を残す。

## Instagram投稿のカード共有

Instagramの `/p/<shortcode>/` または `/reel/<shortcode>/` URLをストーリーへ共有する場合は、`scripts/share_instagram_post.py` を使う。YouTube/TikTok用スクリプトへ渡さない。このPCでは起動ラッパーへ `--share-post` を最初の引数として追加する。

```bash
/path/to/instagram-story --share-post 'https://www.instagram.com/p/<shortcode>/' --audience all --operation '<UUID>' --preview-only
```

HTTPモード専用。`stories.feedPostSharingEnabled` を `true` にすると公開でき、未指定または `false` ならアップロード前に `FEED_SHARE_UNAVAILABLE` で止まる。このPCでは実公開検証後に有効化済み。描画には実行用PythonのPillowが必要。元投稿の公開性、`can_viewer_reshare: true`、共有無効化なしを照合し、共有用クエリを除いたURL・操作ID・投稿先・公開範囲・文面を固定する。プレビュー応答で元投稿ID・投稿者と投稿先を確認する。明示的な共有依頼の範囲で、同じ引数から `--preview-only` を外すと公開する。

先頭画像から1080×1920のぼかし背景を作り、角丸の写真と共同投稿者を含むユーザー名を描画する。同じ写真の領域に、元投稿ID・投稿者IDを持つ `feed_media` カードの参照を指定する。元画像、画像、操作JSONは `work/story-smoke/<UUID>/` に保持し、CDNの署名付きURL・認証値を応答やログへ出さない。写真の配置はプレビューで、元投稿への参照は公開後のデータで別々に確認する。

カード共有のアップロード前と公開直前には、固定のモバイルAPIで実アカウントを照合する。保存済みセッションをモバイル用のBearer形式で送り、端末IDは既存の非公開セッションファイルに権限600で保存して再利用する。Web CookieとWeb用User-AgentだけをモバイルAPIへ流用しない。ブラウザーの起動や自動再ログインは不要で、2FA・challengeが返った場合は手動認証の境界で止まる。

公開後にアカウント・公開範囲・指定キャプションに加え、`story_feed_media` が同じ元投稿を参照していることをRelayが検証する。確認できない場合は `unknown` として再投稿せず、確認できた公開メディアIDは保持する。同じプロファイル・元投稿の受理済み/公開済み/結果不明は、別の操作キーでも重複させない。`--comment` と `--highlight` / `--highlight-id` を使える。指定していないハイライトには登録しない。

2026-10-21に、カルーセル投稿の先頭写真と共同投稿者名を含むカードを通常公開し、公開応答・WebとモバイルAPIの読み戻しで同じ元投稿への参照を確認した。Instagram配信画像の表示確認後、ユーザーの指定どおり試験投稿を削除し、両方の一覧からの消失まで確認済み。アプリ画面でのタップ操作、カード共有の親しい友達・リール・キャプション・ハイライト登録は未検証。

失敗した試験の経緯と再試行の扱いはRelayの `docs/feed-post-stories.md` を参照する。削除済みは `removal` 注記、公開中全件に見当たらない結果不明は明示許可を得た手動照合の `retryRelease` 注記を使い、元の台帳・状態は保持する。新しい試行は元操作と原因を記録し、再公開についての既存のユーザー許可を確認する。自分宛てメンションストーリーの再投稿とは別機能で、未検証のメンション再投稿は有効化しない。

## YouTube・TikTok動画の手順

1. ユーザーが指定したURL、投稿先、公開範囲、任意のコメント文面を確認する。明示的な投稿依頼は実行許可として扱う。「親しい」は `close_friends`、通常ストーリーは `all`。公開範囲が省略された場合も `all` とする。曲の場合は上記のコメント規則を適用する。指定範囲と文面を変更しない。「コメント付き」は `--comment` で公開時に文面を添える。画像・動画上への文字描画は行わない。
2. 依頼ごとにUUIDの操作IDを作る。再開時は同じIDを使う。成功済み・結果不明の操作に新しいIDを作らない。公開要求前の`failed`は、Relayの状態と実装から未公開を確認し、原因を修正できた場合に限り、継続中の明示的な投稿依頼の範囲で新しい試行IDを使える。その操作JSONへ旧操作ID・失敗ジョブID・確認した原因を残し、旧台帳は保持する。キャプション・投稿先・公開範囲・指定された切り出し範囲を変えない。
3. 同梱 `scripts/story_from_url.py` を実行する。URL投稿には `--audience` と `--operation` が必須。新規操作では `--profile` を省略すると選択中の投稿先を使う。`--download-only`は素材取得・ストーリー用変換まで、`--preview-only`は取得素材・実ログインアカウント・公開範囲の確認までで、Instagramへのアップロード・公開を行わない。プレビューの確認だけを依頼された場合はここで止める。配信元のH.264/AAC（または音声なし）MP4を `original.mp4` に保存する。横動画のストーリーは同梱 `story_media.py` で1080×1920へ変換する。元映像を幅1080で中央に置き、背景は元映像の拡大・中央切り抜き・明るさ+0.2・ぼかしsigma17を使う。縦動画・正方形動画は切り出し指定がなければ無変換。音声の置換・自動分割は行わない。
4. 明示的な投稿依頼がある場合、必要なプレビュー確認を済ませ、同じ操作ID・URL・公開範囲・文面・切り出し範囲・登録先で `--preview-only` を外して投稿する。Relayは既存設定・台帳で起動する。`published`、media ID、ジョブの`audience`を確認する。親しい友達ではRelayが公開応答の`audience: besties`を検証する。`unknown` はInstagram上で確認し、自動再投稿しない。

```bash
python '<skill-dir>/scripts/story_from_url.py' 'https://vt.tiktok.com/ZSb5JR1mx/' --audience close_friends --profile account1 --operation '<UUID>' --download-only
# 実ログインアカウントも確認する場合は --download-only を --preview-only に変更する
# 明示的な投稿依頼がある場合に限り、同じコマンドから上記のフラグを外して投稿する
# コメント・切り出し・登録先は取得やプレビューの初回から同じ引数を指定する
# 例: --comment '曲名 / アーティスト名' --clip-start 0 --clip-end 60 --highlight 'Music'
```

`<skill-dir>` はこのSKILL.mdの所在ディレクトリ。途中停止・タイムアウトは同じコマンドと操作IDで再開する。スクリプトは操作JSONとAPIのIdempotency-Keyを保持し、既存の投稿ジョブがあればストーリーを再投稿せず状態照会を再開し、指定済みハイライトの未完了処理があれば同じキーで続行する。投稿時のコメントは任意の文字列（UTF-16で2200文字以内）。同じ操作IDでURL・公開範囲・プロファイル・文面・切り出し範囲・登録先を変更しない。切り出し引数は再開時も省略しない。旧操作のキャプション省略は空文字として扱う。

素材・変換内容・ジョブIDは `work/story-smoke/<操作UUID>/operation.json` へ保存する。`.lock` がある場合は、同じ操作のプロセスが停止したと確認するまで削除・再実行しない。スクリプトの終了コード0だけで公開成功と判断せず、「処理継続中」の場合は同じ操作IDのコマンドで照会を再開する。

通常の投稿は互換APIの`POST /v1/stories`を使い、公開を開始する。`--preview-only`は最新版の`POST /v1/story-previews`を使う。同じ操作の未期限切れプレビューは再利用する。プレビューは10分で期限切れになり、後からの投稿は元のURL・公開範囲・プロファイル・文面を指定した明示的な投稿コマンドで行う。取得・プレビュー・診断の成功を投稿成功として扱わない。

## 検証

2026-10-17にYouTube動画の冒頭60秒の縦変換、通常公開、既存「Music」ハイライト追加をHTTPモードで確認済み。2026-10-25にはTikTok冒頭60秒を親しい友達へ実公開し、bestiesでの読み戻しと既存idolハイライト内の同じIDを確認した。従来の単独 `caption` は保存されなかった。公開後コメントは通常投稿用経路で拒否され、専用経路でも保存を確認できなかった。その後ユーザーから「投稿時に一緒に添える文面」の意図を確認し、`story_captions` によるクイックキャプションへ修正した。この修正版でユーザー指定の1件を削除して1回だけ再投稿したが、親しい友達への60秒動画公開と既存idol内の同じIDだけを確認でき、文面の保存は確認できなかった。ジョブの `unknown` とメディアID、削除・置換・ハイライト追加の履歴を保持し、再送しない。文面付き新規操作は停止中。過去の試験をコメント付き投稿の成功として扱わない。

以下はInstagramへ公開しないローカルテスト。1本目は操作の再開・アカウント選択・コメント引数の同義性・旧操作の停止・ハイライト対象照合、2本目は実際のffmpegによる縦変換・原本保持・60秒境界を確認する。

```bash
python '<skill-dir>/scripts/test_story_from_url.py'
python '<skill-dir>/scripts/test_story_media.py'
python '<skill-dir>/scripts/test_share_instagram_post.py'
```

## ハイライト登録

ユーザーが登録先を指定した場合は、投稿コマンドに`--highlight 'idol'`を追加する。名前は既存ハイライトへの完全一致で、同名が複数ある場合は`--highlight-id '<数値ID>'`を使用する。新規ハイライト作成、名前・カバーの変更、元ストーリーの再投稿は行わない。

すでに公開した操作へ後から追加する場合は、元のURL・公開範囲・プロファイル・文面・操作IDを使い、`--highlight-only --highlight 'idol'`を指定する。受理済みストーリーの状態を照会し、公開済みの同じメディアだけを登録する。未公開操作に`--highlight-only`を指定しても投稿しない。`--download-only`・`--preview-only`ではハイライト登録も行わない。

```bash
# 投稿からハイライト登録まで
python '<skill-dir>/scripts/story_from_url.py' '<URL>' --audience close_friends --profile account1 --operation '<UUID>' --highlight 'idol'
# 同じ公開済み操作を再投稿せず登録
python '<skill-dir>/scripts/story_from_url.py' '<元のURL>' --audience close_friends --profile account1 --operation '<元のUUID>' --highlight-only --highlight 'idol'
```

Relayの`GET /v1/highlights`で実アカウントと登録先IDを確認し、`POST /v1/highlights/:id/stories`へ`storyJobId`を渡す。登録は専用の永続台帳とプロファイル排他を使う。HTTPモードでは固定クエリで登録前のストーリーIDを取得し、保存直前の `applying` を永続化して対象IDの追加だけを1回送る。登録後に一覧を再取得し、対象が追加され、既存IDがすべて維持され、件数が一致することを確認する。ブラウザー方式はWeb編集画面でIDを照合し、保存後に開き直して確認する。親しい友達の元ストーリーを通常公開へ変更しない。

同じ操作で登録先を変更しない。登録済みは`alreadyPresent: true`で完了し、保存操作を省く。`GET /v1/highlight-jobs/:id`の`completed`とアカウント・登録先・メディアID・公開範囲を照合する。`unknown`は自動再登録しない。投稿完了とハイライト登録完了は別々に報告する。

HTTPモードでは一覧と登録済みIDの全件取得を確認し、ページングが完了しない場合は停止する。ブラウザー方式の画面文言は日本語と英語に対応し、アーカイブで対象IDを識別できない場合は別の動画を選ばず停止する。

## 投稿の制約

30秒以上の動画ではRelayがアップロード後、公開前に30秒の処理待ちを入れる。公開要求の自動再送はしない。親しい友達は固定の `/api/v1/media/configure_to_story/` へ `audience: besties` を送る。HTTPモードはNode.jsから、ブラウザー方式はブラウザー内から送信する。仕様変更で限定公開の根拠が得られなければ結果不明として停止し、通常公開で代用しない。ブラウザー方式ではCookieや認証値をブラウザー内に留める。ユーザーが許可したHTTPモードでは、専用セッションを権限600のローカルファイルだけに保持し、認証値を応答・ログへ出さない。

文面付き投稿は公開応答または同じメディアの読み戻しの `media.caption.text`、もしくは `story_captions` 内のクイックキャプションとの一致を確認する。保存の根拠とアプリ画面での表示確認は分けて報告する。確認できなければ `unknown` にし、文面を省略して再投稿しない。

動画はMP4、H.264、音声はAACまたはなし、1〜60秒、100MiB以下、各辺4096px以下。取得時のyt-dlpの制限 `--max-filesize 300M` と、投稿用ファイルの上限100MiBを区別する。取得できない形式や変換後の制限超過は理由を報告して停止する。ダウンロード成功を投稿成功と報告しない。

ユーザーが明示的に切り出しを指定した場合は `--clip-start 0 --clip-end 60` のように秒数を指定する。再開時も同じ範囲を指定し、同じ操作IDの範囲を変更しない。指定範囲は元動画内の1〜60秒。原本を保存し、ffprobeで変換後の長さと形式を検証する。23.976fpsなどの端数による60秒超過を避けるため、変換時は切り上げた整数fps（最大60）を使い、音声は指定尺のサンプル数で切ってタイムスタンプを0から振り直す。変換内容・コマンド・原本と出力のSHA256を操作JSONに保存する。50MiB超の検証済み素材はRelayのファイルパス転送を使う（Playwrightのbuffer転送は50MiBまで）。

縦変換の見た目は [MediaDownloaderTool.py](https://github.com/shirafukayayoi/Shirafuka-Practice/blob/main/Python/MediaDownloaderTool.py) のCPU処理に合わせる。エンコードはこのPCのCPU負荷と投稿上限を考慮してlibx264 veryfast/CRF20を使う。映像の配置・背景効果は同じ。原本は保持し、既存の操作で `downloaded: true` の素材を再開時に勝手に作り直さない。
