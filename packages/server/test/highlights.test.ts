import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StoryJob } from "instagram-api-safe-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { HighlightService } from "../src/highlights/service.js";
import { HighlightStore } from "../src/highlights/store.js";
import { StoryError } from "../src/stories/errors.js";
import type { RelayProfile } from "../src/types.js";
import { SerialQueue } from "../src/utils/queue.js";

const directories: string[] = [];
const services: HighlightService[] = [];
const stores: HighlightStore[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const account = { id: "123", username: "owner" };
const highlight = { id: "456", title: "idol" };
const fixture = async (mode: "added" | "present" | "before-failure" | "after-failure" = "added") => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-highlight-"));
	directories.push(directory);
	const store = new HighlightStore(directory);
	await store.open();
	stores.push(store);
	const queue = new SerialQueue();
	const client = { page: {}, getSessionStatus: async () => ({ state: "ready" }) };
	const profile: RelayProfile = {
		name: "one",
		state: "ready",
		client: client as never,
		runExclusive: (task) => queue.run(() => task(client as never)),
	};
	const story: StoryJob = {
		id: randomUUID(),
		profile: "one",
		mediaId: "999",
		account,
		audience: "close_friends",
		state: "published",
		errorCode: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const browser = {
		list: vi.fn(async () => ({ account, highlights: [highlight] })),
		add: vi.fn(async (_highlight, _media, _account, beforeSave: () => Promise<void>) => {
			if (mode === "present") return true;
			if (mode === "before-failure") throw new StoryError("NOT_FOUND", "素材が見つかりません");
			await beforeSave();
			expect(store.forTarget("one", "456", "999")?.job.state).toBe("applying");
			if (mode === "after-failure") throw new Error("応答を失いました");
			return false;
		}),
		close: vi.fn(async () => undefined),
	};
	const service = new HighlightService({
		settings: {
			enabled: true,
			stateDir: directory,
			allowedMediaDirectories: [],
			ffprobePath: "ffprobe",
			operationTimeoutMs: 30000,
		},
		profiles: [profile],
		store,
		stories: {
			get: (name, id) => {
				if (name !== "one" || id !== story.id) throw new StoryError("NOT_FOUND", "対象外");
				return story;
			},
		},
		browser: async () => browser,
	});
	services.push(service);
	const request = { storyJobId: story.id };
	const finish = async (id: string) => {
		await vi.waitFor(() => expect(["completed", "failed", "unknown"]).toContain(service.get("one", id).state));
		return service.get("one", id);
	};
	return { directory, store, service, browser, profile, story, request, finish };
};

describe("ハイライト登録", () => {
	it("ブラウザーなしでも限定公開・台帳・二重登録防止を維持する", async () => {
		const f = await fixture();
		delete f.profile.client;
		delete f.profile.runExclusive;
		const queue = new SerialQueue();
		f.profile.runMediaExclusive = (task) =>
			queue.run(() =>
				task({
					getSessionStatus: async () => ({ state: "ready" }),
					createPublisher: async () => {
						throw new Error("対象外");
					},
					createHighlights: async () => f.browser,
				}),
			);
		const job = await f.service.create("one", "456", "http", f.request);
		expect(await f.finish(job.id)).toMatchObject({ state: "completed", audience: "close_friends" });
		expect((await f.service.create("one", "456", "http-repeat", f.request)).id).toBe(job.id);
		expect(f.browser.add).toHaveBeenCalledTimes(1);
	});

	it("公開済みの投稿だけを追加し、登録前の台帳と限定公開情報を維持する", async () => {
		const f = await fixture();
		const job = await f.service.create("one", "456", "first", f.request);
		expect(await f.finish(job.id)).toMatchObject({
			state: "completed",
			audience: "close_friends",
			mediaId: "999",
			alreadyPresent: false,
		});
		expect(f.browser.add).toHaveBeenCalledWith(highlight, "999", account, expect.any(Function));
		await expect(f.service.create("one", "456", "first", { storyJobId: randomUUID() })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
	});
	it("同じキー・別キーによる同じ登録の再要求は処理を増やさない", async () => {
		const f = await fixture();
		const job = await f.service.create("one", "456", "first", f.request);
		await f.finish(job.id);
		expect((await f.service.create("one", "456", "first", f.request)).id).toBe(job.id);
		expect((await f.service.create("one", "456", "second", f.request)).id).toBe(job.id);
		await expect(f.service.create("one", "789", "second", f.request)).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		expect(f.browser.add).toHaveBeenCalledTimes(1);
	});
	it("画面ですでに登録済みなら保存操作をしない", async () => {
		const f = await fixture("present");
		const job = await f.service.create("one", "456", "present", f.request);
		expect(await f.finish(job.id)).toMatchObject({ state: "completed", alreadyPresent: true });
	});
	it.each(["queued", "publishing", "unknown", "failed"] as const)("%sの投稿を登録しない", async (state) => {
		const f = await fixture();
		f.story.state = state;
		await expect(f.service.create("one", "456", "first", f.request)).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(f.browser.add).not.toHaveBeenCalled();
	});
	it("アカウントが変わった場合、他人のハイライトと余分な入力を拒否する", async () => {
		const f = await fixture();
		await expect(f.service.create("one", "999", "first", f.request)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			f.service.create("one", "456", "first", { ...f.request, url: "https://example.com" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		f.story.account = { id: "321", username: "someone" };
		await expect(f.service.create("one", "456", "first", f.request)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
	});
	it.each([
		["before-failure", "failed"],
		["after-failure", "unknown"],
	] as const)("%sの場合は%sとして自動再登録を止める", async (mode, state) => {
		const f = await fixture(mode);
		const job = await f.service.create("one", "456", "first", f.request);
		expect((await f.finish(job.id)).state).toBe(state);
		await f.service.create("one", "456", "first", f.request);
		expect(f.browser.add).toHaveBeenCalledTimes(1);
	});
	it("再起動後のapplyingはunknownにし、台帳の排他とプロフィール分離を維持する", async () => {
		const f = await fixture("after-failure");
		const job = await f.service.create("one", "456", "first", f.request);
		await f.finish(job.id);
		const record = f.store.get(job.id);
		if (!record) throw new Error("台帳がありません");
		await f.store.save({ ...record, job: { ...record.job, state: "applying" } });
		await expect(new HighlightStore(f.directory).open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
		await expect(Promise.resolve().then(() => f.service.get("two", job.id))).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await f.service.close();
		const reopened = new HighlightStore(f.directory);
		await reopened.open();
		stores.push(reopened);
		expect(reopened.get(job.id)?.job).toMatchObject({ state: "unknown", errorCode: "PUBLICATION_UNKNOWN" });
	});
	it("HTTP認証・無効化・入力・状態照会を検証する", async () => {
		const f = await fixture();
		const app = createApp({ profiles: [f.profile], token: "secret", highlights: f.service });
		const headers = {
			host: "localhost",
			authorization: "Bearer secret",
			"x-profile-name": "one",
			"idempotency-key": "first",
			"content-type": "application/json",
		};
		expect((await app.request("/v1/highlights", { headers: { host: "localhost" } })).status).toBe(401);
		expect((await app.request("/v1/highlights", { headers })).status).toBe(200);
		expect((await app.request("/v1/highlights/456/stories", { method: "POST", headers, body: "{}" })).status).toBe(400);
		const response = await app.request("/v1/highlights/456/stories", {
			method: "POST",
			headers,
			body: JSON.stringify(f.request),
		});
		expect(response.status).toBe(202);
		const job = (await response.json()).data;
		await f.finish(job.id);
		expect((await app.request(`/v1/highlight-jobs/${job.id}`, { headers })).status).toBe(200);
		expect((await app.request("/v1/highlights", { headers: { ...headers, "x-profile-name": "two" } })).status).toBe(
			400,
		);
		const disabled = createApp({ profiles: [f.profile], token: "secret" });
		expect((await disabled.request("/v1/highlights", { headers })).status).toBe(403);
	});
});
