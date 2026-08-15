# live Instagram smoke test utilities

実 Instagram へのアクセスを通常 CI から分離した、明示実行専用の smoke runner です。

```powershell
$env:INSTAGRAM_SMOKE_USERNAME = "public.username"
pnpm test:live
```

`settings.json` の最初の `type: "launch"` profile と、その `userDataDir` を使用します。別の profile directory を使う場合は `INSTAGRAM_SMOKE_PROFILE_DIR`、別の設定ファイルを使う場合は `INSTAGRAM_SMOKE_SETTINGS` を指定します。同じ persistent profile をブラウザが使用中の場合は、既存ブラウザを終了してから再実行してください。

実行順は `getPublicProfile`、`listPublicProfileMedia`、先頭 media の shortcode を使う `getPublicMedia`、`listPublicMediaComments` です。対象が非公開、または media 一覧が空の場合は明示的に skip します。成功ログには操作名、返却件数、所要時間だけを出し、レスポンス本文、username、shortcode、Cookie、token、画像 URL は出しません。
