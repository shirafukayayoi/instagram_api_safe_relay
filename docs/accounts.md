# アカウント切り替え

各アカウントの認証ファイルを別のHTTPプロファイルに登録し、ユーザー名を確認して次の投稿先を選択できます。通常運用ではブラウザーを起動しません。

## Dashboard

「アカウント切り替え」でユーザー名を選び、「このアカウントを使う」を押します。実ログインアカウントを読み取りで照合してから選択を保存します。投稿先を変えた場合は作成済みプレビューと確認チェックを解除し、素材・文面・公開範囲は保ったまま新しい投稿先でプレビューし直します。

処理中・結果不明・再開中の操作は、元のプロファイルに固定します。切り替えによる新規投稿や再送は行いません。実アカウントの切り替え・新規投稿はプレビューで再確認します。

## URL投稿Skill

以下の`python '<skill-dir>/scripts/story_from_url.py'`は、Linux PCでは設定済みの`outputs/instagram-story`ラッパーに置き換えます。

```bash
# 登録済みアカウントと選択中の投稿先を表示
python '<skill-dir>/scripts/story_from_url.py' --list-accounts --start-relay
# ユーザー名または設定ラベルで選択。投稿や素材アップロードはしない
python '<skill-dir>/scripts/story_from_url.py' --use-account '@username'
python '<skill-dir>/scripts/story_from_url.py' --use-account account2
# 新規操作は選択したアカウントを使用
python '<skill-dir>/scripts/story_from_url.py' '<URL>' --audience close_friends --operation '<UUID>' --preview-only
```

`--profile account1`を指定したコマンドは、そのプロファイルを優先します。既存の操作IDを`--profile`なしで再開した場合は、操作JSONに保存した元のプロファイルを使い、現在の選択先で置き換えません。管理コマンドとURL投稿を同じコマンドで実行することはできません。

単一の登録アカウントは自動選択されます。複数アカウントで未選択の場合は、先に`--use-account`を実行してください。ユーザー名の重複などで一意に指定できない場合は、設定ラベルを使います。

## 別アカウントの登録

1. 別の専用プロファイル（例：`packages/server/user_data/account2`）でユーザーが手動ログインし、ブラウザーを正常終了します。既存のaccount1のセッションは上書きしません。
2. [HTTPモードの移行手順](http-mode.md)の`import-browser-session.py`で、新しい`private_sessions/account2.json`へ保存します。アカウントIDとユーザー名は、ログインした本人のものを指定します。ファイルを600、保存ディレクトリを700にします。
3. リポジトリで次を実行します。パスはリポジトリのルート基準です。

```bash
pnpm accounts:register --name account2 --session-file private_sessions/account2.json
```

コマンドは実アカウントの読み取り照合、登録名・アカウントIDの重複確認、設定の検証を行います。成功時はGit管理外の`work/skill-relay/`に設定のバックアップを作り、新しいプロファイルだけを追加します。認証値は出力しません。同時登録はロックで拒否し、照合中の設定変更も上書きしません。処理が中断してロックが残った場合は、登録プロセスが終了していることを確認するまで削除しません。

追加した設定を反映するには、処理中の投稿がないことを確認してRelayを正常終了・再起動し、その後一覧から投稿先を選びます。アカウントの削除、認証ファイルの上書き、パスワード・2FAの自動入力は行いません。

## API

Bearer認証が必要です。応答には設定ラベル、状態、アカウントID・ユーザー名と選択中の投稿先だけを含み、認証値は含めません。

- `GET /v1/accounts`：登録一覧と`selected`を返します。
- `POST /v1/accounts/select`：`{"profile":"account2","expectedAccountId":"確認したID"}`で選択します。`expectedAccountId`は任意ですが、一覧を見て選択するUI・Skillでは指定します。未ログイン・別アカウント・保存失敗では選択を確定しません。

選択記録は`accountSelectionFile`で指定します。既定値は`../../work/skill-relay/selected-account.json`（`packages/server/`基準）です。プロファイルと確認済みアカウントID・ユーザー名を保存し、再起動後も復元します。保存先が設定から消えた場合や別のアカウントへ変わった場合は、別の投稿先へ自動で切り替えません。

選択は新規操作の初期値です。複数プロファイルでのストーリー・ハイライトAPIには引き続き`x-profile-name`が必要で、受理済みのジョブ・プレビューは元のプロファイルを維持します。
