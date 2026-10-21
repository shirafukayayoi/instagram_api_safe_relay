import fs from "node:fs/promises";
import path from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";
import { AccountService } from "./accounts/service.js";
import { createApp } from "./app.js";
import { DmService } from "./direct/service.js";
import { DmStore } from "./direct/store.js";
import { HighlightService } from "./highlights/service.js";
import { HighlightStore } from "./highlights/store.js";
import { HttpProfileManager } from "./http/profile-manager.js";
import { StoryService } from "./stories/service.js";
import { StoryStore } from "./stories/store.js";
import { MentionService } from "./story-mentions/service.js";
import { MentionStore } from "./story-mentions/store.js";
import type { RelayProfile } from "./types.js";
import { loadSettings } from "./utils/settings.js";

const settingsPath = process.env.INSTAGRAM_RELAY_SETTINGS ?? "./../../settings.json";
const token = process.env.INSTAGRAM_RELAY_API_TOKEN;
if (!token || token.length < 32) throw new Error("INSTAGRAM_RELAY_API_TOKENに32文字以上のランダム値を設定してください");

const settings = loadSettings(JSON.parse(await fs.readFile(settingsPath, "utf8")));
const logger = pino({
	level: settings.logLevel,
	...(settings.logPrettyPrint ? { transport: { target: "pino-pretty" } } : {}),
	redact: { paths: ["req.headers.authorization", "*.cookie", "*.csrf", "*.token"], censor: "[REDACTED]" },
});

const profiles: RelayProfile[] = [];
const managers = await Promise.all(
	settings.profiles.map(async (profileSettings) => {
		const profile: RelayProfile = { name: profileSettings.name, state: "starting" };
		profiles.push(profile);
		if (profileSettings.browser.type === "http")
			return new HttpProfileManager(
				profile,
				profileSettings.browser.sessionFile,
				settings.stories.ffmpegPath,
				settings.stories.feedPostSharingEnabled,
			);
		const { ProfileManager } = await import("./profile-manager.js");
		return new ProfileManager({
			settings: profileSettings,
			profile,
			logger,
			sessionCheckIntervalMs: settings.sessionCheckIntervalSeconds * 1_000,
			recoveryRetryMs: settings.recoveryRetrySeconds * 1_000,
		});
	}),
);

let stories: StoryService | undefined;
if (settings.stories.enabled) {
	const store = new StoryStore(settings.stories.stateDir);
	await store.open();
	stories = new StoryService({
		settings: settings.stories,
		profiles,
		store,
		onStorageError: (id) =>
			logger.error({ jobId: id, errorCode: "STORAGE_UNAVAILABLE" }, "ストーリー台帳の保存に失敗しました"),
	});
}
let highlights: HighlightService | undefined;
if (stories) {
	const store = new HighlightStore(path.join(settings.stories.stateDir, "highlights"));
	await store.open();
	highlights = new HighlightService({ settings: settings.stories, profiles, stories, store });
}
let direct: DmService | undefined;
if (settings.direct.enabled) {
	const store = new DmStore(settings.direct.stateDir);
	await store.open();
	direct = new DmService({ settings: settings.direct, profiles, store });
}
let storyMentions: MentionService | undefined;
if (settings.storyMentions.enabled) {
	const store = new MentionStore(settings.storyMentions.stateDir);
	await store.open();
	storyMentions = new MentionService({ settings: settings.storyMentions, profiles, store });
}
const accounts = new AccountService(profiles, settings.accountSelectionFile);
await accounts.open();
const app = createApp({
	accounts,
	profiles,
	token,
	requestTimeoutMs: settings.requestTimeoutMs,
	dashboard: settings.dashboard,
	...(stories ? { stories } : {}),
	...(direct ? { direct } : {}),
	...(storyMentions ? { storyMentions } : {}),
	...(highlights ? { highlights } : {}),
});
const httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: settings.port });
let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	await highlights?.close();
	await stories?.close();
	await direct?.close();
	await storyMentions?.close();
	await Promise.all(managers.map((manager) => manager.stop()));
	httpServer.close(() => process.exit(0));
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
logger.info(
	{ url: `http://127.0.0.1:${settings.port}`, profiles: profiles.map(({ name }) => name) },
	"Relayを起動しました",
);
await Promise.all(managers.map((manager) => manager.start()));
