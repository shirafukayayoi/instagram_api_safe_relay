# Instagram URL投稿用MCP

`scripts/instagram_mcp.py` は、既存のHTTP Relayと同梱URL投稿スクリプトを利用するstdio MCPです。Python 3.11以降と `python -m pip install -r scripts/mcp-requirements.txt`、URL投稿Skillの依存ツールが必要です。MCP SDKは検証済みの1.26.0へ固定しています。

## 設定と起動

HTTPモードの設定・非公開セッション・ビルドを先に用意します。[HTTPモード](http-mode.md)を参照してください。`.env` のBearerはローカルで読み、MCP設定や応答には含めません。`settings.json` の全プロファイルがHTTPモードであることを確認します。停止中のRelayは必要時だけ起動し、稼働中ならそのまま利用します。

```powershell
codex mcp add instagram --env PYTHONUTF8=1 -- python -B '<リポジトリ>/scripts/instagram_mcp.py'
```

Pythonの絶対パスを指定すると、別環境のPythonを起動する間違いを防げます。`~/.codex/config.toml` の `[mcp_servers.instagram]` に `startup_timeout_sec = 30` と `tool_timeout_sec = 600` を設定します。設定の反映後、MCPクライアントを再接続します。起動時の作業ディレクトリには依存しません。

## ツール

| ツール | 処理 |
| --- | --- |
| `instagram_status` | 接続・依存ツール・選択中の投稿先の診断 |
| `instagram_accounts` | 登録一覧・状態・選択中アカウント |
| `instagram_select_account` | 実アカウントを照合して今後の投稿先を選択 |
| `instagram_preview_url` | YouTube・TikTok・Instagram投稿の素材準備とプレビュー |
| `instagram_publish_operation` | 同じ操作ID・アカウントID・公開範囲で公開 |
| `instagram_operation_status` | 元の操作・既存の投稿ジョブ・ハイライトジョブの照会 |
| `instagram_highlights` | 既存ハイライト一覧の取得 |
| `instagram_resume_highlight` | 初回指定済みの動画のハイライト登録を再開 |

最初に状態・アカウントを確認します。プレビュー初回にURL、公開範囲、コメント、動画の切り出し、登録先を指定します。操作IDを省略した初回プレビューはUUIDを作ります。再開は同じIDと引数を指定します。プレビューはInstagramへアップロード・公開しません。

ユーザーから明示的な投稿依頼がある場合、返された `operationId`、`preview.account.id`、`preview.audience` を公開ツールへ渡します。プレビュー期限は10分です。期限切れは同じIDでプレビューを更新します。成功済み・処理中・結果不明の操作に新IDを作りません。投稿依頼のない接続試験では公開ツールを呼びません。

公開には `POST /v1/story-previews/:id/publish` を使い、確認した素材のコピー・アカウント・文面・公開範囲を固定します。送信前に同じ操作台帳へプレビューIDをジョブIDとして保存し、MCPの送信状態も残します。応答が失われても再送せず、同じIDのジョブを読み取ります。ハイライト追加と状態照会は既存スクリプトを共用します。コメントは既存の本人コメント経路を使い、旧形式の文面を持つ操作は公開前に停止します。既存ジョブがある公開ツールの再呼び出しは状態照会だけを行います。動画のハイライト再開ツールは、新しい登録先の指定や再投稿を受け付けません。Instagramカードのハイライトは初回プレビューで指定し、公開時の既存処理を利用します。

接続・ダウンロード・公開の途中でMCPが切れた場合も元の操作IDで状態を調べます。失敗した子プロセスの標準出力・標準エラーには素材URLなどが含まれ得るため、MCPへ返しません。`commandSucceeded` だけで公開成功と判断せず、`result.state: published` とアカウント・公開範囲・メディアIDを確認します。ハイライトは別に `highlightResult.state: completed` を確認します。

子プロセスには標準入力も `DEVNULL` を指定します。WindowsでMCPの通信パイプを継承すると、子Pythonが起動時に待ち続ける既知の問題があるためです。テストでは実際のstdio MCPから子Pythonを起動し、標準入力がEOFになることを確認します。参考：[公式SDKの不具合報告](https://github.com/modelcontextprotocol/python-sdk/issues/671)。

DM、削除、任意URLの転送、任意GraphQL、ログイン・2FAの自動化は提供しません。

## 検証

```powershell
python scripts/test_instagram_mcp.py
# 明示的に依頼された接続確認。公開しない。
python scripts/test_instagram_mcp.py --live
```

SDKの参照：[公式Python SDK 1.26.0](https://github.com/modelcontextprotocol/python-sdk/tree/v1.26.0)。Codex登録の参照：[MCP設定](https://learn.chatgpt.com/docs/mcp)。
