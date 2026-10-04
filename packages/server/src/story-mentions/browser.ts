import { type StoryAccount, type StoryMention, storyAccountSchema } from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { executeDmInBrowser } from "../direct/browser-execute.js";
import { MentionError } from "./store.js";

type Item = {
	item_id?: string;
	user_id?: string | number;
	timestamp?: string | number;
	reel_share?: {
		type?: string;
		mentioned_user_id?: string | number;
		can_repost?: boolean;
		media?: { id?: string; expiring_at?: number; user?: { pk?: string | number; username?: string } };
	};
};
type Thread = {
	thread_id?: string;
	viewer_id?: string | number;
	users?: { pk?: string | number; username?: string }[];
	items?: Item[];
	has_older?: boolean;
	oldest_cursor?: string;
};
type Result = {
	statusCode?: number;
	data: {
		pending_requests_total?: number;
		viewer?: { pk?: string | number };
		inbox?: { threads?: Thread[]; has_older?: boolean; oldest_cursor?: string };
		thread?: Thread;
	};
};
export type MentionCandidate = Omit<StoryMention, "id" | "profile" | "updatedAt">;
// 固定の読み取りのみ。署名付きURL・DM本文・認証値は返さない。
export const readMentionsInBrowser = async (input: {
	account: StoryAccount;
	threadId?: string;
	cursor?: string;
	pending?: boolean;
}) => {
	try {
		const loader = (
			window as unknown as {
				require: (name: string) => {
					id?: string;
					data?: { username?: string };
					get?: (key: string) => string;
					apiGet: (url: string, options: { query: Record<string, string> }) => Promise<Result>;
				};
			}
		).require;
		const viewer = loader("PolarisViewer");
		if (
			String(viewer.id) !== input.account.id ||
			viewer.data?.username !== input.account.username ||
			loader("Cookie").get?.("ds_user_id") !== input.account.id
		)
			return null;
		if (input.threadId && !/^\d{1,80}$/.test(input.threadId)) return null;
		const query: Record<string, string> = { limit: "50" };
		if (input.cursor) {
			query.cursor = input.cursor;
			query.direction = "older";
		}
		const response = await loader("PolarisInstapi").apiGet(
			input.threadId ? `/api/v1/direct_v2/threads/${input.threadId}/` : "/api/v1/direct_v2/inbox/",
			{ query },
		);
		if (response.statusCode !== 200) return null;
		if (input.pending && !input.threadId) {
			if (String(response.data.viewer?.pk) !== input.account.id) return null;
			// 現在のWebは旧pending_inboxを404にする。0件の確認以外は成功扱いしない。
			return {
				threads: [] as string[],
				mentions: [] as MentionCandidate[],
				cursor: null,
				pendingUnavailable: response.data.pending_requests_total !== 0,
			};
		}
		if (!input.threadId) {
			const inbox = response.data.inbox;
			if (!inbox?.threads || String(response.data.viewer?.pk) !== input.account.id) return null;
			const threads = inbox.threads.map((thread) => thread.thread_id);
			if (threads.some((id) => !id || !/^\d{1,80}$/.test(id))) return null;
			if (inbox.has_older && !inbox.oldest_cursor) return null;
			return {
				threads: threads as string[],
				mentions: [] as MentionCandidate[],
				cursor: inbox.has_older ? (inbox.oldest_cursor ?? null) : null,
			};
		}
		const thread = response.data.thread;
		if (!thread?.items || thread.thread_id !== input.threadId || String(thread.viewer_id) !== input.account.id)
			return null;
		const mentions: MentionCandidate[] = [];
		for (const item of thread.items) {
			const share = item.reel_share;
			if (share?.type !== "mention" || String(share.mentioned_user_id) !== input.account.id) continue;
			const sender = thread.users?.find((user) => String(user.pk) === String(item.user_id));
			if (
				!sender?.username ||
				!item.item_id ||
				!/^\d{1,80}$/.test(item.item_id) ||
				!/^\d{1,80}$/.test(String(item.user_id)) ||
				!/^\d{1,80}$/.test(String(item.timestamp))
			)
				return null;
			const mediaId = share.media?.id && /^\d{1,80}(?:_\d{1,80})?$/.test(share.media.id) ? share.media.id : null;
			const expires = share.media?.expiring_at;
			const expired = typeof expires === "number" && expires <= Date.now() / 1000;
			const status = expired
				? "expired"
				: !share.media
					? "removed"
					: share.can_repost === true && mediaId
						? "available"
						: share.can_repost === false
							? "unavailable"
							: "unknown";
			mentions.push({
				account: input.account,
				threadId: input.threadId,
				messageId: item.item_id,
				senderId: String(item.user_id),
				senderUsername: sender.username,
				mediaId,
				receivedAt: String(item.timestamp),
				status,
				reason:
					status === "available"
						? "REPOST_ALLOWED"
						: status === "expired"
							? "EXPIRED"
							: status === "removed"
								? "REMOVED"
								: status === "unavailable"
									? "REPOST_NOT_ALLOWED"
									: "UNVERIFIED",
			});
		}
		if (thread.has_older && !thread.oldest_cursor) return null;
		return { threads: [] as string[], mentions, cursor: thread.has_older ? (thread.oldest_cursor ?? null) : null };
	} catch {
		return null;
	}
};

export const createMentionTransport = async (source: Page, signal: AbortSignal) => {
	const page = await source.context().newPage();
	const close = async () => {
		await page.close().catch(() => undefined);
	};
	const abort = () => {
		void close();
	};
	let loginRequired = false;
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (
			url.origin === "https://www.instagram.com" &&
			/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/.test(url.pathname)
		)
			loginRequired = true;
	});
	const assertSession = () => {
		if (loginRequired) throw new MentionError("SESSION_NOT_READY", "メンション通信で再ログインが要求されました");
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) throw new Error("ABORTED");
		await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForFunction(
			() => {
				try {
					return Boolean((window as unknown as { require: (name: string) => unknown }).require("PolarisInstapi"));
				} catch {
					return false;
				}
			},
			undefined,
			{ timeout: 20000 },
		);
		await page.route("**/*", (route) =>
			route.request().method() === "GET" ? route.continue() : route.abort("blockedbyclient"),
		);
	} catch {
		signal.removeEventListener("abort", abort);
		await close();
		throw new MentionError("SESSION_NOT_READY", "メンション用ブラウザを準備できません");
	}
	return {
		account: async () => {
			assertSession();
			const parsed = storyAccountSchema.safeParse(await page.evaluate(executeDmInBrowser, { op: "account" as const }));
			if (!parsed.success) throw new MentionError("SESSION_NOT_READY", "ログインアカウントを確認できません");
			return parsed.data;
		},
		read: async (input: Parameters<typeof readMentionsInBrowser>[0]) => {
			const result = await page.evaluate(readMentionsInBrowser, input);
			assertSession();
			if (!result) throw new MentionError("UPSTREAM_CHANGED", "メンションの取得結果を確認できません");
			if ("pendingUnavailable" in result && result.pendingUnavailable)
				throw new MentionError(
					"PENDING_INBOX_UNAVAILABLE",
					"メッセージリクエストの読み取り方式は未検証です。全件取得できないため更新を停止しました",
				);
			return result;
		},
		nativeAvailable: async () => false,
		publish: async (_mention: StoryMention): Promise<string> => {
			throw new MentionError("NATIVE_REPOST_UNAVAILABLE", "ネイティブ再投稿の公開方式は未検証です");
		},
		close: async () => {
			signal.removeEventListener("abort", abort);
			await close();
		},
	};
};
export type MentionTransport = Awaited<ReturnType<typeof createMentionTransport>>;
