import type { DmInbox, DmMessages, DmPageInput, StoryAccount } from "instagram-api-safe-contracts";

type User = { pk?: string | number; username?: string; full_name?: string };
type Item = {
	item_id?: string;
	user_id?: string | number;
	timestamp?: string | number;
	item_type?: string;
	text?: string;
};
type Thread = {
	is_xac_readonly?: boolean;
	e2ee_cutover_status?: number;
	pending?: boolean;
	thread_id?: string;
	viewer_id?: string | number;
	thread_title?: string;
	is_group?: boolean;
	users?: User[];
	items?: Item[];
	has_older?: boolean;
	oldest_cursor?: string;
};
type Data = {
	viewer?: User;
	inbox?: { threads?: Thread[]; has_older?: boolean; oldest_cursor?: string };
	thread?: Thread;
	payload?: { thread_id?: string; item_id?: string; client_context?: string };
	message_metadata?: { thread_id?: string; item_id?: string; client_context?: string }[];
};

// 認証値とraw responseはブラウザ内に留め、許可したフィールドだけを返す。
export const executeDmInBrowser = async (input: {
	op: "account" | "inbox" | "thread" | "send";
	page?: DmPageInput;
	threadId?: string;
	text?: string;
	clientContext?: string;
	account?: StoryAccount;
}): Promise<StoryAccount | DmInbox | DmMessages | string | null> => {
	try {
		if (
			location.origin !== "https://www.instagram.com" ||
			/\/accounts\/login|\/challenge|\/checkpoint/.test(location.pathname)
		)
			return null;
		const loader = (
			window as unknown as {
				require: (name: string) => {
					id?: string;
					data?: { username?: string };
					get?: (name: string) => string;
					apiGet: (
						url: string,
						options: { query: Record<string, string> },
					) => Promise<{ data: Data; statusCode?: number }>;
					apiPost: (
						url: string,
						options: { body: Record<string, string> },
					) => Promise<{ data: Data; statusCode?: number }>;
				};
			}
		).require;
		const identifier = (value: unknown): string => {
			if (typeof value === "string" && /^\d{1,80}$/.test(value)) return value;
			if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
			throw new Error("INVALID_ID");
		};
		const viewer = loader("PolarisViewer");
		const account = { id: identifier(viewer.id), username: viewer.data?.username ?? "" };
		if (!account.username || loader("Cookie").get?.("ds_user_id") !== account.id) return null;
		if (input.account && (input.account.id !== account.id || input.account.username !== account.username)) return null;
		if (input.op === "account") return account;
		const api = loader("PolarisInstapi");
		if (input.op === "send") {
			if (
				!input.threadId ||
				!/^\d{1,80}$/.test(input.threadId) ||
				!input.text?.trim() ||
				input.text.length > 1000 ||
				!input.clientContext
			)
				return null;
			// 固定のテキスト送信方式。Cookie等はPolarisInstapi自身が設定する。
			// https://github.com/dilame/instagram-private-api/blob/master/src/repositories/direct-thread.repository.ts
			const response = await api.apiPost("/api/v1/direct_v2/threads/broadcast/text/", {
				body: {
					action: "send_item",
					thread_ids: JSON.stringify([input.threadId]),
					text: input.text,
					client_context: input.clientContext,
					mutation_token: input.clientContext,
				},
			});
			const candidates = [response.data.payload, ...(response.data.message_metadata ?? [])];
			const proof = candidates.find(
				(entry) =>
					entry !== undefined &&
					entry.thread_id === input.threadId &&
					entry.client_context === input.clientContext &&
					typeof entry.item_id === "string" &&
					/^\d{1,80}$/.test(entry.item_id),
			);
			return response.statusCode === 200 && proof ? (proof.item_id ?? null) : null;
		}
		const page = input.page;
		if (!page || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 50) return null;
		const query: Record<string, string> = { limit: String(page.limit) };
		if (page.cursor) {
			query.cursor = page.cursor;
			query.direction = "older";
		}
		const thread = (raw: Thread) => ({
			canSendText: raw.is_xac_readonly === false && raw.e2ee_cutover_status === 0 && raw.pending === false,
			id: identifier(raw.thread_id),
			title: raw.thread_title ?? "",
			isGroup: Boolean(raw.is_group),
			users: (raw.users ?? []).map((user) => ({
				id: identifier(user.pk),
				username: user.username ?? "",
				displayName: user.full_name ?? "",
			})),
		});
		const next = (raw: { has_older?: boolean; oldest_cursor?: string }) => ({
			hasMore: raw.has_older === true,
			nextCursor: raw.has_older === true && typeof raw.oldest_cursor === "string" ? raw.oldest_cursor : null,
		});
		if (input.op === "inbox") {
			const response = await api.apiGet("/api/v1/direct_v2/inbox/", { query });
			if (
				response.statusCode !== 200 ||
				identifier(response.data.viewer?.pk) !== account.id ||
				!response.data.inbox?.threads
			)
				return null;
			return {
				account,
				threads: response.data.inbox.threads.slice(0, page.limit).map(thread),
				...next(response.data.inbox),
			};
		}
		if (!input.threadId || !/^\d{1,80}$/.test(input.threadId)) return null;
		const response = await api.apiGet(`/api/v1/direct_v2/threads/${input.threadId}/`, { query });
		const raw = response.data.thread;
		if (
			response.statusCode !== 200 ||
			!raw ||
			raw.thread_id !== input.threadId ||
			identifier(raw.viewer_id) !== account.id ||
			!raw.items
		)
			return null;
		return {
			account,
			thread: thread(raw),
			messages: raw.items.slice(0, page.limit).map((item) => ({
				id: identifier(item.item_id),
				senderId: identifier(item.user_id),
				timestamp: identifier(item.timestamp),
				type: item.item_type ?? "unknown",
				text: item.item_type === "text" && typeof item.text === "string" ? item.text : null,
			})),
			...next(raw),
		};
	} catch {
		return null;
	}
};
