# instagram-api-safe-inject

MAIN world の `document_start` で使う、固定カタログだけを実行する注入アセットです。

`getPublicProfile`、`listPublicProfileMedia`、`getPublicMedia`、`listPublicMediaComments` は、レビュー済みの Instagram 読取 GET パスだけを使用します。任意の URL・method・header・body・raw dispatch は受け付けません。応答を公開 DTO に変換できない場合、または非公開情報の場合は fail-closed でエラーを返します。

`instagramApiSafe.setHook()` は fetch/XHR のメタデータだけを観測します。request header、cookie、body、query、response body は公開しません。
