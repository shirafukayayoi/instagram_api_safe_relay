---
name: instagram-story-from-url
description: YouTube・TikTok動画をローカルInstagram Relayから通常または親しい友達向けストーリーズへ投稿し、指定された既存ハイライトへの登録まで行う。キャプション、公開範囲、登録先を維持する。
---

# URLからInstagramストーリーズ

## 実行環境

Relay: `C:\Users\example\Documents\Program\instagram_api_safe_relay`。
別の場所に配置した場合は`INSTAGRAM_RELAY_REPOSITORY`で指定する。GitHubリポジトリ内の配布版は親ディレクトリからRelayを検出する。
Python、`yt-dlp`、ffmpeg、ffprobeを使用する。不足時は公式パッケージを導入する。
`python -m pip install -U "yt-dlp[default,curl-cffi]"`。
YouTubeのJavaScript処理にはNode.jsも使用する。スクリプトは`--js-runtimes node`を指定する。
Relayの設定で投稿を有効にし、ダウンロード先 `work/story-smoke` を許可する。
投稿先はログイン済みの選択プロファイル。Bearerは環境変数またはRelayの無視対象 `.env` から読む。出力しない。

## ブラウザーなしのHTTPモード

ユーザーが内部APIの直接利用を許可した環境では、Relayの `profiles[].browser` を `{"type":"http","sessionFile":"../../private_sessions/account1.json"}` に設定できる。HTTPモードでもこのSkillの引数・台帳・プレビュー・親しい友達・キャプション・ハイライトの扱いは共通。Chromiumを起動せず、固定のHTTP通信だけで処理する。設定・専用ブラウザーからの移行・手動再ログインはRelayの `docs/http-mode.md` に従う。認証ファイルはローカルのGit管理外へ権限600で保存し、SkillのDrive同期対象へ入れない。ログイン・2FA・challengeは手動で行い、自動再ログイン・書き込み要求の再送はしない。

2026-10-17にHTTPモードで実アカウント照合、親しい友達向けプレビュー、既存ハイライト13件と登録済みストーリーIDの取得を確認した。2026-10-17にユーザー指定のYouTube動画の冒頭60秒を背景ぼかし付き1080×1920へ変換し、HTTP経由で通常公開、その同じメディアの既存「Music」ハイライトへの追加完了を確認した。Chromiumは起動していない。HTTP経由の親しい友達・キャプション付き実公開は未検証。

## 起動・診断

```powershell
python '<skill-dir>/scripts/story_from_url.py' --check --profile account1
# Relayが停止中なら、既存設定・セッション・台帳でバックグラウンド起動する
python '<skill-dir>/scripts/story_from_url.py' --check --start-relay --profile account1
```

`ready: true`とプロファイルの`state: ready`を確認する。トークン、素材許可、ツール不足、未ログインは理由付きで停止する。`.env`は起動時にも読み込み、接続先ポートは`settings.json`に従う。既存Relayは再起動せず、台帳・セッション・設定を削除しない。起動ログはRelayの`work/skill-relay/`に保存する。ログイン・2FA・challengeが必要ならユーザーが手動で完了する。

ブラウザー方式のRelayはPlaywrightの永続Chromiumコンテキストを使用する。内蔵ブラウザのタブ単位CDPにはRelayを接続する外部エンドポイントがないため、このSkillのRelay処理は既存の専用プロファイルを使う。通常のブラウザ閲覧はユーザーのAGENTS.mdに従う。

依存関係やビルドが不足する場合はRelayのリポジトリで`pnpm install --frozen-lockfile`、`pnpm build`を実行する。Node.js 24・pnpm 11.5.0と、リポジトリのlockfileを使用する。GitHubから更新する際は未コミット変更を保全する。

## アカウント切り替え

`--list-accounts --start-relay`で登録済みアカウントと現在の選択を表示する。`--use-account '@username'`または`--use-account account2`で実ログイン先を照合して次の投稿先を保存する。いずれもInstagramへのアップロード・公開は行わない。新規操作は`--profile`省略時に選択済みの投稿先を使い、明示した`--profile`はその操作で優先する。既存の操作IDの再開では操作JSONの元のプロファイルを優先し、現在の選択で置き換えない。アカウント管理とURL投稿は別コマンドで行う。

別アカウントは専用プロファイルへ手動ログインし、別の`private_sessions`ファイルへ移行してから、Relayリポジトリの`pnpm accounts:register --name account2 --session-file private_sessions/account2.json`で照合・登録する。既存アカウントを上書きしない。追加後は処理中の投稿がないことを確認してRelayを正常終了・再起動する。詳細は`docs/accounts.md`。登録・切り替えも通常運用ではブラウザーを起動しない。

## 曲のコメント（キャプション）

曲・MV・楽曲紹介のストーリーは、コメントに `曲名 / アーティスト名` を入れ、初回の操作から `--caption` で渡す。例: `--caption 'ちょーだいHAPPY！ / SWEET STEADY'`。ユーザーが別の文面・表記・コメントなしを明示した場合は、その指定を優先する。

曲名とアーティスト名は、配信元の楽曲メタデータ、公式の動画タイトル・説明欄、ユーザーの指定から確認する。投稿者・チャンネル名をそのままアーティスト名とみなさず、MV・公式動画などの装飾語を曲名へ混ぜない。特定できなければ推測せず、曲名・アーティスト名を確認してから公開する。

この既定値は新規操作に適用する。既存の操作IDを再開するときは保存済みのキャプションを維持し、公開済みストーリーの再投稿やコメントの追記は行わない。

## 手順

1. ユーザーが指定したURL、投稿先、公開範囲、任意のキャプションを確認する。明示的な投稿依頼は実行許可として扱う。「親しい」は `close_friends`、通常ストーリーは `all`。指定範囲と文面を変更しない。「コメント付き」は `--caption` で投稿データへ保存する。画像・動画上への文字描画は行わない。
2. 依頼ごとにUUIDの操作IDを作る。再開時は同じIDを使う。成功済み・結果不明の操作に新しいIDを作らない。公開要求前の`failed`は、Relayの状態と実装から未公開を確認し、原因を修正できた場合に限り、継続中の明示的な投稿依頼の範囲で新しい試行IDを使える。その操作JSONへ旧操作ID・失敗ジョブID・確認した原因を残し、旧台帳は保持する。キャプション・投稿先・公開範囲・指定された切り出し範囲を変えない。
3. 同梱 `scripts/story_from_url.py` を実行する。`--download-only`は素材取得のみ、`--preview-only`は取得素材・実ログインアカウント・公開範囲の確認までで、Instagramへのアップロード・公開を行わない。プレビューの確認だけを依頼された場合はここで止める。配信元のH.264/AAC（または音声なし）MP4を `original.mp4` に保存する。横動画のストーリーは同梱 `story_media.py` で1080×1920へ変換する。元映像を幅1080で中央に置き、背景は元映像の拡大・中央切り抜き・明るさ+0.2・ぼかしsigma17を使う。縦動画・正方形動画は切り出し指定がなければ無変換。音声の置換・自動分割は行わない。
4. Relayを既存設定・台帳で起動し、同じ操作IDで投稿する。`published`、media ID、ジョブの`audience`を確認する。親しい友達ではRelayが公開応答の`audience: besties`を検証する。`unknown` はInstagram上で確認し、自動再投稿しない。

```powershell
python '<skill-dir>/scripts/story_from_url.py' 'https://vt.tiktok.com/ZSb5JR1mx/' --audience close_friends --profile account1 --operation '<UUID>' --download-only
# 実ログインアカウントも確認する場合は --download-only を --preview-only に変更する
# 明示的な投稿依頼がある場合に限り、同じコマンドから上記のフラグを外して投稿する
# キャプション付きでは初回から --caption 'コメントの文面' を追加する
```

`<skill-dir>` はこのSKILL.mdの所在ディレクトリ。途中停止・タイムアウトは同じコマンドと操作IDで再開する。スクリプトは操作JSONとAPIのIdempotency-Keyを保持し、既存ジョブがあれば状態確認だけを行う。キャプションは任意の文字列（UTF-16で2200文字以内）。同じ操作IDで文面を変更すると拒否する。旧操作のキャプション省略は空文字として扱う。

通常の投稿は互換APIの`POST /v1/stories`を使い、公開を開始する。`--preview-only`は最新版の`POST /v1/story-previews`を使う。同じ操作の未期限切れプレビューは再利用する。プレビューは10分で期限切れになり、後からの投稿は元のURL・公開範囲・プロファイル・文面を指定した明示的な投稿コマンドで行う。取得・プレビュー・診断の成功を投稿成功として扱わない。

## 検証

2026-10-08の作業開始時にGitHubの`origin/main`とローカルHEAD（`0173c1a`）の一致、yt-dlp安定版`2026.08.19`への更新を確認した。ハイライト登録を追加したpush対象の130テスト・型チェック・ビルド・lint、Skillの16テスト、模擬Web画面での新規追加・選択保持・保存後確認を実行した。

Skill例のTikTok短縮URLから配信元のH.264/AAC MP4（720×1280、約6.18秒）を取得し、`account1`の実ログインアカウントと`close_friends`のプレビューを確認した。この検証ではアップロード・公開を行っていない。2026-10-17にはYouTube実URLの取得、冒頭60秒の縦変換、通常公開と既存ハイライトへの新規追加も確認した。キャプション付き実公開は未検証。

```powershell
python '<skill-dir>/scripts/test_story_from_url.py'
```

## ハイライト登録

ユーザーが登録先を指定した場合は、投稿コマンドに`--highlight 'idol'`を追加する。名前は既存ハイライトへの完全一致で、同名が複数ある場合は`--highlight-id '<数値ID>'`を使用する。新規ハイライト作成、名前・カバーの変更、元ストーリーの再投稿は行わない。

すでに公開した操作へ後から追加する場合は、元のURL・公開範囲・プロファイル・文面・操作IDを使い、`--highlight-only --highlight 'idol'`を指定する。受理済みストーリーの状態を照会し、公開済みの同じメディアだけを登録する。未公開操作に`--highlight-only`を指定しても投稿しない。`--download-only`・`--preview-only`ではハイライト登録も行わない。

```powershell
# 投稿からハイライト登録まで
python '<skill-dir>/scripts/story_from_url.py' '<URL>' --audience close_friends --profile account1 --operation '<UUID>' --highlight 'idol'
# 同じ公開済み操作を再投稿せず登録
python '<skill-dir>/scripts/story_from_url.py' '<元のURL>' --audience close_friends --profile account1 --operation '<元のUUID>' --highlight-only --highlight 'idol'
```

Relayの`GET /v1/highlights`で実アカウントと登録先IDを確認し、`POST /v1/highlights/:id/stories`へ`storyJobId`を渡す。登録は専用の永続台帳とプロファイル排他を使う。Web編集画面のサムネイルからストーリーIDを照合し、既存の選択を保ったまま対象だけを追加する。保存直前の`applying`を永続化し、保存後に選択済み一覧を開き直して確認する。親しい友達の元ストーリーを通常公開へ変更しない。

同じ操作で登録先を変更しない。登録済みは`alreadyPresent: true`で完了し、保存操作を省く。`GET /v1/highlight-jobs/:id`の`completed`とアカウント・登録先・メディアID・公開範囲を照合する。`unknown`は自動再登録しない。投稿完了とハイライト登録完了は別々に報告する。

対応する画面文言は日本語と英語。直近の投稿を対象とし、アーカイブの初期表示にない古い動画や画面変更で識別できない動画は、別の動画を選ばず停止する。新規追加の保存フローはモックで検証し、実アカウントでは登録済み動画の検出と再実行時の状態照会を確認した。

## 投稿の制約

2026-10-03に通常公開・親しい友達への投稿、2026-10-08にユーザー指定の冒頭60秒版の親しい友達への公開を確認した。30秒以上の動画ではRelayがアップロード後、公開前に30秒の処理待ちを入れる。公開要求の自動再送はしない。親しい友達はブラウザ内の `PolarisInstapi.apiPost` から固定の `/api/v1/media/configure_to_story/` へ `audience: besties` を送る。公開関数に引数を追加する方式ではない。仕様変更で限定公開の根拠が得られなければ結果不明として停止し、通常公開で代用しない。ブラウザー方式ではCookieや認証値をブラウザー内に留める。ユーザーが許可したHTTPモードでは、専用セッションを権限600のローカルファイルだけに保持し、認証値を応答・ログへ出さない。

キャプション付き投稿は公開応答の `media.caption.text` が指定文面と一致する場合だけ成功とする。確認できなければ `unknown` にし、文面を省略して再投稿しない。キャプションの実アカウントでの公開検証は未実施。投稿データのキャプションは画面上の文字表示を保証しない。

動画はMP4、H.264、音声はAACまたはなし、1〜60秒、100MiB以下、各辺4096px以下。取得できない形式や制限超過は理由を報告して停止する。ダウンロード成功を投稿成功と報告しない。

ユーザーが明示的に切り出しを指定した場合は `--clip-start 0 --clip-end 60` のように秒数を指定する。再開時も同じ範囲を指定し、同じ操作IDの範囲を変更しない。指定範囲は元動画内の1〜60秒。原本を保存し、ffprobeで変換後の長さと形式を検証する。23.976fpsなどの端数による60秒超過を避けるため、変換時は切り上げた整数fps（最大60）を使い、音声は指定尺のサンプル数で切ってタイムスタンプを0から振り直す。変換内容・コマンド・原本と出力のSHA256を操作JSONに保存する。50MiB超の検証済み素材はRelayのファイルパス転送を使う（Playwrightのbuffer転送は50MiBまで）。

縦変換の見た目は [MediaDownloaderTool.py](https://github.com/shirafukayayoi/Shirafuka-Practice/blob/main/Python/MediaDownloaderTool.py) のCPU処理に合わせる。エンコードはこのPCのCPU負荷と投稿上限を考慮してlibx264 veryfast/CRF20を使う。映像の配置・背景効果は同じ。素材検証は `python scripts/test_story_media.py` でも実行できる（Instagramへの通信なし）。
