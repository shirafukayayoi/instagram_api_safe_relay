import { z } from "zod";

/** リレーが提供する、公開情報のみを扱う操作名。 */
export const operationNames = [
	"getPublicProfile",
	"listPublicProfileMedia",
	"getPublicMedia",
	"listPublicMediaComments",
] as const;

export type OperationName = (typeof operationNames)[number];

const usernameSchema = z
	.string()
	.trim()
	.min(1)
	.max(30)
	.regex(/^[A-Za-z0-9._]+$/, "username は Instagram のユーザー名形式で指定してください");

const shortcodeSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, "shortcode は URL セグメントとして有効な形式で指定してください");

const cursorSchema = z.string().trim().min(1).max(512);
const limitSchema = z.number().int().min(1).max(50);
const mediaKindSchema = z.enum(["all", "post", "reel"]);

export const getPublicProfileInputSchema = z.strictObject({
	username: usernameSchema,
});

export const listPublicProfileMediaInputSchema = z.strictObject({
	username: usernameSchema,
	cursor: cursorSchema.optional(),
	limit: limitSchema.optional(),
	kind: mediaKindSchema.optional(),
});

export const getPublicMediaInputSchema = z.strictObject({
	shortcode: shortcodeSchema,
});

export const listPublicMediaCommentsInputSchema = z.strictObject({
	shortcode: shortcodeSchema,
	cursor: cursorSchema.optional(),
	limit: limitSchema.optional(),
});

/** 操作名と入力スキーマの対応。すべて strict object である。 */
export const operationInputSchemas = {
	getPublicProfile: getPublicProfileInputSchema,
	listPublicProfileMedia: listPublicProfileMediaInputSchema,
	getPublicMedia: getPublicMediaInputSchema,
	listPublicMediaComments: listPublicMediaCommentsInputSchema,
} as const;

/** 他パッケージが参照する正式な入力スキーマ export。 */
export const OperationInputSchemas = operationInputSchemas;

export type OperationInputMap = {
	getPublicProfile: z.infer<typeof getPublicProfileInputSchema>;
	listPublicProfileMedia: z.infer<typeof listPublicProfileMediaInputSchema>;
	getPublicMedia: z.infer<typeof getPublicMediaInputSchema>;
	listPublicMediaComments: z.infer<typeof listPublicMediaCommentsInputSchema>;
};

export type OperationInput<TName extends OperationName> = OperationInputMap[TName];

/** 外部 URL が存在しない場合もキーを省略せず null で表現する。 */
const nullableUrlSchema = z.string().url().nullable();
const nullableTextSchema = z.string().nullable();
const nonNegativeIntegerSchema = z.number().int().nonnegative().nullable();

export const publicProfileSchema = z.strictObject({
	id: z.string().min(1),
	username: usernameSchema,
	fullName: nullableTextSchema,
	biography: nullableTextSchema,
	avatarUrl: nullableUrlSchema,
	isVerified: z.boolean(),
	followerCount: nonNegativeIntegerSchema,
	followingCount: nonNegativeIntegerSchema,
	mediaCount: nonNegativeIntegerSchema,
});

export type PublicProfile = z.infer<typeof publicProfileSchema>;

export const publicMediaSchema = z.strictObject({
	id: z.string().min(1),
	shortcode: shortcodeSchema,
	kind: z.enum(["post", "reel"]),
	caption: nullableTextSchema,
	permalink: z.string().url(),
	displayUrl: nullableUrlSchema,
	thumbnailUrl: nullableUrlSchema,
	videoUrl: nullableUrlSchema,
	takenAt: z.string().datetime().nullable(),
	likeCount: nonNegativeIntegerSchema,
	commentCount: nonNegativeIntegerSchema,
	owner: z.strictObject({
		id: z.string().min(1),
		username: usernameSchema,
	}),
});

export type PublicMedia = z.infer<typeof publicMediaSchema>;

export const publicCommentSchema = z.strictObject({
	id: z.string().min(1),
	text: z.string(),
	createdAt: z.string().datetime().nullable(),
	likeCount: nonNegativeIntegerSchema,
	author: z.strictObject({
		id: z.string().min(1),
		username: usernameSchema,
		fullName: nullableTextSchema,
		avatarUrl: nullableUrlSchema,
	}),
});

export type PublicComment = z.infer<typeof publicCommentSchema>;

/** カーソルベースの安定した一覧レスポンス。 */
export type Page<T> = {
	items: T[];
	nextCursor: string | null;
};

export const createPageSchema = <TItem extends z.ZodTypeAny>(itemSchema: TItem) =>
	z.strictObject({
		items: z.array(itemSchema),
		nextCursor: z.string().min(1).nullable(),
	});

export const publicMediaPageSchema = createPageSchema(publicMediaSchema);
export const publicCommentPageSchema = createPageSchema(publicCommentSchema);

export type PublicMediaPage = Page<PublicMedia>;
export type PublicCommentPage = Page<PublicComment>;

export type OperationResultMap = {
	getPublicProfile: PublicProfile;
	listPublicProfileMedia: PublicMediaPage;
	getPublicMedia: PublicMedia;
	listPublicMediaComments: PublicCommentPage;
};

export type OperationResult<TName extends OperationName> = OperationResultMap[TName];

export const operationResultSchemas = {
	getPublicProfile: publicProfileSchema,
	listPublicProfileMedia: publicMediaPageSchema,
	getPublicMedia: publicMediaSchema,
	listPublicMediaComments: publicCommentPageSchema,
} as const;

export const relayErrorCodeSchema = z.enum([
	"AUTH_REQUIRED",
	"SESSION_NOT_READY",
	"CATALOG_STALE",
	"UPSTREAM_CHANGED",
	"RATE_LIMITED",
	"NOT_PUBLIC",
	"NOT_FOUND",
	"BROWSER_DISCONNECTED",
	"INVALID_INPUT",
	"UNKNOWN_PROFILE",
]);

export type RelayErrorCode = z.infer<typeof relayErrorCodeSchema>;

/** HTTP API の安定したエラーコード名。 */
export type ApiErrorCode = RelayErrorCode;

export const relayErrorSchema = z.strictObject({
	code: relayErrorCodeSchema,
	message: z.string().min(1),
	retryAfterSeconds: z.number().int().positive().nullable(),
});

export type RelayError = z.infer<typeof relayErrorSchema>;

export type OperationOutcome<TName extends OperationName> =
	| { ok: true; data: OperationResult<TName> }
	| { ok: false; error: RelayError };

/**
 * プライベート判定を DTO 変換の前に完了させるための判定型。
 * vendor の生レスポンスをここへ持ち込まず、内部実装だけが T を保持する。
 */
export type PublicAccess<T> =
	| { visibility: "public"; value: T }
	| { visibility: "private" };

export type VerifiedPublic<T> = Extract<PublicAccess<T>, { visibility: "public" }>;

export const isVerifiedPublic = <T>(access: PublicAccess<T>): access is VerifiedPublic<T> =>
	access.visibility === "public";

/** 公開済みの値だけを DTO 変換関数に渡す。private では変換関数は実行されない。 */
export const mapVerifiedPublic = <TSource, TResult>(
	access: PublicAccess<TSource>,
	toDto: (source: TSource) => TResult,
): TResult => {
	if (!isVerifiedPublic(access)) {
		throw new PublicAccessError();
	}

	return toDto(access.value);
};

export class PublicAccessError extends Error {
	readonly code = "NOT_PUBLIC" as const;

	constructor(message = "対象は公開されていません") {
		super(message);
		this.name = "PublicAccessError";
	}
}

export const httpMethodByOperation: Record<OperationName, "GET"> = {
	getPublicProfile: "GET",
	listPublicProfileMedia: "GET",
	getPublicMedia: "GET",
	listPublicMediaComments: "GET",
};

/** 入力を URL パスへ安全に埋め込む。クエリ（cursor, limit, kind）は含めない。 */
export const getOperationHttpPath = <TName extends OperationName>(
	operation: TName,
	input: OperationInput<TName>,
): string => {
	switch (operation) {
		case "getPublicProfile":
			return `/v1/profiles/${encodeURIComponent((input as OperationInputMap["getPublicProfile"]).username)}`;
		case "listPublicProfileMedia":
			return `/v1/profiles/${encodeURIComponent((input as OperationInputMap["listPublicProfileMedia"]).username)}/media`;
		case "getPublicMedia":
			return `/v1/media/${encodeURIComponent((input as OperationInputMap["getPublicMedia"]).shortcode)}`;
		case "listPublicMediaComments":
			return `/v1/media/${encodeURIComponent((input as OperationInputMap["listPublicMediaComments"]).shortcode)}/comments`;
	}
};

/** HTTP 受信時に unknown を、操作に対応する厳密な入力へ変換する。 */
export const parseOperationInput = <TName extends OperationName>(
	operation: TName,
	input: unknown,
): OperationInput<TName> => operationInputSchemas[operation].parse(input) as OperationInput<TName>;
