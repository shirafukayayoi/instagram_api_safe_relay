import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../src/accounts/service.js";
import { createApp } from "../src/app.js";
import type { RelayProfile } from "../src/types.js";
import { SerialQueue } from "../src/utils/queue.js";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const first = { id: "123", username: "owner_a" };
const second = { id: "456", username: "owner_b" };
const makeProfile = (name: string, account = first) => {
	const upload = vi.fn();
	const publish = vi.fn();
	const getAccount = vi.fn(async () => ({ ...account }));
	const queue = new SerialQueue();
	const profile: RelayProfile = {
		name,
		state: "ready",
		account: { ...account },
		runMediaExclusive: (task) =>
			queue.run(() =>
				task({
					getSessionStatus: async () => ({ state: "ready" }),
					createPublisher: async () => ({ getAccount, upload, publish, close: async () => undefined }),
					createHighlights: async () => {
						throw new Error("対象外");
					},
				}),
			),
	};
	return { profile, getAccount, upload, publish };
};
const fixture = async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-accounts-"));
	dirs.push(dir);
	const one = makeProfile("one");
	const two = makeProfile("two", second);
	const profiles = [one.profile, two.profile];
	const file = path.join(dir, "selected.json");
	const service = new AccountService(profiles, file);
	await service.open();
	return { one, two, profiles, file, service };
};
const token = "0123456789abcdef0123456789abcdef";
const headers = { host: "127.0.0.1", authorization: `Bearer ${token}`, "Content-Type": "application/json" };

describe("アカウントの選択と固定", () => {
	it("一覧は認証値を返さず、選択先を読み取り照合して再起動後も保持する", async () => {
		const f = await fixture();
		expect(f.service.list().selected).toBeNull();
		expect(await f.service.select({ profile: "two", expectedAccountId: "456" })).toEqual({
			profile: "two",
			account: second,
		});
		expect(f.two.getAccount).toHaveBeenCalledTimes(1);
		expect(f.two.upload).not.toHaveBeenCalled();
		expect(f.two.publish).not.toHaveBeenCalled();
		const reopened = new AccountService(f.profiles, f.file);
		await reopened.open();
		expect(reopened.list().selected).toEqual({ profile: "two", account: second });
		if (process.platform !== "win32") expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
		expect(Object.keys(reopened.list().accounts[0] ?? {}).sort()).toEqual(["account", "profile", "state"]);
	});
	it("不明な名前・未ログイン・アカウント不一致では前の選択を維持する", async () => {
		const f = await fixture();
		await f.service.select({ profile: "one" });
		await expect(f.service.select({ profile: "none" })).rejects.toMatchObject({ code: "UNKNOWN_PROFILE" });
		f.two.profile.state = "login_required";
		await expect(f.service.select({ profile: "two" })).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
		f.two.profile.state = "ready";
		await expect(f.service.select({ profile: "two", expectedAccountId: "999" })).rejects.toMatchObject({
			code: "ACCOUNT_CHANGED",
		});
		expect(f.service.list().selected?.profile).toBe("one");
		f.one.profile.account = second;
		expect(f.service.list().selected).toBeNull();
	});
	it("設定から消えた選択先を別アカウントで代用しない", async () => {
		const f = await fixture();
		await f.service.select({ profile: "two" });
		const reopened = new AccountService([f.one.profile], f.file);
		await reopened.open();
		expect(reopened.list().selected).toBeNull();
	});
	it("保存できなければ切り替えを確定しない", async () => {
		const f = await fixture();
		await fs.mkdir(f.file);
		await expect(f.service.select({ profile: "one" })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
		expect(f.service.list().selected).toBeNull();
	});
	it("選択を変えても明示した投稿先と複数アカウント時の必須ヘッダーを維持する", async () => {
		const f = await fixture();
		const create = vi.fn(async (profile: string) => ({ id: "job", profile }));
		const app = createApp({ token, profiles: f.profiles, accounts: f.service, stories: { create } as never });
		await f.service.select({ profile: "two" });
		const response = await app.request("http://127.0.0.1/v1/stories", {
			method: "POST",
			headers: { ...headers, "x-profile-name": "one" },
			body: JSON.stringify({ filePath: "/media.mp4" }),
		});
		expect(response.status).toBe(202);
		expect(create.mock.calls[0]?.[0]).toBe("one");
		const implicit = await app.request("http://127.0.0.1/v1/stories", {
			method: "POST",
			headers,
			body: JSON.stringify({ filePath: "/media.mp4" }),
		});
		expect(implicit.status).toBe(400);
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("一覧・選択はBearer必須で、壊れたJSONや余分な入力を拒否する", async () => {
		const f = await fixture();
		const app = createApp({ token, profiles: f.profiles, accounts: f.service });
		const denied = await app.request("http://127.0.0.1/v1/accounts", { headers: { host: "127.0.0.1" } });
		expect(denied.status).toBe(401);
		for (const body of ["{", JSON.stringify({ profile: "one", cookie: "秘密" })]) {
			const response = await app.request("http://127.0.0.1/v1/accounts/select", { method: "POST", headers, body });
			expect(response.status).toBe(400);
		}
		const selected = await app.request("http://127.0.0.1/v1/accounts/select", {
			method: "POST",
			headers,
			body: JSON.stringify({ profile: "two" }),
		});
		expect(selected.status).toBe(200);
		const list = await app.request("http://127.0.0.1/v1/accounts", { headers });
		expect((await list.json()).data.selected.profile).toBe("two");
	});
});
