import fs from "node:fs/promises";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.js";
import { ProfileManager } from "./profile-manager.js";
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
const managers = settings.profiles.map((profileSettings) => {
	const profile: RelayProfile = { name: profileSettings.name, state: "starting" };
	profiles.push(profile);
	return new ProfileManager({
		settings: profileSettings,
		profile,
		logger,
		sessionCheckIntervalMs: settings.sessionCheckIntervalSeconds * 1_000,
		recoveryRetryMs: settings.recoveryRetrySeconds * 1_000,
	});
});

const app = createApp({ profiles, token, requestTimeoutMs: settings.requestTimeoutMs, dashboard: settings.dashboard });
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: settings.port });
logger.info({ url: `http://127.0.0.1:${settings.port}`, profiles: profiles.map(({ name }) => name) }, "Relayを起動しました");
await Promise.all(managers.map((manager) => manager.start()));
