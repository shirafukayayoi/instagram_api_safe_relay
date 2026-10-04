import {
	type DmPageInput,
	dmInboxSchema,
	dmMessagesSchema,
	type StoryAccount,
	storyAccountSchema,
} from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { executeDmInBrowser } from "./browser-execute.js";
import { sendDmThroughUi } from "./browser-send.js";
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
	let sends = 0;
	let loginRedirect = false;
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (url.origin === "https://www.instagram.com" && /^\/accounts\/login(?:\/|$)/.test(url.pathname))
			loginRedirect = true;
	});
	const assertSession = () => {
		if (loginRedirect) throw new DmError("SESSION_NOT_READY", "DM通信で再ログインが要求されました");
	};
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
			if (request.method() === "GET") return route.continue();
			return route.abort("blockedbyclient");
		});
	} catch {
		signal.removeEventListener("abort", abort);
		await close();
		throw new DmError("SESSION_NOT_READY", "DM用ブラウザの準備ができません");
	}
	const account = async () => {
		assertSession();
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
			assertSession();
			if (!result.success) throw new DmError("UPSTREAM_CHANGED", "DM一覧の取得結果を確認できません");
			return result.data;
		},
		messages: async (threadId: string, input: DmPageInput) => {
			const result = dmMessagesSchema.safeParse(
				await page.evaluate(executeDmInBrowser, { op: "thread" as const, threadId, page: input }),
			);
			assertSession();
			if (!result.success) throw new DmError("UPSTREAM_CHANGED", "会話の取得結果を確認できません");
			return result.data;
		},
		send: async (threadId: string, text: string, clientContext: string, expected: StoryAccount) => {
			if (sends > 0 || signal.aborted) throw new DmError("DELIVERY_UNKNOWN", "DMを再送できません");

			sends++;
			if (!clientContext) throw new DmError("DELIVERY_UNKNOWN", "送信操作IDがありません");
			const result = await sendDmThroughUi(source, signal, threadId, text, expected);
			if (typeof result !== "string" || !/^\d{1,80}$/.test(result))
				throw new DmError("DELIVERY_UNKNOWN", "送信結果を確認できません");
			return result;
		},
		close: async () => {
			signal.removeEventListener("abort", abort);
			await close();
		},
	};
};
export type DmTransport = Awaited<ReturnType<typeof createDmTransport>>;
