# Repository Guidelines

## プロジェクト構成

pnpm の TypeScript モノレポです。`packages/contracts` は公開契約、`inject` はブラウザ内の実行器、`request` は Playwright クライアント、`wxt` は拡張用アダプター、`server` は HTTP relay、`dashboard` は React の状態表示を担当します。

通常のソースは各パッケージの `src/`、テストは `test/` に配置します。例外として contracts のテストは `src/`、inject の実装は `setup.js` にあります。`packages/test-utils` は試験用の補助コード、`examples/basic` は利用例、`scripts/` は実環境 smoke test、`docker/` はコンテナ設定です。画面のスタイルは `packages/dashboard/src/style.css` にあります。

## セットアップと開発コマンド

CI と同じ Node.js 24、pnpm 11.5.0 を使用してください。

- `corepack enable`、`pnpm install --frozen-lockfile`: パッケージ管理を有効化し、固定された依存関係を導入します。
- `pnpm build`: ワークスペースをビルドし、inject を検証します。
- `pnpm dev:relay`: relay を watch モードで起動します。
- `pnpm dev:dashboard`: Vite の開発サーバーを起動します。
- `pnpm type-check`、`pnpm test`、`pnpm lint`: 型、テスト、Biome の lint を確認します。
- `pnpm format`、`pnpm check`: 整形を適用、または整形・lint をまとめて確認します。

relay 起動前に `Copy-Item settings.example.json settings.json` を実行し、`INSTAGRAM_RELAY_API_TOKEN` を環境変数に設定してください。初回ログインは表示されたブラウザで手動実行します。

## コーディング規約

TypeScript の strict 設定を維持してください。Biome に従い、タブインデント、120 文字幅、ダブルクォート、セミコロンを使用します。関数・変数は `camelCase`、型は `PascalCase`、複数語のファイル名は `profile-manager.ts` のようにハイフンで区切ります。NodeNext のモジュールでは既存コードに合わせて相対 import に `.js` を付けます。

## テスト方針

主に Vitest、inject では Node.js 標準のテストランナーを使用します。ファイル名は `*.test.ts`、inject は `*.test.mjs` としてください。数値のカバレッジ基準は未設定です。変更に応じて入力検証、認証拒否、公開性判定、セッション復旧などの振る舞いを検証してください。

個別実行例は `pnpm --filter instagram-api-safe-relay test` です。`packages/test-utils` は package manifest がないため、ルートの再帰テストには含まれません。`pnpm test:live` は通常 CI 外の手動試験です。ログイン済みブラウザを閉じ、承認済みの試験対象を `INSTAGRAM_SMOKE_USERNAME` に設定して実行してください。

## コミットと Pull Request

このリポジトリでは、変更を検証してコミットしたら、その都度GitHubの同じ作業ブランチへpushする。初回はupstreamを設定し、push成功とリモート先端の一致を確認してから完了を報告する。pushできない場合は未pushであることと原因を明示する。ユーザーが明示的に求めない限りforce pushやmainへの直接マージはしない。

Git 履歴は「Instagram safe relay 初期実装」の 1 件で、固定のプレフィックス規約はありません。変更対象と目的が分かる簡潔なコミット名を使用してください。PR には目的、変更内容、実行した検証と結果、関連 issue があればそのリンクを記載します。画面変更にはスクリーンショットを添付してください。提出前に CI と同じ型チェック、テスト、ビルド、lint を実行します。

## セキュリティと設定

ユーザーが許可した `browser.type: "http"` はブラウザーを起動しない固定内部API経路です。このモードでは専用プロファイルの認証をローカルの `private_sessions/`（ディレクトリ700・ファイル600）へ移行できます。認証値をAPI応答・ログ・Gitへ出さず、転送先を固定し、リダイレクト・公開要求の再送を拒否してください。ブラウザー方式には従来の認証隔離を維持します。

DMは`packages/server/src/direct/`の別サービスです。既存の4操作・WXTの公開情報契約を拡張しないでください。DM本文はログ・送信台帳へ保存せず、`dm_data/`をコミットしません。送信は既存の会話IDを使い、送信直前の`sending`を永続化します。成否不明を自動再送しないでください。実際の送信試験はユーザーが宛先と本文を指定した場合に限ります。

公開情報の読み取りカタログは既存の 4 操作に限定し、relay の `127.0.0.1` bind を維持してください。ストーリーズ投稿は `packages/server/src/stories/` の別サービスにあり、設定で有効化します。Cookie、CSRF 値、LSD、認証ヘッダーをブラウザから Node.js へ渡さず、任意 URL・GraphQL・raw proxy を追加しないでください。未知の通信仕様は安全側に失敗させます。`settings.json`、`.env`、`user_data/`、`story_data/`、トークン、セッション情報をコミットやログに含めないでください。

## ストーリーズ投稿の変更

メンション受付は`packages/server/src/story-mentions/`の別サービスです。自分宛ての`reel_share.type: mention`だけを保存し、署名付き素材URL・DM本文を外へ返さないでください。`story_mention_data/`はコミットしません。ネイティブ再投稿の通信・元投稿者への参照・公開証拠が未検証の間は`NATIVE_REPOST_UNAVAILABLE`で停止します。素材の再アップロードで代替しません。`publishing`の永続化と、アカウント・元メディア単位の重複防止を維持してください。

`caption` は投稿データの文面で、画像・動画上の文字描画とは別です。省略・空文字は旧要求と同じ重複判定を維持し、非空の文面はハッシュに含めます。HTTPモードの投稿時コメントは `story_captions` のクイックキャプションとして送ります。公開応答または同じメディアの読み戻しで、所有者・公開範囲と `media.caption.text` または `story_captions` 内の指定文面を照合してください。確認できない場合はメディアIDを保持して `unknown` とし、再送しないでください。本文をジョブ応答・Relayログへ出さないでください。

`audience` の既定値は `all` です。親しい友達の `close_friends` はブラウザ内で固定の `audience: besties` を送信し、公開応答で同じ値を確認してください。通常公開へ置き換えないでください。台帳と重複判定に公開範囲を含め、旧台帳の通常公開との互換性を維持します。確認できない公開結果は `unknown` とし、再送しないでください。

投稿は素材検証、永続台帳、プロファイル単位の排他処理を経由させてください。公開直前の `publishing` を永続化し、結果不明を自動再送しない規則を維持します。画像・動画の実投稿試験は明示的に依頼された場合だけ行い、通常テストにはモックを使用してください。ffprobe による形式・容量・長さ・コーデックの検証、許可ディレクトリの実体パス検証、再起動後の重複防止をテストします。
