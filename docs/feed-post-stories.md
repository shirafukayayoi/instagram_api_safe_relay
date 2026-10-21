# Instagram投稿をストーリーへ共有

HTTPモードで、公開済みのInstagram投稿・リールのURLから元投稿を参照する `feed_media` カードをストーリーに追加します。自分宛てのメンションストーリーの再投稿とは別の機能です。既存のストーリー素材検証・キュー・永続台帳・公開範囲・キャプション・ハイライト登録を共用します。

## URL投稿Skill

```bash
python '<skill-dir>/scripts/share_instagram_post.py' \
  'https://www.instagram.com/p/<shortcode>/' \
  --audience all --operation '<UUID>' --preview-only
```

このLinux PCでは `outputs/instagram-story --share-post` に続けて上記引数を指定できます。`--profile` 省略時は選択中のアカウントを使います。明示的な投稿依頼の範囲で、同じ操作ID・元投稿・投稿先・公開範囲・キャプションを維持して `--preview-only` を外すと公開します。元URLの共有用クエリは保存前に除きます。

元画像を `work/story-smoke/<UUID>/original-post-image` に保存し、1080×1920の明るいぼかし背景へ変換します。投稿カードは元メディアID・投稿者ID・中央配置を持つInstagramのステッカーとして指定します。プレビュー応答にはアカウント・公開範囲・元投稿の参照と投稿者が含まれます。プレビュー画像は背景用素材で、カードはInstagram側が扱います。

`--caption` と `--highlight` / `--highlight-id` に対応します。指定しないハイライトへ自動登録しません。曲のキャプション規則はSkillを参照してください。

## APIと公開の確認

- `GET /v1/story-feed-posts/:shortcode`：公開設定とストーリー共有許可を照合し、投稿ID・投稿者ID/ユーザー名・画像寸法・枚数だけを返します。
- `GET /v1/story-feed-posts/:shortcode/image`：同じ元投稿を再照合し、先頭画像を返します。署名付きURLは応答へ含めず、許可したInstagram CDNに認証Cookieを送らずアクセスします。リダイレクトを追わず8MiBで打ち切ります。
- `POST /v1/story-previews` / `POST /v1/stories`：従来の素材入力に `feedPost: {shortcode, mediaId, ownerId}` を追加できます。画像素材だけを受け付け、HTTPアダプター以外では公開前に拒否します。

すべてBearer認証とプロファイル照合を要求します。公開情報の従来4操作カタログは変更しません。非公開、共有不可、共有可否が不明な投稿は拒否し、アップロード前と公開直前にも参照先を再確認します。

公開前に `publishing` を保存し、固定の `configure_to_story` に `reshared_media_id` と `tap_models` を1回だけ送ります。通常のアカウント・公開範囲・キャプションの検証に加え、公開応答の `story_feed_media`、または公開済みメディアの読み戻しで同じ元投稿のIDを確認します。リンクを確認できない場合は `unknown` として止め、自動再投稿しません。

同じプロファイル・元投稿の受理済み/公開済み/結果不明のジョブは、別の操作キーからも重複して作れません。`failed` の旧ジョブ・台帳も保持します。再開時は同じ操作IDで状態だけを照会し、指定済みハイライトの未完了処理があれば同じメディアで続行します。

通信形式は [instagrapiの投稿シェア実装](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/media.py) と [ストーリーのfeed_mediaステッカー](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/photo.py) を参照しました。公開時に元投稿への参照を実応答で検証し、画像の再アップロードだけを共有成功とは扱いません。

実装時の模擬通信テストで元投稿参照の検証と重複防止を確認済みです。実アカウントでの公開結果はまだ未確認です。
