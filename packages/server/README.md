# instagram-api-safe-relay

ログイン済みInstagram Webを利用する、ローカル専用・読取専用の実験的relayです。任意URLやraw GraphQLは受け付けません。

```powershell
Copy-Item settings.example.json settings.json
$env:INSTAGRAM_RELAY_API_TOKEN = -join ((1..48) | ForEach-Object { [char](Get-Random -Minimum 48 -Maximum 123) })
pnpm dev:relay
```

最初の起動ではheadedブラウザでInstagramへ手動ログインしてください。明示的な許可なく自動アクセスする行為はInstagramの規約に抵触する可能性があります。
