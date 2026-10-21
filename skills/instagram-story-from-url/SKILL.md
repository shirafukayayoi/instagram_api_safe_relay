---
name: instagram-story-from-url
description: YouTube・TikTok動画の投稿と、Instagram投稿URLの元投稿リンク付きカード共有（試験中）を、ローカルRelayからストーリーズへ行う。指定された既存ハイライトへの登録にも対応する。横動画の縦変換、指定範囲の切り出し、曲名・アーティストのコメントに対応し、公開範囲と登録先を維持する。
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

ユーザーが内部APIの直接利用を許可した環境では、Relayの `profiles[].browser` を `{"type":"http","sessionFile":"../../private_sessions/account1.json"}` に設定できる。HTTPモードでもこのSkillの引数・台帳・プレビュー・親しい友達・キャプション・ハイライトの扱いは共通。Chromiumを起動せず、固定のHTTP通信だけで処理する。設定・専用ブラウザーからの移行・手動再ログインはRelayの `docs/http-mode.md` に従う。認証ファイルはローカルのGit管理外へ権限600で保存し、SkillのDrive同期対象へ入れない。ログイン・2FA・challengeは手動で行い、自動再ログイン・書き込み要求の再送はしない。

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

`--list-accounts --start-relay`で登録済みアカウントと現在の選択を表示する。`--use-account '@username'`または`--use-account account2`で実ログイン先を照合して次の投稿先を保存する。いずれもInstagramへのアップロード・公開は行わない。新規操作は`--profile`省略時に選択済みの投稿先を使い、明示した`--profile`はその操作で優先する。既存の操作IDの再開では操作JSONの元のプロファイルを優先し、現在の選択で置き換えない。アカウント管理とURL投稿は別コマンドで行う。

別アカウントは専用プロファイルへ手動ログインし、別の`private_sessions`ファイルへ移行してから、Relayリポジトリの`pnpm accounts:register --name account2 --session-file private_sessions/account2.json`で照合・登録する。既存アカウントを上書きしない。追加後は処理中の投稿がないことを確認してRelayを正常終了・再起動する。詳細は`docs/accounts.md`。登録・切り替えも通常運用ではブラウザーを起動しない。

## 曲のコメント（キャプション）

曲・MV・楽曲紹介のストーリーは、コメントに `曲名 / アーティスト名` を入れ、初回の操作から `--caption` で渡す。例: `--caption 'ちょーだいHAPPY！ / SWEET STEADY'`。ユーザーが別の文面・表記・コメントなしを明示した場合は、その指定を優先する。

曲名とアーティスト名は、配信元の楽曲メタデータ、公式の動画タイトル・説明欄、ユーザーの指定から確認する。投稿者・チャンネル名をそのままアーティスト名とみなさず、MV・公式動画などの装飾語を曲名へ混ぜない。特定できなければ推測せず、曲名・アーティスト名を確認してから公開する。

楽曲かどうかの判断と曲名・アーティストの確認はCodexが行う。スクリプトはURLからキャプションを自動生成しない。コメントは投稿データの `caption` として送信し、動画への文字焼き込みや公開後の別コメント送信は行わない。

この既定値は新規操作に適用する。既存の操作IDを再開するときは保存済みのキャプションを維持し、公開済みストーリーの再投稿やコメントの追記は行わない。

## Instagram投稿のカード共有

Instagramの `/p/<shortcode>/` または `/reel/<shortcode>/` URLをストーリーへ共有する場合は、`scripts/share_instagram_post.py` を使う。YouTube/TikTok用スクリプトへ渡さない。このPCでは起動ラッパーへ `--share-post` を最初の引数として追加する。

```bash
/path/to/instagram-story --share-post 'https://www.instagram.com/p/<shortcode>/' --audience all --operation '<UUID>' --preview-only
```

HTTPモード専用で実公開は試験中。`stories.feedPostSharingEnabled` が未指定または `false` ならアップロード前に `FEED_SHARE_UNAVAILABLE` で止まる。2026-10-21のモバイルAPI形式の試験でも公開・元投稿リンクの成功を確認できていないため、明示的に許可された試験以外で有効化しない。描画には実行用PythonのPillowが必要。共有用クエリを除いた元投稿URL・操作ID・投稿先・公開範囲・文面を固定する。元投稿が公開され、`can_viewer_reshare: true` と共有無効化なしを確認できる場合だけ受け付ける。プレビュー応答の元投稿ID・投稿者と投稿先アカウントを確認する。明示的な共有依頼の範囲で、同じ引数から `--preview-only` を外すと公開する。

先頭画像から1080×1920のぼかし背景を作り、角丸の写真と共同投稿者を含むユーザー名を描画する。同じ写真の領域に、元投稿ID・投稿者IDを持つ `feed_media` カードの参照を指定する。プレビュー画像で写真・配置・ユーザー名を確認し、元投稿リンクは公開結果から別に検証する。切り出し・動画化による元投稿の再アップロードでは代用しない。元画像、背景、操作JSONは `work/story-smoke/<UUID>/` に保持し、CDNの署名付きURL・認証値を応答やログへ出さない。

公開後にアカウント・公開範囲・指定キャプションに加え、`story_feed_media` が同じ元投稿を参照していることをRelayが検証する。確認できない場合は `unknown` として再投稿しない。同じプロファイル・元投稿の受理済み/公開済み/結果不明は、別の操作キーでも重複させない。`--caption` と `--highlight` / `--highlight-id` を使える。指定していないハイライトには登録しない。初回試験ではカード参照が付かない1件が公開されたため、読み戻しで確認し、ユーザーの明示許可で削除済み。削除確認は台帳の `removal` 注記に残し、元の `unknown` 状態は保持する。新しい試行は元操作・削除済みID・原因を記録し、再公開の明示許可を得てから行う。修正版は「公開して確認後、消して」という許可で1回だけ試験したが、メディアIDを得られず `unknown` で停止した。Web全件読み戻しを2回照合し公開中0件を確認したため、削除対象はなく削除要求を送っていない。モバイルAPIの別経路読み取りも403で拒否され、同経路の確認は成立していない。試験用フラグを元に戻し、元の `unknown` 台帳と重複防止を保持した。成功・削除完了とは報告せず、追加公開を行わない。自分宛てメンションストーリーの再投稿とは別機能で、未検証のメンション再投稿は有効化しない。詳細はRelayの `docs/feed-post-stories.md`。

## YouTube・TikTok動画の手順

1. ユーザーが指定したURL、投稿先、公開範囲、任意のキャプションを確認する。明示的な投稿依頼は実行許可として扱う。「親しい」は `close_friends`、通常ストーリーは `all`。公開範囲が省略された場合も `all` とする。曲の場合は上記のコメント規則を適用する。指定範囲と文面を変更しない。「コメント付き」は `--caption` で投稿データへ保存する。画像・動画上への文字描画は行わない。
2. 依頼ごとにUUIDの操作IDを作る。再開時は同じIDを使う。成功済み・結果不明の操作に新しいIDを作らない。公開要求前の`failed`は、Relayの状態と実装から未公開を確認し、原因を修正できた場合に限り、継続中の明示的な投稿依頼の範囲で新しい試行IDを使える。その操作JSONへ旧操作ID・失敗ジョブID・確認した原因を残し、旧台帳は保持する。キャプション・投稿先・公開範囲・指定された切り出し範囲を変えない。
3. 同梱 `scripts/story_from_url.py` を実行する。URL投稿には `--audience` と `--operation` が必須。新規操作では `--profile` を省略すると選択中の投稿先を使う。`--download-only`は素材取得・ストーリー用変換まで、`--preview-only`は取得素材・実ログインアカウント・公開範囲の確認までで、Instagramへのアップロード・公開を行わない。プレビューの確認だけを依頼された場合はここで止める。配信元のH.264/AAC（または音声なし）MP4を `original.mp4` に保存する。横動画のストーリーは同梱 `story_media.py` で1080×1920へ変換する。元映像を幅1080で中央に置き、背景は元映像の拡大・中央切り抜き・明るさ+0.2・ぼかしsigma17を使う。縦動画・正方形動画は切り出し指定がなければ無変換。音声の置換・自動分割は行わない。
4. 明示的な投稿依頼がある場合、必要なプレビュー確認を済ませ、同じ操作ID・URL・公開範囲・文面・切り出し範囲・登録先で `--preview-only` を外して投稿する。Relayは既存設定・台帳で起動する。`published`、media ID、ジョブの`audience`を確認する。親しい友達ではRelayが公開応答の`audience: besties`を検証する。`unknown` はInstagram上で確認し、自動再投稿しない。

```bash
python '<skill-dir>/scripts/story_from_url.py' 'https://vt.tiktok.com/ZSb5JR1mx/' --audience close_friends --profile account1 --operation '<UUID>' --download-only
# 実ログインアカウントも確認する場合は --download-only を --preview-only に変更する
# 明示的な投稿依頼がある場合に限り、同じコマンドから上記のフラグを外して投稿する
# キャプション・切り出し・登録先は取得やプレビューの初回から同じ引数を指定する
# 例: --caption '曲名 / アーティスト名' --clip-start 0 --clip-end 60 --highlight 'Music'
```

`<skill-dir>` はこのSKILL.mdの所在ディレクトリ。途中停止・タイムアウトは同じコマンドと操作IDで再開する。スクリプトは操作JSONとAPIのIdempotency-Keyを保持し、既存の投稿ジョブがあればストーリーを再投稿せず状態照会を再開し、指定済みハイライトの未完了処理があれば同じキーで続行する。キャプションは任意の文字列（UTF-16で2200文字以内）。同じ操作IDでURL・公開範囲・プロファイル・文面・切り出し範囲・登録先を変更しない。切り出し引数は再開時も省略しない。旧操作のキャプション省略は空文字として扱う。

素材・変換内容・ジョブIDは `work/story-smoke/<操作UUID>/operation.json` へ保存する。`.lock` がある場合は、同じ操作のプロセスが停止したと確認するまで削除・再実行しない。スクリプトの終了コード0だけで公開成功と判断せず、「処理継続中」の場合は同じ操作IDのコマンドで照会を再開する。

通常の投稿は互換APIの`POST /v1/stories`を使い、公開を開始する。`--preview-only`は最新版の`POST /v1/story-previews`を使う。同じ操作の未期限切れプレビューは再利用する。プレビューは10分で期限切れになり、後からの投稿は元のURL・公開範囲・プロファイル・文面を指定した明示的な投稿コマンドで行う。取得・プレビュー・診断の成功を投稿成功として扱わない。

## 検証

2026-10-17にHTTPモードでYouTube動画の取得、冒頭60秒の1080×1920への縦変換、通常公開、その同じメディアの既存「Music」ハイライトへの新規追加と登録後確認まで実行済み。HTTPの親しい友達はプレビューまで確認し、キャプション付き・親しい友達のHTTP実公開は未検証。過去のブラウザー方式での公開成功と区別する。

以下はInstagramへ公開しないローカルテスト。1本目は操作の再開・アカウント選択・キャプション転送・ハイライト対象照合、2本目は実際のffmpegによる縦変換・原本保持・60秒境界を確認する。

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

キャプション付き投稿は公開応答の `media.caption.text` が指定文面と一致する場合だけ成功とする。確認できなければ `unknown` にし、文面を省略して再投稿しない。キャプションの実アカウントでの公開検証は未実施。投稿データのキャプションは画面上の文字表示を保証しない。

動画はMP4、H.264、音声はAACまたはなし、1〜60秒、100MiB以下、各辺4096px以下。取得時のyt-dlpの制限 `--max-filesize 300M` と、投稿用ファイルの上限100MiBを区別する。取得できない形式や変換後の制限超過は理由を報告して停止する。ダウンロード成功を投稿成功と報告しない。

ユーザーが明示的に切り出しを指定した場合は `--clip-start 0 --clip-end 60` のように秒数を指定する。再開時も同じ範囲を指定し、同じ操作IDの範囲を変更しない。指定範囲は元動画内の1〜60秒。原本を保存し、ffprobeで変換後の長さと形式を検証する。23.976fpsなどの端数による60秒超過を避けるため、変換時は切り上げた整数fps（最大60）を使い、音声は指定尺のサンプル数で切ってタイムスタンプを0から振り直す。変換内容・コマンド・原本と出力のSHA256を操作JSONに保存する。50MiB超の検証済み素材はRelayのファイルパス転送を使う（Playwrightのbuffer転送は50MiBまで）。

縦変換の見た目は [MediaDownloaderTool.py](https://github.com/shirafukayayoi/Shirafuka-Practice/blob/main/Python/MediaDownloaderTool.py) のCPU処理に合わせる。エンコードはこのPCのCPU負荷と投稿上限を考慮してlibx264 veryfast/CRF20を使う。映像の配置・背景効果は同じ。原本は保持し、既存の操作で `downloaded: true` の素材を再開時に勝手に作り直さない。
