import { z } from "zod";
import { storyAccountSchema } from "./stories.js";

const id = z.string().regex(/^\d{1,80}$/);
export const storyMentionSchema = z.strictObject({
	id: z.string().uuid(),
	profile: z.string().min(1),
	account: storyAccountSchema,
	threadId: id,
	messageId: id,
	senderId: id,
	senderUsername: z.string().min(1).max(100),
	mediaId: z
		.string()
		.regex(/^\d{1,80}(?:_\d{1,80})?$/)
		.nullable(),
	receivedAt: id,
	updatedAt: z.string().datetime(),
	status: z.enum(["available", "expired", "removed", "unavailable", "unknown"]),
	reason: z.enum(["REPOST_ALLOWED", "EXPIRED", "REMOVED", "REPOST_NOT_ALLOWED", "UNVERIFIED"]),
});
export const storyMentionJobSchema = z
	.strictObject({
		id: z.string().uuid(),
		profile: z.string().min(1),
		kind: z.enum(["refresh", "repost"]),
		mentionId: z.string().uuid().nullable(),
		account: storyAccountSchema.nullable(),
		state: z.enum(["queued", "validating", "publishing", "published", "completed", "failed", "unknown"]),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		mediaId: id.nullable(),
		count: z.number().int().nonnegative(),
		errorCode: z.string().max(100).nullable(),
	})
	.superRefine((job, context) => {
		const allowed =
			job.kind === "refresh"
				? ["queued", "validating", "completed", "failed"]
				: ["queued", "validating", "publishing", "published", "failed", "unknown"];
		if (!allowed.includes(job.state) || (job.kind === "refresh" ? job.mentionId !== null : job.mentionId === null))
			context.addIssue({ code: "custom", message: "ジョブ種別と状態が一致しません" });
		if (job.state === "published" && (!job.account || !job.mediaId))
			context.addIssue({ code: "custom", message: "公開済みの根拠がありません" });
	});
export type StoryMention = z.infer<typeof storyMentionSchema>;
export type StoryMentionJob = z.infer<typeof storyMentionJobSchema>;
