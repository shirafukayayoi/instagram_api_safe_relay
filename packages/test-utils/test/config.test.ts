import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSmokeConfig } from "../src/config.ts";
import { isProfileLockError } from "../src/live-smoke.ts";

test("settings の最初の launch profile と相対 profile dir を解決する", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "instagram-smoke-"));
	try {
		await writeFile(
			path.join(directory, "settings.json"),
			JSON.stringify({
				profiles: [
					{ name: "remote", browser: { type: "cdp", cdpEndpoint: "http://127.0.0.1:9222" } },
					{
						name: "local",
						home: "https://www.instagram.com/",
						browser: { type: "launch", browserType: "firefox", userDataDir: "profiles/local" },
					},
				],
			}),
		);
		const config = await resolveSmokeConfig(
			{ INSTAGRAM_SMOKE_USERNAME: "public.user", INSTAGRAM_SMOKE_SETTINGS: "settings.json" },
			directory,
		);
		assert.equal(config.browserType, "firefox");
		assert.equal(config.profileDir, path.join(directory, "profiles/local"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("profile dir override は settings がなくても利用できる", async () => {
	const config = await resolveSmokeConfig(
		{
			INSTAGRAM_SMOKE_USERNAME: "public.user",
			INSTAGRAM_SMOKE_PROFILE_DIR: "profiles/override",
		},
		"C:/workspace",
	);
	assert.equal(config.profileDir, path.resolve("C:/workspace", "profiles/override"));
	assert.equal(config.browserType, "chromium");
});

test("username 必須と profile lock エラーを安全に判定する", async () => {
	await assert.rejects(() => resolveSmokeConfig({}, process.cwd()), /INSTAGRAM_SMOKE_USERNAME/);
	assert.equal(isProfileLockError(new Error("user data directory is already in use")), true);
	assert.equal(isProfileLockError(new Error("ECONNREFUSED https://secret.example")), false);
});
