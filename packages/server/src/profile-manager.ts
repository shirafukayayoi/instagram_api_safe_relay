import { createInstagramBrowser, type InstagramApiProfileClient } from "instagram-api-safe-request";
import type { BrowserContext, Page } from "playwright";
import type { Logger } from "pino";
import type { RelayProfile } from "./types.js";
import { openBrowserContext } from "./utils/browser.js";
import type { Settings } from "./utils/settings.js";

type ProfileSettings = Settings["profiles"][number];

type ProfileManagerDependencies = {
	openContext?: typeof openBrowserContext;
	createClient?: typeof createInstagramBrowser;
};

type ProfileManagerOptions = ProfileManagerDependencies & {
	settings: ProfileSettings;
	profile: RelayProfile;
	logger: Logger;
	sessionCheckIntervalMs: number;
	recoveryRetryMs: number;
};

const safeErrorCode = (error: unknown): string => {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code.slice(0, 64);
	}
	return error instanceof Error ? error.name.slice(0, 64) : "UNKNOWN_ERROR";
};

export class ProfileManager {
	readonly #settings: ProfileSettings;
	readonly #profile: RelayProfile;
	readonly #logger: Logger;
	readonly #sessionCheckIntervalMs: number;
	readonly #recoveryRetryMs: number;
	readonly #openContext: typeof openBrowserContext;
	readonly #createClient: typeof createInstagramBrowser;
	#context: BrowserContext | undefined;
	#page: Page | undefined;
	#recovery: Promise<void> | undefined;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#sessionTimer?: ReturnType<typeof setInterval>;
	#reloadTimer?: ReturnType<typeof setInterval>;
	#stopped = false;

	constructor(options: ProfileManagerOptions) {
		this.#settings = options.settings;
		this.#profile = options.profile;
		this.#logger = options.logger;
		this.#sessionCheckIntervalMs = options.sessionCheckIntervalMs;
		this.#recoveryRetryMs = options.recoveryRetryMs;
		this.#openContext = options.openContext ?? openBrowserContext;
		this.#createClient = options.createClient ?? createInstagramBrowser;
	}

	async start(): Promise<void> {
		this.#sessionTimer = setInterval(() => void this.checkSession(), this.#sessionCheckIntervalMs);
		this.#sessionTimer.unref();
		if (this.#settings.pageReloadIntervalMinutes) {
			this.#reloadTimer = setInterval(
				() => void this.recover("scheduled_reload"),
				this.#settings.pageReloadIntervalMinutes * 60_000,
			);
			this.#reloadTimer.unref();
		}
		await this.recover("startup");
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		if (this.#sessionTimer) clearInterval(this.#sessionTimer);
		if (this.#reloadTimer) clearInterval(this.#reloadTimer);
		const context = this.#context;
		this.#context = undefined;
		this.#page = undefined;
		delete this.#profile.client;
		await context?.close().catch(() => undefined);
	}

	async checkSession(): Promise<void> {
		if (this.#stopped || this.#recovery) return;
		const client = this.#profile.client;
		if (!client || !this.#page || this.#page.isClosed()) {
			await this.recover("session_check");
			return;
		}
		try {
			const status = await client.getSessionStatus();
			if (this.#profile.client !== client || this.#recovery) return;
			this.#profile.state = status.state;
			delete this.#profile.lastError;
		} catch (error) {
			this.#profile.lastError = safeErrorCode(error);
			await this.recover("session_check_failed");
		}
	}

	async recover(reason: string): Promise<void> {
		if (this.#stopped) return;
		if (this.#recovery) return await this.#recovery;
		this.#recovery = this.#recover(reason).finally(() => {
			this.#recovery = undefined;
		});
		return await this.#recovery;
	}

	async #recover(reason: string): Promise<void> {
		this.#profile.state = reason === "startup" ? "starting" : "recovering";
		this.#logger.info({ profile: this.#profile.name, reason }, "Instagramセッションの復旧を開始します");

		try {
			if (await this.#reloadCurrentPage()) return;
			if (await this.#openPageInCurrentContext()) return;
			await this.#reopenContext();
		} catch (error) {
			const code = safeErrorCode(error);
			this.#profile.state = "browser_disconnected";
			this.#profile.lastError = code;
			delete this.#profile.client;
			this.#logger.warn({ profile: this.#profile.name, errorCode: code }, "Instagramセッションを復旧できませんでした");
			this.#scheduleRetry();
		}
	}

	async #reloadCurrentPage(): Promise<boolean> {
		const page = this.#page;
		const client = this.#profile.client;
		if (!page || page.isClosed() || !client) return false;
		try {
			await page.reload();
			await client.waitStartup();
			await this.#applySessionStatus(client);
			return true;
		} catch {
			return false;
		}
	}

	async #openPageInCurrentContext(): Promise<boolean> {
		const context = this.#context;
		if (!context) return false;
		try {
			const page = await context.newPage();
			await this.#preparePage(context, page);
			return true;
		} catch {
			return false;
		}
	}

	async #reopenContext(): Promise<void> {
		const previous = this.#context;
		this.#context = undefined;
		this.#page = undefined;
		delete this.#profile.client;
		await previous?.close().catch(() => undefined);

		const context = await this.#openContext(this.#settings.browser);
		this.#context = context;
		this.#watchContext(context);
		const page = await context.newPage();
		await this.#preparePage(context, page);
	}

	async #preparePage(context: BrowserContext, page: Page): Promise<void> {
		const client = this.#createClient(page);
		await client.inject();
		await client.goto(this.#settings.home);
		if (this.#context !== context) throw new Error("STALE_BROWSER_CONTEXT");

		this.#page = page;
		this.#profile.client = client;
		this.#watchPage(page);
		await this.#applySessionStatus(client);
	}

	async #applySessionStatus(client: InstagramApiProfileClient): Promise<void> {
		const status = await client.getSessionStatus();
		if (this.#profile.client !== client) return;
		this.#profile.state = status.state;
		delete this.#profile.lastError;
		this.#logger.info({ profile: this.#profile.name, state: status.state }, "Instagramセッション状態を更新しました");
	}

	#watchPage(page: Page): void {
		const disconnected = () => {
			if (this.#stopped || this.#page !== page) return;
			this.#profile.state = "browser_disconnected";
			void this.recover("page_disconnected");
		};
		page.once("close", disconnected);
		page.once("crash", disconnected);
	}

	#watchContext(context: BrowserContext): void {
		const disconnected = () => {
			if (this.#stopped || this.#context !== context) return;
			this.#profile.state = "browser_disconnected";
			void this.recover("browser_disconnected");
		};
		context.once("close", disconnected);
		context.browser()?.once("disconnected", disconnected);
	}

	#scheduleRetry(): void {
		if (this.#stopped || this.#retryTimer) return;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			void this.recover("retry");
		}, this.#recoveryRetryMs);
		this.#retryTimer.unref();
	}
}
