# instagram-api-safe-dashboard

Relayに同梱されるローカル専用の状態画面です。資格情報、生のヘッダー、Cookie、CSRF値、ベンダー応答は表示しません。

ストーリーズの画像・動画は、Relay側の許可ディレクトリにある素材の絶対パスで指定します。プレビューで現在の実ログインアカウント（IDとユーザー名）、素材、通常公開／親しい友達を確認し、チェックボックスと「確認して公開」で公開します。接続プロファイルは設定上のラベルとして表示します。入力変更、キャンセル、期限切れ、Relay再起動では新しいプレビューと確認が必要です。

公開前に操作IDをブラウザのlocalStorageへ保存します。保存できない場合は送信しません。再読込・通信切断後は同じIDの状態をGETで照会し、公開要求を自動再送しません。`unknown`は結果の手動確認が必要で、新しい投稿の準備へ進めません。公開受付前の中止はRelay側で確認し、受付済み操作は中止できません。

利用には既存の`dashboard: true`、`stories.enabled: true`、`stories.allowedMediaDirectories`、Chromiumと`ffprobe`が必要です。この画面からログインや設定変更は行いません。APIの区分と互換性は[server README](../server/README.md)を参照してください。
