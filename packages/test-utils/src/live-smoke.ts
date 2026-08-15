import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInstagramBrowser } from "../../request/src/index.ts";
import type { SmokeBrowserType, SmokeConfig } from "./config.ts";

type PersistentContext = {
	newPage(): Promise<Parameters<typeof createInstagramBrowser>[0]>;
	close(): Promise<void>;
};

type BrowserLauncher = {
	launchPersistentContext(profileDir: string, options: SmokeConfig["launchOptions"]): Promise<PersistentContext>;
};

type PlaywrightModule = Record<SmokeBrowserType, BrowserLauncher>;

export type SmokeOperation =
	| "getPublicProfile"
	| "listPublicProfileMedia"
	| "getPublicMedia"
	| "listPublicMediaComments";

export type SmokeSuccess = Readonly<{
	operation: SmokeOperation;
	count: number;
	durationMs: number;
}>;

export class SmokeSkipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SmokeSkipError";
	}
}

export class ProfileInUseError extends Error {
	constructor() {
		super("persistent profile は別のブラウザで使用中です。既存ブラウザを終了してから再実行してください。");
		this.name = "ProfileInUseError";
	}
}

const requestRequire = createRequire(new URL("../../request/package.json", import.meta.url));

const loadPlaywright = async (): Promise<PlaywrightModule> => {
	const modulePath = requestRequire.resolve("playwright");
	const imported = await import(pathToFileURL(modulePath).href);
	// PlaywrightのCommonJSエントリはESMからの動的importではdefault配下になる。
	return ("chromium" in imported ? imported : imported.default) as PlaywrightModule;
};

export const isProfileLockError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return /processsingleton|profile.*(?:in use|already in use)|user data directory is already in use|opening in existing browser session|parent\.lock/i.test(
		message,
	);
};

const assertNoKnownProfileLock = async (profileDir: string, browserType: SmokeBrowserType): Promise<void> => {
	const names =
		browserType === "firefox"
			? ["parent.lock", ".parentlock"]
			: ["SingletonLock", "SingletonCookie", "SingletonSocket"];
	for (const name of names) {
		try {
			await access(path.join(profileDir, name));
			throw new ProfileInUseError();
		} catch (error) {
			if (error instanceof ProfileInUseError) throw error;
		}
	}
};

const runMeasured = async <T>(
	operation: SmokeOperation,
	fn: () => Promise<T>,
	count: (value: T) => number,
	report: (success: SmokeSuccess) => void,
): Promise<T> => {
	const startedAt = performance.now();
	const value = await fn();
	report({ operation, count: count(value), durationMs: Math.round(performance.now() - startedAt) });
	return value;
};

const isNotPublicError = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "NOT_PUBLIC";

export const runLiveSmoke = async (config: SmokeConfig, report: (success: SmokeSuccess) => void): Promise<void> => {
	await assertNoKnownProfileLock(config.profileDir, config.browserType);
	const playwright = await loadPlaywright();
	let context: PersistentContext;
	try {
		context = await playwright[config.browserType].launchPersistentContext(config.profileDir, config.launchOptions);
	} catch (error) {
		if (isProfileLockError(error)) throw new ProfileInUseError();
		throw new Error("persistent browser を起動できませんでした。設定とブラウザ実行環境を確認してください。");
	}

	try {
		const page = await context.newPage();
		const client = createInstagramBrowser(page);
		await client.inject();
		await client.goto(config.home);

		try {
			await runMeasured(
				"getPublicProfile",
				() => client.execute("getPublicProfile", { username: config.username }),
				() => 1,
				report,
			);
			const mediaPage = await runMeasured(
				"listPublicProfileMedia",
				() => client.execute("listPublicProfileMedia", { username: config.username, limit: 12, kind: "all" }),
				(value) => value.items.length,
				report,
			);
			const firstMedia = mediaPage.items[0];
			if (!firstMedia)
				throw new SmokeSkipError("公開 media が空のため、後続の media/comments smoke をスキップしました。");
			await runMeasured(
				"getPublicMedia",
				() => client.execute("getPublicMedia", { shortcode: firstMedia.shortcode }),
				() => 1,
				report,
			);
			await runMeasured(
				"listPublicMediaComments",
				() => client.execute("listPublicMediaComments", { shortcode: firstMedia.shortcode, limit: 12 }),
				(value) => value.items.length,
				report,
			);
		} catch (error) {
			if (isNotPublicError(error)) throw new SmokeSkipError("対象が非公開のため live smoke をスキップしました。");
			throw error;
		}
	} finally {
		await context.close();
	}
};
