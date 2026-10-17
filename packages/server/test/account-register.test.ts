import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHttpAccount } from "../../../scripts/register-http-account.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const fixture = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ig-register-"));
	dirs.push(root);
	await fs.mkdir(path.join(root, "private_sessions"), { mode: 0o700 });
	const writeSession = async (name: string, id: string, username: string) => {
		await fs.writeFile(
			path.join(root, "private_sessions", name),
			JSON.stringify({
				version: 1,
				account: { id, username },
				userAgent: "test",
				cookies: [
					{ name: "sessionid", value: "SECRET", domain: ".instagram.com", path: "/", secure: true, expires: null },
					{ name: "csrftoken", value: "CSRF", domain: ".instagram.com", path: "/", secure: true, expires: null },
					{ name: "ds_user_id", value: id, domain: ".instagram.com", path: "/", secure: true, expires: null },
				],
			}),
			{ mode: 0o600 },
		);
	};
	await writeSession("one.json", "123", "first");
	await writeSession("two.json", "456", "second");
	const config = {
		profiles: [{ name: "one", browser: { type: "http", sessionFile: "../../private_sessions/one.json" } }],
	};
	const settingsFile = path.join(root, "settings.json");
	await fs.writeFile(settingsFile, JSON.stringify(config), { mode: 0o600 });
	const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "ok", form_data: { username: "second" } })));
	vi.stubGlobal("fetch", fetcher);
	return { root, settingsFile, config, fetcher, writeSession };
};
describe("移行済みアカウントの登録", () => {
	it("別アカウントを照合して追加し、既存設定とバックアップを保持する", async () => {
		const f = await fixture();
		const original = await fs.readFile(f.settingsFile, "utf8");
		expect(await registerHttpAccount(f.root, "two", "private_sessions/two.json")).toMatchObject({
			profile: "two",
			account: { id: "456", username: "second" },
			restartRequired: true,
		});
		const changed = JSON.parse(await fs.readFile(f.settingsFile, "utf8"));
		expect(changed.profiles[0]).toEqual(f.config.profiles[0]);
		expect(changed.profiles).toHaveLength(2);
		const names = await fs.readdir(path.join(f.root, "work/skill-relay"));
		const backup = names.find((name) => name.startsWith("settings-before-account-"));
		expect(backup).toBeTruthy();
		expect(await fs.readFile(path.join(f.root, "work/skill-relay", backup ?? ""), "utf8")).toBe(original);
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
	it("名前・実アカウントの重複や同時登録を拒否して設定を変更しない", async () => {
		const f = await fixture();
		const original = await fs.readFile(f.settingsFile, "utf8");
		await expect(registerHttpAccount(f.root, "one", "private_sessions/two.json")).rejects.toThrow();
		await f.writeSession("two.json", "123", "second");
		await expect(registerHttpAccount(f.root, "two", "private_sessions/two.json")).rejects.toThrow();
		await fs.mkdir(path.join(f.root, "work/skill-relay/register-account.lock"));
		await expect(registerHttpAccount(f.root, "two", "private_sessions/two.json")).rejects.toThrow();
		expect(await fs.readFile(f.settingsFile, "utf8")).toBe(original);
	});
	it("照合中の設定変更を上書きしない", async () => {
		const f = await fixture();
		f.fetcher.mockImplementationOnce(async () => {
			await fs.writeFile(f.settingsFile, JSON.stringify({ ...f.config, port: 3333 }));
			return new Response(JSON.stringify({ status: "ok", form_data: { username: "second" } }));
		});
		await expect(registerHttpAccount(f.root, "two", "private_sessions/two.json")).rejects.toThrow();
		expect(JSON.parse(await fs.readFile(f.settingsFile, "utf8")).port).toBe(3333);
	});
});
