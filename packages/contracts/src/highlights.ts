import { z } from "zod";
import { storyAccountSchema } from "./stories.js";

// 公開情報の読み取りカタログとは分離した、自分のハイライトへの追加契約。
export const highlightSchema = z.strictObject({
	id: z.string().regex(/^\d+$/),
	title: z.string().min(1).max(100),
});
export const addHighlightStorySchema = z.strictObject({ storyJobId: z.string().uuid() });
export const highlightTraySchema = z.strictObject({
	account: storyAccountSchema,
	highlight: highlightSchema,
	mediaIds: z.array(z.string().regex(/^\d+$/)),
});
export const highlightJobSchema = z.strictObject({
	id: z.string().uuid(),
	profile: z.string().min(1),
	highlight: highlightSchema,
	storyJobId: z.string().uuid(),
	mediaId: z.string().regex(/^\d+$/),
	account: storyAccountSchema,
	audience: z.enum(["all", "close_friends"]),
	state: z.enum(["queued", "applying", "completed", "failed", "unknown"]),
	alreadyPresent: z.boolean().nullable(),
	errorCode: z.string().nullable(),
	retryOf: z.string().uuid().nullable().default(null),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
});
export type Highlight = z.infer<typeof highlightSchema>;
export type HighlightJob = z.infer<typeof highlightJobSchema>;
export type HighlightTray = z.infer<typeof highlightTraySchema>;
