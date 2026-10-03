import { z } from "zod";
import { storyAccountSchema } from "./stories.js";

const id = z.string().regex(/^\d{1,80}$/);
export const dmPageInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(20),
	cursor: z.string().min(1).max(2048).optional(),
});
export const dmSendInputSchema = z.strictObject({
	threadId: id,
	text: z
		.string()
		.min(1)
		.max(1000)
		.refine((text) => text.trim().length > 0),
});
export const dmUserSchema = z.strictObject({
	id,
	username: z.string().min(1).max(100),
	displayName: z.string().max(300),
});
export const dmThreadSchema = z.strictObject({
	canSendText: z.boolean(),
	id,
	title: z.string().max(1000),
	isGroup: z.boolean(),
	users: z.array(dmUserSchema).max(250),
});
export const dmMessageSchema = z.strictObject({
	id,
	senderId: id,
	timestamp: id,
	type: z.string().max(100),
	text: z.string().max(10000).nullable(),
});
export const dmInboxSchema = z.strictObject({
	account: storyAccountSchema,
	threads: z.array(dmThreadSchema).max(50),
	nextCursor: z.string().max(2048).nullable(),
	hasMore: z.boolean(),
});
export const dmMessagesSchema = z.strictObject({
	account: storyAccountSchema,
	thread: dmThreadSchema,
	messages: z.array(dmMessageSchema).max(50),
	nextCursor: z.string().max(2048).nullable(),
	hasMore: z.boolean(),
});
export const dmErrorCodes = [
	"DM_DISABLED",
	"INVALID_INPUT",
	"UNKNOWN_PROFILE",
	"SESSION_NOT_READY",
	"ACCOUNT_CHANGED",
	"UPSTREAM_CHANGED",
	"IDEMPOTENCY_CONFLICT",
	"DELIVERY_UNKNOWN",
	"INTERRUPTED",
	"STORAGE_UNAVAILABLE",
	"NOT_FOUND",
] as const;
export const dmJobSchema = z.strictObject({
	id: z.string().uuid(),
	profile: z.string().min(1),
	threadId: id,
	state: z.enum(["queued", "validating", "sending", "sent", "failed", "unknown"]),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	account: storyAccountSchema.nullable(),
	messageId: id.nullable(),
	errorCode: z.enum(dmErrorCodes).nullable(),
});
export type DmJob = z.infer<typeof dmJobSchema>;
export type DmErrorCode = (typeof dmErrorCodes)[number];
export type DmInbox = z.infer<typeof dmInboxSchema>;
export type DmMessages = z.infer<typeof dmMessagesSchema>;
export type DmPageInput = z.infer<typeof dmPageInputSchema>;
