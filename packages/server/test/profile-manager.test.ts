import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ProfileManager } from "../src/profile-manager.js";
import type { RelayProfile } from "../src/types.js";

class FakePage extends EventEmitter {
	closed = false;
	reloadCalls = 0;
	reloadImpl: () => Promise<void> = async () => undefined;
	isClosed = () => this.closed;
	reload = async () => {
		this.reloadCalls += 1;
		await this.reloadImpl();
	};
}

class FakeContext extends EventEmitter {
	readonly browserEmitter = new EventEmitter();
	readonly pages: FakePage[] = [];
	newPageCalls = 0;
	newPage = async () => {
		this.newPageCalls += 1;
		const page = new FakePage();
		this.pages.push(page);
		return page;
	};
	close = async () => this.emit("close");
	browser = () => this.browserEmitter;
}

const profileSettings = {
	name: "test",
	home: "https://www.instagram.com/",
	browser: {
		type: "launch" as const,
		browserType: "chromium" as const,
		userDataDir: "./test-profile",
		headless: true,
		args: [],
	},
};

const clientFor = (page: FakePage, state = "ready") => ({
	page,
	inject: async () => undefined,
	goto: async () => undefined,
	waitStartup: async () => undefined,
	execute: async () => ({}),
	initHook: async () => undefined,
	getCatalogStatus: async () => ({}),
	getSessionStatus: async () => ({ state, checkedAt: new Date().toISOString() }),
});

const createManager = (
	profile: RelayProfile,
	context: FakeContext,
	state = "ready",
	openContext: () => Promise<FakeContext> = async () => context,
) => new ProfileManager({
	settings: profileSettings,
	profile,
	logger: pino({ level: "silent" }),
	sessionCheckIntervalMs: 60_000,
	recoveryRetryMs: 60_000,
	openContext: openContext as never,
	createClient: ((page: FakePage) => clientFor(page, state)) as never,
});

describe("ProfileManager", () => {
	for (const state of ["ready", "login_required", "two_factor_required", "challenge_required"] as const) {
		it(`セッション状態 ${state} をRelayProfileへ反映する`, async () => {
			const profile: RelayProfile = { name: "test", state: "starting" };
			const manager = createManager(profile, new FakeContext(), state);
			await manager.start();
			expect(profile.state).toBe(state);
			await manager.stop();
		});
	}

	it("reload失敗時は同じcontext内の新しいpageへ復旧する", async () => {
		const profile: RelayProfile = { name: "test", state: "starting" };
		const context = new FakeContext();
		const manager = createManager(profile, context);
		await manager.start();
		const firstPage = context.pages[0];
		if (!firstPage) throw new Error("初期pageが作成されませんでした");
		firstPage.reloadImpl = async () => { throw new Error("reload failed"); };

		await manager.recover("test");

		expect(context.newPageCalls).toBe(2);
		expect(profile.state).toBe("ready");
		expect(profile.client?.page).toBe(context.pages[1]);
		await manager.stop();
	});

	it("contextを開けない場合はbrowser_disconnectedになり、stopできる", async () => {
		const profile: RelayProfile = { name: "test", state: "starting" };
		const context = new FakeContext();
		const manager = createManager(profile, context, "ready", async () => { throw new Error("launch failed"); });

		await manager.start();

		expect(profile.state).toBe("browser_disconnected");
		expect(profile.client).toBeUndefined();
		await manager.stop();
	});

	it("同時のrecover呼び出しを1回のreloadへまとめる", async () => {
		const profile: RelayProfile = { name: "test", state: "starting" };
		const context = new FakeContext();
		const manager = createManager(profile, context);
		await manager.start();
		let release: (() => void) | undefined;
		const firstPage = context.pages[0];
		if (!firstPage) throw new Error("初期pageが作成されませんでした");
		firstPage.reloadImpl = () => new Promise<void>((resolve) => { release = resolve; });

		const first = manager.recover("first");
		const second = manager.recover("second");
		await Promise.resolve();
		expect(firstPage.reloadCalls).toBe(1);
		release?.();
		await Promise.all([first, second]);
		expect(firstPage.reloadCalls).toBe(1);
		await manager.stop();
	});
});
