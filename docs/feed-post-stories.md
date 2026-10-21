# Instagram投稿をストーリーへ共有

HTTPモードで、公開済みのInstagram投稿・リールのURLを参照する `feed_media` カードの共有を試験実装しています。実公開は `stories.feedPostSharingEnabled` の既定値（未指定時）では無効です。モバイルAPI形式の試験でも公開・リンクの成功を確認できていないため、画像の準備・プレビューだけを使用してください。自分宛てのメンションストーリーの再投稿とは別の機能です。既存のストーリー素材検証・キュー・永続台帳・公開範囲・キャプション・ハイライト登録を共用します。

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

2026-10-21の初回試験では、Web向けフォームにカード情報を追加しても `story_feed_media` に反映されず、ぼかし背景だけが公開されました。`unknown` で停止し、読み戻しで参照欠落を確認した後、ユーザーの明示許可でこの1件を削除し、全件読み戻しで消失を確認しました。修正版は写真描画とモバイルAPI形式を使用し、既定で公開を停止しています。修正版はユーザーの「公開して確認後、消して」という許可で1回だけ試験しましたが、結果は `unknown` でメディアIDを取得できませんでした。自分のストーリーのWeb全件読み戻しを2回行い、公開中0件を確認しました。削除できる対象IDはなく、削除要求は送信していません。別のモバイルAPI読み取りもHTTP 403で拒否されました。ブラウザーセッションの正常なWeb読み取りと、モバイルAPIでの利用可否は別です。原因は断定せず、元の `unknown` 台帳と重複防止を保持し、試験用フラグを無効に戻しました。追加の公開は行っていません。


## 再調査した対応候補

同じ公開結果不明が続いたため、[instagrapiの公開データ](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/photo.py)、[通信ヘッダーと認証の実装](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/private.py)、[ストーリーの読み取り](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/story.py)を再確認しました。

1. モバイルAPI用の認証・端末情報と要求形式を揃える。ライブラリは専用ヘッダーとAuthorizationを使用しており、Web Cookieだけで同じ権限になるとは確認できません。認証・端末情報を推測して追加せず、今回の403を未対応として記録します。
2. `tap_models` と `reshared_media_id` の構造を公開実装と照合する。カードの参照形式は一致していますが、要求の受理や公開後の参照を保証するものではありません。
3. 読み取り専用で自分の公開中ストーリーを照合する。Web GraphQLの全件読み取りが今回利用できたため、この方法を採用し、再送せず後片付けの対象有無を確認しました。モバイルの `feed/user/<自分のID>/story/` は403だったため確認証拠に数えません。
4. 通常の写真とURLリンクステッカーで共有する。公開実装には別のリンクステッカー形式がありますが、ユーザーが指定した投稿カードと異なるため、自動的な代用はしません。

通常運用は既定無効のまま維持します。次の実装変更はローカルで検証し、追加の公開試験を行う場合は新たに明示許可が必要です。今回の削除対象の有無はローカル操作記録に保存し、未公開だったと断定するために台帳の `unknown` を書き換えません。


## モバイルAPI認証の修正

2026-10-21の追加調査で、Web CookieとWeb用User-AgentのままモバイルAPIへ送信していたことを確認しました。[instagrapiの保存済みsessionid利用](https://github.com/subzeroid/instagrapi/blob/master/instagrapi/mixins/auth.py)に合わせ、同じセッションを `Bearer IGT:2:` 形式に変換し、モバイルAPI専用ヘッダーを使用します。この形式で自分のストーリー読み取りと `accounts/current_user/` のアカウント照合がHTTP 200で成立しました。これは読み取りの成功で、公開成功の証拠とは区別します。

カード共有ではアップロード前と公開直前にモバイルAPIで投稿先を照合します。端末UUID・Android IDは既存の非公開セッションファイルへ権限600で一度だけ保存し、再起動後も同じ値を使用します。Web APIと通常の素材アップロードの認証形式は変えません。パスワードによる自動ログイン、2FA、challengeの処理、端末の署名・attestation生成は追加しません。

公開後のリンク読み戻しが失敗しても、応答で照合した自分のメディアIDを結果不明の台帳に残します。自分のストーリー全件に存在しない結果不明の試験は、自動解除せず、別途の明示許可を得たローカル照合に限り `retryRelease: {verifiedAt, reason: "no_active_story", authorization: "explicit"}` を記録できます。元の `unknown` 状態・操作キーは維持し、同じ操作キーの再送は行いません。公開済み状態ではこの注記だけで重複防止を解除できません。
