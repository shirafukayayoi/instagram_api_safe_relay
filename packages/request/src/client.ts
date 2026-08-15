import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Page } from "playwright";
import type { OperationInput, OperationName, OperationResult } from "instagram-api-safe-contracts";
import { type CatalogStatus, parseExecuteInput, parseExecuteResult } from "./bridge.js";
import { InstagramBrowserError, isPageDisconnectError } from "./errors.js";
import {
	determineInstagramSessionState,
	type InstagramSessionProbe,
	type InstagramSessionStatus,
} from "./session.js";

const require = createRequire(import.meta.url);
const injectSetupScriptPath = require.resolve("instagram-api-safe-inject/setup.js");
export const DEFAULT_INSTAGRAM_URL = "https://www.instagram.com/";

export type InstagramApiProfileClient = {
	inject: () => Promise<void>;
	goto: (url?: string) => Promise<void>;
	waitStartup: (timeoutMs?: number) => Promise<void>;
	execute: <TName extends OperationName>(operation: TName, input: OperationInput<TName>) => Promise<OperationResult<TName>>;
	initHook: () => Promise<void>;
	getCatalogStatus: () => Promise<CatalogStatus>;
	getSessionStatus: () => Promise<InstagramSessionStatus>;
	page: Page;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, action: string): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new InstagramBrowserError("TIMEOUT", `${action} が時間内に完了しませんでした。`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const createInstagramBrowser = (page: Page): InstagramApiProfileClient => {
	const evaluate = async <T>(action: string, callback: () => Promise<T> | T): Promise<T> => {
		if (page.isClosed()) throw new InstagramBrowserError("BROWSER_DISCONNECTED", "ブラウザページはすでに閉じられています。");
		try {
			return await callback();
		} catch (error) {
			if (error instanceof InstagramBrowserError) throw error;
			if (isPageDisconnectError(error)) {
				throw new InstagramBrowserError("BROWSER_DISCONNECTED", "ブラウザページとの接続が切断されました。");
			}
			throw new InstagramBrowserError("BRIDGE_UNAVAILABLE", `${action} を実行できませんでした。`);
		}
	};

	const inject = async () => {
		const script = await readFile(injectSetupScriptPath, "utf8");
		await evaluate("inject", async () => {
			await page.addInitScript(script);
			await page.addScriptTag({ content: script });
		});
	};

	const waitStartup = async (timeoutMs = 15_000) =>
		await evaluate("waitStartup", async () =>
			await withTimeout(
				page.evaluate(async () => {
					if (!globalThis.instagramApiSafe) throw new Error("bridge unavailable");
					await globalThis.instagramApiSafe.waitStartup();
				}),
				timeoutMs,
				"Instagram の起動待機",
			),
		);

	const goto = async (url = DEFAULT_INSTAGRAM_URL) => {
		if (!/^https:\/\/(?:[a-z0-9-]+\.)*instagram\.com(?:\/|$)/i.test(url)) {
			throw new InstagramBrowserError("INVALID_INPUT", "Instagram 以外の URL には移動できません。");
		}
		await evaluate("goto", async () => {
			await page.goto(url);
		});
		await waitStartup();
	};

	const execute = async <TName extends OperationName>(operation: TName, input: OperationInput<TName>) => {
		const validatedInput = parseExecuteInput(operation, input);
		const result = await evaluate("execute", async () =>
			await page.evaluate(
				async ({ operationName, requestInput }) => {
					if (!globalThis.instagramApiSafe) throw new Error("bridge unavailable");
					// Playwright のシリアライズ型は相関ジェネリックを保持できない。
					return await globalThis.instagramApiSafe.execute({ operationName, input: requestInput } as never);
				},
				{ operationName: operation, requestInput: validatedInput },
			),
		);
		return parseExecuteResult(operation, result);
	};

	const initHook = async () =>
		await evaluate("initHook", async () =>
			await page.evaluate(() => {
				if (!globalThis.instagramApiSafe) throw new Error("bridge unavailable");
				// Playwright 越しに関数を渡すことはできないため、観測を明示的に解除する。
				globalThis.instagramApiSafe.setHook(null);
			}),
		);

	const getCatalogStatus = async (): Promise<CatalogStatus> =>
		await evaluate("getCatalogStatus", async () =>
			await page.evaluate(() => {
				if (!globalThis.instagramApiSafe) throw new Error("bridge unavailable");
				return globalThis.instagramApiSafe.getCatalogStatus();
			}),
		);

	const getSessionStatus = async (): Promise<InstagramSessionStatus> => {
		const probe = await evaluate("getSessionStatus", async () =>
			await page.evaluate((): InstagramSessionProbe => ({
				origin: globalThis.location.origin,
				pathname: globalThis.location.pathname,
				hasBridge: globalThis.instagramApiSafe !== undefined,
				hasTwoFactorInput:
					document.querySelector('input[name="verificationCode"], input[autocomplete="one-time-code"]') !== null,
				hasLoginFormOrInput:
					document.querySelector(
						'form[action*="/accounts/login"], input[name="username"], input[name="password"]',
					) !== null,
			})),
		);

		return { state: determineInstagramSessionState(probe), checkedAt: new Date().toISOString() };
	};

	return { inject, goto, waitStartup, execute, initHook, getCatalogStatus, getSessionStatus, page };
};
