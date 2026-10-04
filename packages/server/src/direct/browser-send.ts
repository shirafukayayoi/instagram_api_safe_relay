import { dmMessagesSchema, type StoryAccount, storyAccountSchema } from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { executeDmInBrowser } from "./browser-execute.js";
import { DmError } from "./errors.js";

// Webの会話IDは公開APIのthreadIdとは異なる。認証値を外へ出さず照合する。
const resolveWebThread = async (input: { threadId: string; accountId: string }): Promise<string | null> => {
	try {
		const loader = (
			window as unknown as {
				require: (name: string) => {
					apiGet: (
						url: string,
						options: unknown,
					) => Promise<{
						statusCode?: number;
						data: { thread?: { thread_id?: string; thread_v2_id?: string; viewer_id?: string | number } };
					}>;
				};
			}
		).require;
		const response = await loader("PolarisInstapi").apiGet(`/api/v1/direct_v2/threads/${input.threadId}/`, {
			query: { limit: "1" },
		});
		const thread = response.data.thread;
		return response.statusCode === 200 &&
			thread?.thread_id === input.threadId &&
			String(thread.viewer_id) === input.accountId &&
			/^\d{1,80}$/.test(thread.thread_v2_id ?? "")
			? (thread.thread_v2_id ?? null)
			: null;
	} catch {
		return null;
	}
};

export const sendDmThroughUi = async (
	source: Page,
	signal: AbortSignal,
	threadId: string,
	text: string,
	account: StoryAccount,
): Promise<string> => {
	const page = await source.context().newPage();
	const abort = () => {
		void page.close().catch(() => undefined);
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) throw new DmError("SESSION_NOT_READY", "操作が中断されました");
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
		const current = storyAccountSchema.parse(
			await page.evaluate(executeDmInBrowser, { op: "account" as const, account }),
		);
		if (current.id !== account.id || current.username !== account.username)
			throw new DmError("ACCOUNT_CHANGED", "アカウントが変更されました");
		const baseline = dmMessagesSchema.parse(
			await page.evaluate(executeDmInBrowser, { op: "thread" as const, threadId, account, page: { limit: 50 } }),
		);
		if (!baseline.thread.canSendText || baseline.thread.users.length === 0)
			throw new DmError("UPSTREAM_CHANGED", "会話に送信できません");
		const webId = await page.evaluate(resolveWebThread, { threadId, accountId: account.id });
		if (!webId) throw new DmError("UPSTREAM_CHANGED", "Webの会話IDを確認できません");
		await page.goto(`https://www.instagram.com/direct/t/${webId}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
		const recipient = baseline.thread.users[0];
		if (!recipient || !/^[A-Za-z0-9._]+$/.test(recipient.username))
			throw new DmError("UPSTREAM_CHANGED", "宛先を確認できません");
		if (baseline.thread.isGroup) {
			await page.getByText(baseline.thread.title, { exact: true }).first().waitFor({ timeout: 20000 });
		} else {
			await page.locator(`a[href="/${recipient.username}/"]`).first().waitFor({ timeout: 20000 });
		}
		const editor = page.locator('[role="textbox"][contenteditable="true"][data-lexical-editor="true"]');
		await editor.waitFor({ timeout: 10000 });
		storyAccountSchema.parse(await page.evaluate(executeDmInBrowser, { op: "account" as const, account }));
		await editor.fill(text);
		if (signal.aborted) throw new DmError("DELIVERY_UNKNOWN", "操作が中断されました");
		// Enterを一度だけ押す。以後の確認失敗で再送しない。
		await editor.press("Enter");
		const ids = new Set(baseline.messages.map((message) => message.id));
		for (let attempt = 0; attempt < 10 && !signal.aborted; attempt++) {
			const result = dmMessagesSchema.safeParse(
				await page.evaluate(executeDmInBrowser, { op: "thread" as const, threadId, account, page: { limit: 10 } }),
			);
			if (result.success) {
				const proof = result.data.messages.find(
					(message) =>
						!ids.has(message.id) && message.senderId === account.id && message.type === "text" && message.text === text,
				);
				if (proof) return proof.id;
			}
			await page.waitForTimeout(1000);
		}
		throw new DmError("DELIVERY_UNKNOWN", "送信後のメッセージを確認できません");
	} finally {
		signal.removeEventListener("abort", abort);
		await page.close().catch(() => undefined);
	}
};
