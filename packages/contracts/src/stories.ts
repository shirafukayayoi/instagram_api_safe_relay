import { z } from "zod";

/** 元投稿の参照は投稿・プレビュー・台帳で固定する。 */
export const storyFeedPostReferenceSchema = z.strictObject({
	shortcode: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
	mediaId: z.string().regex(/^[1-9][0-9]{0,29}$/),
	ownerId: z.string().regex(/^[1-9][0-9]{0,29}$/),
});
export type StoryFeedPostReference = z.infer<typeof storyFeedPostReferenceSchema>;
export type StoryFeedPost = StoryFeedPostReference & {
	username: string;
	width: number;
	height: number;
	carouselCount: number;
	collaborators?: string[];
};

/** 書き込み契約は公開情報の4操作カタログとは分離する。 */
export const createStoryInputSchema = z.strictObject({
	filePath: z.string().min(1).max(4096),
	audience: z.enum(["all", "close_friends"]).default("all"),
	caption: z.string().max(2200).default(""),
	feedPost: storyFeedPostReferenceSchema.optional(),
});
export const storyJobStates = ["queued", "uploading", "publishing", "published", "failed", "unknown"] as const;
export const storyErrorCodes = [
	"STORIES_DISABLED",
	"AUDIENCE_UNSUPPORTED",
	"INVALID_INPUT",
	"UNKNOWN_PROFILE",
	"SESSION_NOT_READY",
	"MEDIA_NOT_ALLOWED",
	"MEDIA_INVALID",
	"MEDIA_TOO_LARGE",
	"MEDIA_PROBE_UNAVAILABLE",
	"IDEMPOTENCY_CONFLICT",
	"CATALOG_STALE",
	"ACCOUNT_CHANGED",
	"UPLOAD_FAILED",
	"PUBLICATION_UNKNOWN",
	"FEED_SHARE_UNAVAILABLE",
	"COMMENT_UNAVAILABLE",
	"COMMENT_UNKNOWN",
	"INTERRUPTED",
	"STORAGE_UNAVAILABLE",
	"NOT_FOUND",
	"CONFIRMATION_REQUIRED",
	"PREVIEW_EXPIRED",
	"PREVIEW_CHANGED",
] as const;
export const storyAccountSchema = z.strictObject({ id: z.string().regex(/^\d+$/), username: z.string().min(1) });
export const storyCommentInputSchema = z.strictObject({
	text: z.string().min(1).max(2200),
	mediaId: z
		.string()
		.regex(/^[1-9][0-9]{0,29}$/)
		.optional(),
});
export const storyJobSchema = z.strictObject({
	id: z.string().uuid(),
	profile: z.string().min(1),
	audience: z.enum(["all", "close_friends"]).default("all"),
	state: z.enum(storyJobStates),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	account: storyAccountSchema.nullable(),
	mediaId: z.string().nullable(),
	errorCode: z.enum(storyErrorCodes).nullable(),
	feedPost: storyFeedPostReferenceSchema.optional(),
	comment: z
		.strictObject({
			state: z.enum(["sending", "completed", "unknown"]),
			transport: z.literal("story_comment").optional(),
			requestHash: z.string().regex(/^[a-f0-9]{64}$/),
			creationKey: z.string().uuid(),
			commentId: z
				.string()
				.regex(/^[0-9]+$/)
				.nullable(),
			createdAt: z.string().datetime(),
			updatedAt: z.string().datetime(),
			// 旧経路の明確な拒否を手動照合した場合の記録。自動再送の許可には使わない。
			recovery: z
				.strictObject({
					previousTransport: z.literal("legacy_media"),
					previousState: z.literal("unknown"),
					previousUpdatedAt: z.string().datetime(),
					httpStatus: z.literal(400),
					errorKey: z.literal("comment_not_in_comment_audience"),
					verifiedAt: z.string().datetime(),
				})
				.optional(),
		})
		.optional(),
	recovery: z
		.strictObject({
			fromState: z.literal("unknown"),
			previousErrorCode: z.enum(storyErrorCodes).nullable(),
			verifiedAt: z.string().datetime(),
		})
		.optional(),
	removal: z
		.strictObject({ mediaId: z.string().regex(/^[1-9][0-9]{0,29}$/), verifiedAt: z.string().datetime() })
		.optional(),
	// 結果不明の台帳は保持し、全件照合と明示許可を得た試験だけ重複防止を解除する。
	retryRelease: z
		.strictObject({
			verifiedAt: z.string().datetime(),
			reason: z.literal("no_active_story"),
			authorization: z.literal("explicit"),
		})
		.optional(),
});
export type CreateStoryInput = z.infer<typeof createStoryInputSchema>;
export type StoryAccount = z.infer<typeof storyAccountSchema>;
export type StoryJob = z.infer<typeof storyJobSchema>;
export type StoryErrorCode = (typeof storyErrorCodes)[number];

/** プレビューは公開もInstagramへのアップロードも行わない。 */
export const confirmStoryInputSchema = z.strictObject({ confirmed: z.literal(true) });
export type StoryPreview = {
	id: string;
	profile: string;
	account: StoryAccount;
	audience: CreateStoryInput["audience"];
	expiresAt: string;
	feedPost?: StoryFeedPost;
	media: {
		mimeType: "image/jpeg" | "image/png" | "video/mp4";
		size: number;
		sha256: string;
		width: number;
		height: number;
		durationSeconds: number | null;
	};
};
export type StoryPreviewStatus = { preview: StoryPreview | null; job: StoryJob | null };
