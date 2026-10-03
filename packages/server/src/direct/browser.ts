import {
	dmInboxSchema,
	dmMessagesSchema,
	storyAccountSchema,
	type DmPageInput,
	type StoryAccount,
} from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { executeDmInBrowser } from "./browser-execute.js";
import { DmError } from "./errors.js";

export const createDmTransport = async (source: Page, signal: AbortSignal) => {
	const page = await source.context().newPage();
	const close = async () => {
		await page.close().catch(() => undefined);
	};
	const abort = () => {
		void close();
	};
	signal.addEventListener("abort", abort, { once: true });
	let allowSend = false;
	let sends = 0;
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
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === "GET") return route.continue();
			if (
				request.method() === "POST" &&
				url.origin === "https://www.instagram.com" &&
				url.pathname === "/api/v1/direct_v2/threads/broadcast/text/" &&
				allowSend &&
				sends === 0 &&
				!signal.aborted
			) {
				sends++;
				return route.continue();
			}
			return route.abort("blockedbyclient");
		});
	} catch {
		signal.removeEventListener("abort", abort);
		await close();
		throw new DmError("SESSION_NOT_READY", "DM用ブラウザの準備ができません");
	}
	const account = async () => {
		const result = storyAccountSchema.safeParse(await page.evaluate(executeDmInBrowser, { op: "account" as const }));
		if (!result.success) throw new DmError("SESSION_NOT_READY", "ログインアカウントを確認できません");
		return result.data;
	};
	return {
		account,
		inbox: async (input: DmPageInput) => {
			const result = dmInboxSchema.safeParse(
				await page.evaluate(executeDmInBrowser, { op: "inbox" as const, page: input }),
			);
			if (!result.success) throw new DmError("UPSTREAM_CHANGED", "DM一覧の取得結果を確認できません");
			return result.data;
		},
		messages: async (threadId: string, input: DmPageInput) => {
			const result = dmMessagesSchema.safeParse(
				await page.evaluate(executeDmInBrowser, { op: "thread" as const, threadId, page: input }),
			);
			if (!result.success) throw new DmError("UPSTREAM_CHANGED", "会話の取得結果を確認できません");
			return result.data;
		},
		send: async (threadId: string, text: string, clientContext: string, expected: StoryAccount) => {
			if (sends > 0 || signal.aborted) throw new DmError("DELIVERY_UNKNOWN", "DMを再送できません");
			allowSend = true;
			try {
				const result = await page.evaluate(executeDmInBrowser, {
					op: "send" as const,
					threadId,
					text,
					clientContext,
					account: expected,
				});
				if (typeof result !== "string" || !/^\d{1,80}$/.test(result) || sends !== 1)
					throw new DmError("DELIVERY_UNKNOWN", "送信結果を確認できません");
				return result;
			} finally {
				allowSend = false;
			}
		},
		close: async () => {
			signal.removeEventListener("abort", abort);
			await close();
		},
	};
};
export type DmTransport = Awaited<ReturnType<typeof createDmTransport>>;
