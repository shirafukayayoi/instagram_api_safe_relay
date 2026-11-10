import type { Highlight, StoryAccount } from "instagram-api-safe-contracts";
import { storyAccountSchema } from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { StoryError } from "../stories/errors.js";

export type HighlightBrowser = {
	list: () => Promise<{ account: StoryAccount; highlights: Highlight[] }>;
	contents: (highlight: Highlight) => Promise<string[]>;
	add: (
		highlight: Highlight,
		mediaId: string,
		account: StoryAccount,
		beforeSave: () => Promise<void>,
	) => Promise<boolean>;
	close: () => Promise<void>;
};

// 2026-10-08にWebの「編集→選択済み/ストーリーズ→カバー→完了」を確認。
// 通信のraw proxyや認証値の持ち出しを追加せず、同じ画面操作だけを行う。
export const createHighlightBrowser = async (source: Page, signal: AbortSignal): Promise<HighlightBrowser> => {
	const page = await source.context().newPage();
	page.setDefaultTimeout(20_000);
	await page.setViewportSize({ width: 1280, height: 900 });
	const close = async () => {
		await page.close().catch(() => undefined);
	};
	const abort = () => {
		void close();
	};
	signal.addEventListener("abort", abort, { once: true });
	const account = async (): Promise<StoryAccount> => {
		if (signal.aborted) throw new StoryError("INTERRUPTED", "ハイライト操作を中断しました");
		const value = await page.evaluate(() => {
			if (
				location.origin !== "https://www.instagram.com" ||
				/\/accounts\/login|\/challenge|\/checkpoint/.test(location.pathname)
			)
				return null;
			try {
				const loader = (
					window as unknown as {
						require: (name: string) => { id?: string; data?: { username?: string }; get?: (name: string) => string };
					}
				).require;
				const viewer = loader("PolarisViewer");
				if (String(viewer.id) !== loader("Cookie").get?.("ds_user_id")) return null;
				return { id: String(viewer.id ?? ""), username: viewer.data?.username ?? "" };
			} catch {
				return null;
			}
		});
		const parsed = storyAccountSchema.safeParse(value);
		if (!parsed.success || parsed.data.id === "0" || !/^[A-Za-z0-9._]{1,30}$/.test(parsed.data.username))
			throw new StoryError("SESSION_NOT_READY", "ログインアカウントを確認できません");
		return parsed.data;
	};
	const checkAccount = async (expected: StoryAccount) => {
		const current = await account();
		if (current.id !== expected.id || current.username !== expected.username)
			throw new StoryError("ACCOUNT_CHANGED", "ストーリーの投稿先アカウントと一致しません");
	};
	const button = (name: RegExp) => page.getByRole("button", { name });
	const selectedTab = () => page.getByRole("tab", { name: /^選択済み|^Selected/ });
	const storyTab = () => page.getByRole("tab", { name: /^ストーリーズ|^Stories/ });
	const next = () => button(/^(次へ|Next)$/);
	const openEditor = async (highlight: Highlight) => {
		await page.goto(`https://www.instagram.com/stories/highlights/${highlight.id}/`, { waitUntil: "domcontentloaded" });
		await button(/^(メニュー|Menu|More)$/).click();
		await button(/^(編集|Edit)$/).click();
		const title = page.getByRole("textbox");
		if ((await title.inputValue()) !== highlight.title)
			throw new StoryError("PREVIEW_CHANGED", "ハイライトの名前が変更されています");
		await next().click();
		await selectedTab().click();
	};
	// サムネイルのDOMにあるig_cache_keyはメディアIDのbase64。署名付きURLを返さない。
	const selectedIds = async () => {
		await page.locator('[role="button"] [style*="background-image"]').first().waitFor();
		const keys = await page.locator('[role="button"] [style*="background-image"]').evaluateAll((elements) =>
			elements.map((element) => {
				const match = (element.getAttribute("style") ?? "").match(/url\("?(.*?)"?\)/);
				if (!match?.[1]) return null;
				try {
					return new URL(match[1].replace(/"$/, "")).searchParams.get("ig_cache_key")?.split(".")[0] ?? null;
				} catch {
					return null;
				}
			}),
		);
		const ids = keys
			.filter((key): key is string => key !== null)
			.map((key) => Buffer.from(key, "base64").toString("utf8"));
		if (ids.length !== keys.length || ids.some((id) => !/^\d+$/.test(id)))
			throw new StoryError("CATALOG_STALE", "ストーリーのIDを画面で照合できません");
		return ids;
	};
	const list = async () => {
		await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => {
			try {
				return Boolean((window as unknown as { require: (name: string) => unknown }).require("PolarisViewer"));
			} catch {
				return false;
			}
		});
		const current = await account();
		await page.goto(`https://www.instagram.com/${current.username}/`, { waitUntil: "domcontentloaded" });
		await page.locator('a[href^="/stories/highlights/"]').first().waitFor();
		await checkAccount(current);
		const highlights = await page.locator('a[href^="/stories/highlights/"]').evaluateAll((links) =>
			links.flatMap((link) => {
				const id = link.getAttribute("href")?.match(/^\/stories\/highlights\/(\d+)\/$/)?.[1];
				const title = (link.textContent ?? "").trim();
				return id && title ? [{ id, title }] : [];
			}),
		);
		return { account: current, highlights };
	};
	// 編集画面を開くが保存しない読み取り。unknown・failedの有無確認だけに使う。
	const contents = async (highlight: Highlight): Promise<string[]> => {
		await openEditor(highlight);
		return await selectedIds();
	};
	try {
		return {
			list,
			contents,
			add: async (highlight, mediaId, expected, beforeSave) => {
				const own = await list();
				await checkAccount(expected);
				if (!own.highlights.some((item) => item.id === highlight.id && item.title === highlight.title))
					throw new StoryError("NOT_FOUND", "自分のハイライトが見つかりません");
				await openEditor(highlight);
				const initial = await selectedIds();
				if (initial.includes(mediaId)) return true;
				await storyTab().click();
				const key = encodeURIComponent(Buffer.from(mediaId).toString("base64"));
				const target = page.locator('[role="button"]').filter({ has: page.locator(`[style*="ig_cache_key=${key}."]`) });
				// 新しい投稿を対象とする。見つからなければ推測で別のサムネイルを選ばない。
				await target.waitFor({ state: "visible" });
				if ((await target.count()) !== 1) throw new StoryError("CATALOG_STALE", "対象ストーリーを一意に識別できません");
				await target.click();
				await selectedTab().click();
				const selected = await selectedIds();
				if (
					!selected.includes(mediaId) ||
					selected.length !== initial.length + 1 ||
					!initial.every((id) => selected.includes(id))
				)
					throw new StoryError("PREVIEW_CHANGED", "対象以外の選択が変更されています");
				await next().click();
				// タイトル・既存のカバー写真は編集しない。
				const done = button(/^(完了|Done)$/);
				await done.waitFor({ state: "visible" });
				await checkAccount(expected);
				await beforeSave();
				await done.click();
				await done.waitFor({ state: "hidden" });
				await openEditor(highlight);
				const verified = await selectedIds();
				if (!verified.includes(mediaId) || !initial.every((id) => verified.includes(id)))
					throw new StoryError("PUBLICATION_UNKNOWN", "保存後のハイライトを確認できません");
				await checkAccount(expected);
				return false;
			},
			close: async () => {
				signal.removeEventListener("abort", abort);
				await close();
			},
		};
	} catch (error) {
		signal.removeEventListener("abort", abort);
		await close();
		throw error;
	}
};
