# instagram-api-safe-request

Playwright の既存ログイン済みページから、公開情報カタログにある 4 操作だけを実行します。任意 URL、HTTP メソッド、ヘッダー、リクエスト本文を受け取る API は公開しません。

```ts
const instagram = createInstagramBrowser(page);
await instagram.inject();
await instagram.goto();
const profile = await instagram.execute("getPublicProfile", { username: "instagram" });
```

`waitStartup(timeoutMs)` は既定で 15 秒後に `InstagramBrowserError`（`TIMEOUT`）を返し、ページ切断は `BROWSER_DISCONNECTED` に正規化します。
