# instagram-api-safe-wxt

WXT content script から MAIN-world の `instagramApiSafe` に接続する最小ブリッジです。公開するのは `waitStartup`、`execute`、`initHook`、`getCatalogStatus` だけで、任意 URL や生 HTTP リクエストは扱いません。

```ts
// wxt.config.ts
export default defineConfig({ modules: ["instagram-api-safe-wxt/module"] });
```

```ts
import { createInstagramBrowser, INSTAGRAM_MATCHES } from "instagram-api-safe-wxt";

export default defineContentScript({
  matches: [...INSTAGRAM_MATCHES],
  runAt: "document_start",
  async main(ctx) {
    const instagram = await createInstagramBrowser(ctx);
    await instagram.waitStartup();
    const profile = await instagram.execute("getPublicProfile", { username: "instagram" });
    console.log(profile);
  },
});
```

RPC は script 要素ごとの `CustomEvent` と `MessageChannel` を使います。各要求には ID とタイムアウトがあり、ページ遷移または content-script 無効化時には保留要求を `BROWSER_DISCONNECTED` として終了します。
