import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { executeDmInBrowser } from "../src/direct/browser-execute.js";
import type { DmTransport } from "../src/direct/browser.js";
import { DmService } from "../src/direct/service.js";
import { DmStore } from "../src/direct/store.js";
import { SerialQueue } from "../src/utils/queue.js";
import { loadSettings } from "../src/utils/settings.js";
import type { RelayProfile } from "../src/types.js";

const account = { id: "123", username: "owner" };
const thread = {
	id: "999",
	title: "会話",
	isGroup: false,
	canSendText: true,
	users: [{ id: "456", username: "recipient", displayName: "宛先" }],
};
const messages = { account, thread, messages: [], nextCursor: null, hasMore: false };
const services: DmService[] = [];
const stores: DmStore[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const fixture = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-dm-"));
	directories.push(directory);
	const store = new DmStore(directory);
	await store.open();
	stores.push(store);
	const transport: DmTransport = {
		account: vi.fn(async () => account),
		inbox: vi.fn(async () => ({ account, threads: [thread], nextCursor: "next", hasMore: true })),
		messages: vi.fn(async () => messages),
		send: vi.fn(async () => "888"),
		close: vi.fn(async () => undefined),
	};
	const queue = new SerialQueue();
	const client = { page: {}, getSessionStatus: async () => ({ state: "ready" }) };
	const profile: RelayProfile = {
		name: "one",
		state: "ready",
		client: client as never,
		runExclusive: (task) => queue.run(() => task(client as never)),
	};
	const settings = { enabled: true, stateDir: directory, operationTimeoutMs: 30000 };
	const factory = vi.fn(async () => transport);
	const profiles = [profile];
	const service = new DmService({ settings, store, profiles, transport: factory });
	services.push(service);
	return { store, service, profile, profiles, transport, factory, settings };
};
const done = async (service: DmService, id: string) => {
	await vi.waitFor(() => expect(["sent", "failed", "unknown"]).toContain(service.get("one", id).state));
	return service.get("one", id);
};

describe("DMサービス", () => {
	it("DMは既定で無効で、不正な設定と無効時の操作を拒否する", async () => {
		const input = { profiles: [{ name: "one", browser: { type: "launch", userDataDir: "./user_data/one" } }] };
		expect(loadSettings(input).direct.enabled).toBe(false);
		expect(() => loadSettings({ ...input, direct: { enabled: true, operationTimeoutMs: 10 } })).toThrow();
		const f = await fixture();
		f.settings.enabled = false;
		expect(() => f.service.inbox("one", {})).toThrow();
		await expect(f.service.create("one", "disabled", { threadId: "999", text: "hello" })).rejects.toMatchObject({
			code: "DM_DISABLED",
		});
		expect(f.factory).not.toHaveBeenCalled();
	});
	it("一覧・会話・ページ指定を取得し、任意URLや不正な入力を拒否する", async () => {
		const f = await fixture();
		expect((await f.service.inbox("one", { limit: 5, cursor: "next" })).threads).toEqual([thread]);
		expect(f.transport.inbox).toHaveBeenCalledWith({ limit: 5, cursor: "next" });
		expect(await f.service.messages("one", "999", {})).toEqual(messages);
		expect(() => f.service.messages("one", "../other", {})).toThrow();
		expect(() => f.service.inbox("one", { limit: 51 })).toThrow();
		expect(() => f.service.inbox("missing", {})).toThrow();
		for (const input of [
			{ threadId: "999", text: " " },
			{ threadId: "abc", text: "x" },
			{ threadId: "999", text: "x".repeat(1001) },
			{ threadId: "999", text: "x", url: "https://other" },
		])
			await expect(f.service.create("one", "invalid", input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(f.service.create("one", undefined, { threadId: "999", text: "x" })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	});
	it("送信直前に永続化し、同時再要求で1回だけ送信して本文を保存しない", async () => {
		const f = await fixture();
		vi.mocked(f.transport.send).mockImplementation(async (_id, _text, context) => {
			expect(f.store.get(context)?.job.state).toBe("sending");
			return "888";
		});
		const input = { threadId: "999", text: "本文🌸\n2行目" };
		const [first, second] = await Promise.all([
			f.service.create("one", "same", input),
			f.service.create("one", "same", input),
		]);
		expect(second.id).toBe(first.id);
		expect(await done(f.service, first.id)).toMatchObject({ state: "sent", messageId: "888" });
		expect(f.transport.send).toHaveBeenCalledExactlyOnceWith("999", input.text, first.id, account);
		const disk = await fs.readFile(path.join(f.store.directory, "jobs", `${first.id}.json`), "utf8");
		expect(disk).not.toContain(input.text);
		expect(JSON.stringify(f.service.get("one", first.id))).not.toContain(input.text);
		for (const changed of [
			{ ...input, text: "変更" },
			{ ...input, threadId: "111" },
		])
			await expect(f.service.create("one", "same", changed)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});
	it("公開後の応答喪失はunknownとして同じキーを再送しない", async () => {
		const f = await fixture();
		vi.mocked(f.transport.send).mockRejectedValue(new Error("confidential raw response"));
		const input = { threadId: "999", text: "hello" };
		const job = await f.service.create("one", "unknown", input);
		expect(await done(f.service, job.id)).toMatchObject({ state: "unknown", errorCode: "DELIVERY_UNKNOWN" });
		await f.service.create("one", "unknown", input);
		expect(f.transport.send).toHaveBeenCalledOnce();
	});
	it("アカウント変更・会話不一致・未対応会話は送信前に止める", async () => {
		const f = await fixture();
		vi.mocked(f.transport.account)
			.mockResolvedValueOnce(account)
			.mockResolvedValueOnce({ id: "777", username: "other" });
		const changed = await f.service.create("one", "changed", { threadId: "999", text: "hello" });
		expect((await done(f.service, changed.id)).state).toBe("failed");
		vi.mocked(f.transport.messages).mockResolvedValueOnce({ ...messages, thread: { ...thread, id: "111" } });
		const wrong = await f.service.create("one", "wrong", { threadId: "999", text: "hello" });
		expect((await done(f.service, wrong.id)).state).toBe("failed");
		vi.mocked(f.transport.messages).mockResolvedValueOnce({ ...messages, thread: { ...thread, canSendText: false } });
		const unsupported = await f.service.create("one", "unsupported", { threadId: "999", text: "hello" });
		expect((await done(f.service, unsupported.id)).state).toBe("failed");
		expect(f.transport.send).not.toHaveBeenCalled();
	});
	it("送信直前の保存失敗では送信しない", async () => {
		const f = await fixture();
		const save = f.store.save.bind(f.store);
		vi.spyOn(f.store, "save").mockImplementation(async (record) => {
			if (record.job.state === "sending") throw new Error("disk full");
			await save(record);
		});
		const job = await f.service.create("one", "disk", { threadId: "999", text: "hello" });
		expect((await done(f.service, job.id)).state).toBe("failed");
		expect(f.transport.send).not.toHaveBeenCalled();
	});
	it("再起動後も同じジョブを返し、sendingをunknownとして再送しない", async () => {
		const f = await fixture();
		const input = { threadId: "999", text: "hello" };
		const job = await f.service.create("one", "persistent", input);
		await done(f.service, job.id);
		const record = f.store.get(job.id);
		if (!record) throw new Error("missing");
		await f.store.save({ ...record, job: { ...record.job, state: "sending", messageId: null } });
		await f.service.close();
		const reopened = new DmStore(f.store.directory);
		await reopened.open();
		stores.push(reopened);
		const service = new DmService({
			settings: f.settings,
			profiles: [f.profile],
			store: reopened,
			transport: f.factory,
		});
		services.push(service);
		expect(await service.create("one", "persistent", input)).toMatchObject({ id: job.id, state: "unknown" });
		expect(f.transport.send).toHaveBeenCalledOnce();
	});
	it("台帳二重起動・破損・別プロファイルの参照を拒否する", async () => {
		const f = await fixture();
		const second = new DmStore(f.store.directory);
		await expect(second.open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
		expect(() => f.service.get("other", "id")).toThrow();
		await f.service.close();
		await fs.writeFile(path.join(f.store.directory, "jobs", "bad.json"), "{}");
		await expect(second.open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
	});
	it("HTTP認証・機能無効・プロファイル・サイズ制限を検証する", async () => {
		const f = await fixture();
		const token = "a".repeat(48);
		const headers = {
			host: "127.0.0.1",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"idempotency-key": "http",
		};
		const disabled = createApp({ profiles: [f.profile], token });
		expect((await disabled.request("http://127.0.0.1/v1/dm/threads", { headers })).status).toBe(403);
		f.profiles.push({ name: "two", state: "ready" });
		const app = createApp({ profiles: f.profiles, token, direct: f.service });
		expect((await app.request("http://127.0.0.1/v1/dm/threads", { headers: { host: "127.0.0.1" } })).status).toBe(401);
		expect((await app.request("http://127.0.0.1/v1/dm/threads", { headers })).status).toBe(400);
		const selected = { ...headers, "x-profile-name": "one" };
		expect((await app.request("http://127.0.0.1/v1/dm/threads", { headers: selected })).status).toBe(200);
		expect(
			(await app.request("http://127.0.0.1/v1/dm/messages", { method: "POST", headers: selected, body: "bad" })).status,
		).toBe(400);
		expect(
			(
				await app.request("http://127.0.0.1/v1/dm/messages", {
					method: "POST",
					headers: selected,
					body: "x".repeat(9000),
				})
			).status,
		).toBe(413);
		const response = await app.request("http://127.0.0.1/v1/dm/messages", {
			method: "POST",
			headers: selected,
			body: JSON.stringify({ threadId: "999", text: "hello" }),
		});
		expect(response.status).toBe(202);
		const { data } = await response.json();
		await done(f.service, data.id);
		expect(
			(
				await app.request(`http://127.0.0.1/v1/dm/jobs/${data.id}`, {
					headers: { ...selected, "x-profile-name": "two" },
				})
			).status,
		).toBe(404);
	});
});

describe("ブラウザ内DM通信", () => {
	const mockBrowser = (data: unknown) => {
		const get = vi.fn(async () => ({ statusCode: 200, data }));
		const post = vi.fn(async () => ({ statusCode: 200, data }));
		vi.stubGlobal("location", { origin: "https://www.instagram.com", pathname: "/" });
		vi.stubGlobal("window", {
			require: (name: string) => {
				if (name === "PolarisViewer") return { id: "123", data: { username: "owner" } };
				if (name === "Cookie") return { get: () => "123" };
				if (name === "PolarisInstapi") return { apiGet: get, apiPost: post };
				throw new Error("unknown");
			},
		});
		return { get, post };
	};
	it("raw応答の機密値を返さず固定の一覧URLだけを読む", async () => {
		const raw = {
			thread_id: "999",
			thread_title: "会話",
			is_group: false,
			users: [{ pk: 456, username: "recipient", full_name: "宛先" }],
			is_xac_readonly: false,
			e2ee_cutover_status: 0,
			pending: false,
		};
		const f = mockBrowser({ viewer: { pk: 123 }, inbox: { threads: [raw], has_older: false }, secret: "never-export" });
		expect(await executeDmInBrowser({ op: "inbox", page: { limit: 5 } })).toEqual({
			account,
			threads: [thread],
			nextCursor: null,
			hasMore: false,
		});
		expect(f.post).not.toHaveBeenCalled();
		expect(f.get).toHaveBeenCalledWith("/api/v1/direct_v2/inbox/", { query: { limit: "5" } });
	});
	it("固定の宛先・本文・client_contextで送り、宛先と文脈の一致を要求する", async () => {
		const context = "00000000-0000-4000-8000-000000000001";
		const f = mockBrowser({ payload: { thread_id: "999", client_context: context, item_id: "888" } });
		expect(
			await executeDmInBrowser({ op: "send", threadId: "999", text: "こんにちは", clientContext: context, account }),
		).toBe("888");
		expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/v1/direct_v2/threads/broadcast/text/", {
			body: {
				action: "send_item",
				thread_ids: '["999"]',
				text: "こんにちは",
				client_context: context,
				mutation_token: context,
			},
		});
		for (const payload of [
			{ thread_id: "111", client_context: context, item_id: "888" },
			{ thread_id: "999", client_context: "wrong", item_id: "888" },
			{},
		]) {
			const bad = mockBrowser({ payload });
			expect(
				await executeDmInBrowser({ op: "send", threadId: "999", text: "こんにちは", clientContext: context, account }),
			).toBeNull();
			expect(bad.post).toHaveBeenCalledOnce();
		}
	});
	it("セッション不一致・任意path・別originでは通信しない", async () => {
		const f = mockBrowser({});
		expect(
			await executeDmInBrowser({ op: "send", threadId: "../other", text: "hello", clientContext: "context", account }),
		).toBeNull();
		expect(
			await executeDmInBrowser({
				op: "send",
				threadId: "999",
				text: "hello",
				clientContext: "context",
				account: { id: "456", username: "other" },
			}),
		).toBeNull();
		vi.stubGlobal("location", { origin: "https://other.example", pathname: "/" });
		expect(await executeDmInBrowser({ op: "inbox", page: { limit: 5 } })).toBeNull();
		expect(f.post).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
	});
});
