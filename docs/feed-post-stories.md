# Instagram投稿をストーリーへ共有

HTTPモードで、公開済みのInstagram投稿・リールのURLを参照する `feed_media` カードの共有を試験実装しています。実公開は `stories.feedPostSharingEnabled` の既定値（未指定時）では無効です。モバイルAPI形式の公開検証が完了するまでは、画像の準備・プレビューだけを使用してください。自分宛てのメンションストーリーの再投稿とは別の機能です。既存のストーリー素材検証・キュー・永続台帳・公開範囲・キャプション・ハイライト登録を共用します。

## URL投稿Skill

```bash
python '<skill-dir>/scripts/share_instagram_post.py' \
  'https://www.instagram.com/p/<shortcode>/' \
  --audience all --operation '<UUID>' --preview-only
```

このLinux PCでは `outputs/instagram-story --share-post` に続けて上記引数を指定できます。`--profile` 省略時は選択中のアカウントを使います。明示的な投稿依頼の範囲で、同じ操作ID・元投稿・投稿先・公開範囲・キャプションを維持して `--preview-only` を外すと公開します。元URLの共有用クエリは保存前に除きます。

元画像を `work/story-smoke/<UUID>/original-post-image` に保存し、Pillowで1080×1920のぼかし背景・中央の角丸写真・共同投稿者を含むユーザー名を描画した `story-card.jpg` を作ります。実行するPythonに `python -m pip install Pillow` が必要です。同じ写真の領域に元メディアID・投稿者IDを持つInstagramのステッカーを指定します。プレビュー応答にはアカウント・公開範囲・元投稿の参照と投稿者が含まれます。写真とユーザー名は画像として描画済みです。元投稿リンクは別途Instagramの公開結果で検証します。

`--caption` と `--highlight` / `--highlight-id` に対応します。指定しないハイライトへ自動登録しません。曲のキャプション規則はSkillを参照してください。

## APIと公開の確認

- `GET /v1/story-feed-posts/:shortcode`：公開設定とストーリー共有許可を照合し、投稿ID・投稿者ID/ユーザー名・画像寸法・枚数だけを返します。
- `GET /v1/story-feed-posts/:shortcode/image`：同じ元投稿を再照合し、先頭画像を返します。署名付きURLは応答へ含めず、許可したInstagram CDNに認証Cookieを送らずアクセスします。リダイレクトを追わず8MiBで打ち切ります。
- `POST /v1/story-previews` / `POST /v1/stories`：従来の素材入力に `feedPost: {shortcode, mediaId, ownerId}` を追加できます。画像素材だけを受け付け、HTTPアダプター以外では公開前に拒否します。

すべてBearer認証とプロファイル照合を要求します。公開情報の従来4操作カタログは変更しません。非公開、共有不可、共有可否が不明な投稿は拒否し、アップロード前と公開直前にも参照先を再確認します。

公開前に `publishing` を保存し、`i.instagram.com` の固定 `configure_to_story` へ、`signed_body` 形式で `reshared_media_id` と `tap_models` を1回だけ送ります。通常の素材投稿は従来どおりWeb向けAPIで、カード共有と分けています。通常のアカウント・公開範囲・キャプションの検証に加え、公開応答の `story_feed_media`、または公開済みメディアの読み戻しで同じ元投稿のIDを確認します。リンクを確認できない場合は `unknown` として止め、自動再投稿しません。

同じプロファイル・元投稿の受理済み/公開済み/結果不明のジョブは、別の操作キーからも重複して作れません。`failed` の旧ジョブ・台帳も保持します。削除をユーザーが明示的に許可し、削除成功と自分のストーリー一覧からの消失を確認したものだけ、ローカル台帳に `removal: {mediaId, verifiedAt}` の注記を付けられます。元の状態を上書きせず、自動再投稿は行いません。再試行は別途の明示許可と元操作への参照記録が必要です。再開時は同じ操作IDで状態だけを照会し、指定済みハイライトの未完了処理があれば同じメディアで続行します。

通信形式は [instagrapiの投稿シェア実装](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/media.py) と [ストーリーのfeed_mediaステッカー](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/photo.py) を参照しました。公開時に元投稿への参照を実応答で検証し、画像の再アップロードだけを共有成功とは扱いません。

2026-10-21の初回試験では、Web向けフォームにカード情報を追加しても `story_feed_media` に反映されず、ぼかし背景だけが公開されました。`unknown` で停止し、読み戻しで参照欠落を確認した後、ユーザーの明示許可でこの1件を削除し、全件読み戻しで消失を確認しました。修正版は写真描画とモバイルAPI形式を使用し、既定で公開を停止しています。修正版の実公開は未検証です。
