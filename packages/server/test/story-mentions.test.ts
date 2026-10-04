import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { type MentionCandidate, type MentionTransport, readMentionsInBrowser } from "../src/story-mentions/browser.js";
import { MentionService } from "../src/story-mentions/service.js";
import { MentionStore } from "../src/story-mentions/store.js";
import type { RelayProfile } from "../src/types.js";
import { SerialQueue } from "../src/utils/queue.js";

const account = { id: "123", username: "owner" };
const candidate: MentionCandidate = {
	account,
	threadId: "999",
	messageId: "888",
	senderId: "456",
	senderUsername: "sender",
	mediaId: "777_456",
	receivedAt: "123456",
	status: "available",
	reason: "REPOST_ALLOWED",
};
const services: MentionService[] = [],
	directories: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(services.splice(0).map((s) => s.close()));
	await Promise.all(directories.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
const fixture = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "story-mentions-"));
	directories.push(directory);
	const store = new MentionStore(directory);
	await store.open();
	const transport: MentionTransport = {
		account: vi.fn(async () => account),
		nativeAvailable: vi.fn(async () => true),
		publish: vi.fn(async () => "666"),
		close: vi.fn(async () => undefined),
		read: vi.fn(async (input) =>
			input.threadId
				? { threads: [], mentions: [candidate], cursor: null }
				: { threads: input.pending ? [] : ["999"], mentions: [], cursor: null },
		),
	};
	const queue = new SerialQueue();
	const client = { page: {}, getSessionStatus: async () => ({ state: "ready" }) };
	const profiles: RelayProfile[] = [
		{ name: "one", state: "ready", runExclusive: (task) => queue.run(() => task(client as never)) },
		{ name: "two", state: "ready", runExclusive: (task) => queue.run(() => task(client as never)) },
	];
	const options = {
		settings: { enabled: true, stateDir: directory, operationTimeoutMs: 30000 },
		profiles,
		store,
		transport: vi.fn(async () => transport),
	};
	const service = new MentionService(options);
	services.push(service);
	return { directory, store, transport, options, service, profiles };
};
const done = async (service: MentionService, id: string, kind: "refresh" | "repost") => {
	await vi.waitFor(() =>
		expect(["completed", "published", "failed", "unknown"]).toContain(service.get("one", id, kind).state),
	);
	return service.get("one", id, kind);
};
const received = async (service: MentionService) => {
	const refresh = await service.refresh("one");
	expect((await done(service, refresh.id, "refresh")).state).toBe("completed");
	const list = await service.list("one", 20);
	const mention = list.mentions[0];
	if (!mention) throw new Error("MISSING_MENTION");
	return mention;
};

describe("メンション受付・再投稿", () => {
	it("通常一覧とリクエスト一覧を読み、重複するメンションを同じ依頼に更新する", async () => {
		const f = await fixture();
		const first = await received(f.service);
		const second = await received(f.service);
		expect(first.id).toBe(second.id);
		expect(f.transport.read).toHaveBeenCalledWith({ account, pending: true });
		expect(f.transport.publish).not.toHaveBeenCalled();
		expect((await f.service.list("two", 20)).mentions).toEqual([]);
		expect(() => f.service.get("two", f.store.read().jobs[0]?.id ?? "missing", "refresh")).toThrow();
	});
	it("一覧と会話のカーソルをたどり、送信者を限定せず取得する", async () => {
		const f = await fixture();
		vi.mocked(f.transport.read).mockImplementation(async (input) => {
			if (!input.threadId)
				return {
					threads: input.pending ? [] : [input.cursor ? "998" : "999"],
					mentions: [],
					cursor: !input.pending && !input.cursor ? "inbox-next" : null,
				};
			return {
				threads: [],
				mentions:
					input.threadId === "998"
						? [{ ...candidate, threadId: "998", messageId: "887", senderId: "457", senderUsername: "another" }]
						: input.cursor
							? [candidate]
							: [],
				cursor: input.threadId === "999" && !input.cursor ? "thread-next" : null,
			};
		});
		await received(f.service);
		const page = await f.service.list("one", 1);
		expect(page.hasMore).toBe(true);
		expect((await f.service.list("one", 1, page.nextCursor ?? undefined)).mentions).toHaveLength(1);
		expect(f.transport.read).toHaveBeenCalledWith({ account, threadId: "999", cursor: "thread-next" });
	});
	it("利用不可のネイティブ方式はpublishingへ進めず、理由を返す", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		vi.mocked(f.transport.nativeAvailable).mockResolvedValue(false);
		const job = await f.service.repost("one", mention.id, "key");
		const result = await done(f.service, job.id, "repost");
		expect(result).toMatchObject({ state: "failed", errorCode: "NATIVE_REPOST_UNAVAILABLE" });
		expect(f.transport.publish).not.toHaveBeenCalled();
		expect((await f.service.repost("one", mention.id, "key")).id).toBe(job.id);
	});
	it("publishingを永続化してから公開し、新しいキーでも同じ素材を再公開しない", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		vi.mocked(f.transport.publish).mockImplementation(async () => {
			expect(f.store.read().jobs.find((j) => j.kind === "repost")?.state).toBe("publishing");
			return "666";
		});
		const jobs = await Promise.all([
			f.service.repost("one", mention.id, "a"),
			f.service.repost("one", mention.id, "b"),
		]);
		expect(jobs[0]?.id ?? "missing").toBe(jobs[1]?.id ?? "missing");
		expect((await done(f.service, jobs[0]?.id ?? "missing", "repost")).state).toBe("published");
		expect(f.transport.publish).toHaveBeenCalledOnce();
	});
	it("公開後の応答喪失はunknownとなり、再起動と新しいキーでも再公開しない", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		vi.mocked(f.transport.publish).mockRejectedValue(new Error("secret raw response"));
		const job = await f.service.repost("one", mention.id, "a");
		expect((await done(f.service, job.id, "repost")).state).toBe("unknown");
		await f.service.close();
		const reopened = new MentionStore(f.directory);
		await reopened.open();
		const service = new MentionService({ ...f.options, store: reopened });
		services.push(service);
		expect((await service.repost("one", mention.id, "b")).id).toBe(job.id);
		expect(f.transport.publish).toHaveBeenCalledOnce();
		expect(await fs.readFile(path.join(f.directory, "ledger.json"), "utf8")).not.toContain("secret raw response");
	});
	it("同じ素材の別メッセージとID表記差でも再公開しない", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		const job = await f.service.repost("one", mention.id, "original-key");
		await done(f.service, job.id, "repost");
		const otherId = "00000000-0000-4000-8000-000000000002";
		await f.store.update((data) => {
			data.mentions.push({ ...mention, id: otherId, messageId: "889", mediaId: "777" });
		});
		expect((await f.service.repost("one", otherId, "second-key")).id).toBe(job.id);
		expect(f.transport.publish).toHaveBeenCalledOnce();
	});
	it("公開直前の永続化に失敗した場合は公開しない", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		const original = f.store.update.bind(f.store);
		vi.spyOn(f.store, "update").mockImplementation(async (action) => {
			const snapshot = f.store.read();
			action(snapshot);
			if (snapshot.jobs.some((j) => j.state === "publishing")) throw new Error("disk full");
			return original(action);
		});
		const job = await f.service.repost("one", mention.id, "disk-key");
		expect((await done(f.service, job.id, "repost")).state).toBe("failed");
		expect(f.transport.publish).not.toHaveBeenCalled();
	});
	it("期限切れ・削除・権限変更・アカウント変更は公開しない", async () => {
		for (const status of ["expired", "removed", "unavailable"] as const) {
			const f = await fixture();
			const mention = await received(f.service);
			vi.mocked(f.transport.read).mockResolvedValue({
				threads: [],
				mentions: [{ ...candidate, status }],
				cursor: null,
			});
			const job = await f.service.repost("one", mention.id, "key");
			expect((await done(f.service, job.id, "repost")).errorCode).toBe("MENTION_UNAVAILABLE");
			expect(f.transport.publish).not.toHaveBeenCalled();
		}
		const f = await fixture();
		const mention = await received(f.service);
		vi.mocked(f.transport.account).mockResolvedValue({ id: "124", username: "other" });
		const job = await f.service.repost("one", mention.id, "key");
		expect((await done(f.service, job.id, "repost")).errorCode).toBe("ACCOUNT_CHANGED");
	});
	it("キーの要求変更と未指定を拒否する", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		const job = await f.service.repost("one", mention.id, "key");
		await done(f.service, job.id, "repost");
		await expect(f.service.repost("one", "another", "key")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await expect(f.service.repost("one", mention.id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});
	it("再起動時は公開途中をunknown、取得途中をfailedにする", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		const repost = await f.service.repost("one", mention.id, "restart-key");
		await done(f.service, repost.id, "repost");
		await f.store.update((data) => {
			const job = data.jobs.find((j) => j.id === repost.id);
			if (!job) throw new Error("MISSING_JOB");
			job.state = "publishing";
			const refresh = data.jobs.find((j) => j.kind === "refresh");
			if (!refresh) throw new Error("MISSING_JOB");
			refresh.state = "validating";
		});
		await f.service.close();
		const reopened = new MentionStore(f.directory);
		await reopened.open();
		expect(reopened.read().jobs.find((j) => j.id === repost.id)?.state).toBe("unknown");
		expect(reopened.read().jobs.find((j) => j.kind === "refresh")?.state).toBe("failed");
		await reopened.close();
	});
	it("途中の取得失敗では既存一覧を変更せず、セッション切れや切断は公開しない", async () => {
		const f = await fixture();
		const mention = await received(f.service);
		vi.mocked(f.transport.read).mockRejectedValue(new Error("browser disconnected"));
		const refresh = await f.service.refresh("one");
		expect((await done(f.service, refresh.id, "refresh")).state).toBe("failed");
		expect((await f.service.list("one", 20)).mentions[0]?.id).toBe(mention.id);
		const profile = f.profiles[0];
		if (!profile) throw new Error("MISSING_PROFILE");
		profile.state = "login_required";
		const job = await f.service.repost("one", mention.id, "session-key");
		expect((await done(f.service, job.id, "repost")).errorCode).toBe("SESSION_NOT_READY");
		expect(f.transport.publish).not.toHaveBeenCalled();
	});
	it("循環するカーソルは全件取得として扱わない", async () => {
		const f = await fixture();
		vi.mocked(f.transport.read).mockResolvedValue({ threads: [], mentions: [], cursor: "loop" });
		const job = await f.service.refresh("one");
		expect((await done(f.service, job.id, "refresh")).state).toBe("failed");
		expect(f.store.read().mentions).toEqual([]);
	});
	it("台帳の同時使用と破損を拒否する", async () => {
		const f = await fixture();
		const second = new MentionStore(f.directory);
		await expect(second.open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
		await f.service.close();
		await fs.writeFile(path.join(f.directory, "ledger.json"), '{"invalid":true}');
		await expect(new MentionStore(f.directory).open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
	});
	it("認証・機能無効・プロファイル指定・要求本文を検証する", async () => {
		const f = await fixture();
		const token = "a".repeat(32);
		const headers = { host: "127.0.0.1", authorization: `Bearer ${token}`, "x-profile-name": "one" };
		const app = createApp({ profiles: f.profiles, token, storyMentions: f.service });
		expect((await app.request("http://127.0.0.1/v1/story-mentions", { headers: { host: "127.0.0.1" } })).status).toBe(
			401,
		);
		expect((await app.request("http://127.0.0.1/v1/story-mentions", { headers })).status).toBe(200);
		expect(
			(
				await app.request("http://127.0.0.1/v1/story-mentions", {
					headers: { ...headers, "x-profile-name": "missing" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("http://127.0.0.1/v1/story-mentions/refresh", {
					method: "POST",
					headers,
					body: '{"audience":"close_friends"}',
				})
			).status,
		).toBe(400);
		const disabled = createApp({ profiles: f.profiles, token });
		for (const endpoint of ["story-mentions", "story-repost-jobs/test", "story-mention-refresh-jobs/test"])
			expect((await disabled.request(`http://127.0.0.1/v1/${endpoint}`, { headers })).status).toBe(503);
	});
});

describe("ブラウザ内のメンション抽出", () => {
	it("リクエスト0件以外は未検証の旧APIを呼ばず取得不可を返す", async () => {
		for (const pending of [0, 1, undefined]) {
			const get = vi.fn(async () => ({
				statusCode: 200,
				data: { viewer: { pk: "123" }, pending_requests_total: pending },
			}));
			vi.stubGlobal("window", {
				require: (name: string) =>
					name === "PolarisViewer"
						? { id: "123", data: { username: "owner" } }
						: name === "Cookie"
							? { get: () => "123" }
							: { apiGet: get },
			});
			const result = await readMentionsInBrowser({ account, pending: true });
			expect(result && "pendingUnavailable" in result && result.pendingUnavailable).toBe(pending !== 0);
			expect(get).toHaveBeenCalledExactlyOnceWith("/api/v1/direct_v2/inbox/", { query: { limit: "50" } });
		}
	});
	it("自分宛てだけを抽出し、期限切れと削除を区別して機密値を返さない", async () => {
		const share = {
			type: "mention",
			mentioned_user_id: "123",
			can_repost: true,
			media: { id: "777_456", signed_url: "secret-url", user: { username: "sender" } },
		};
		const item = { item_id: "888", user_id: "456", timestamp: "123456", reel_share: share };
		const data = {
			thread: {
				thread_id: "999",
				viewer_id: "123",
				users: [{ pk: "456", username: "sender" }],
				items: [
					item,
					{ ...item, item_id: "887", reel_share: { ...share, mentioned_user_id: "124" } },
					{ ...item, item_id: "886", reel_share: { ...share, type: "reply" } },
					{ ...item, item_id: "885", reel_share: { ...share, media: { expiring_at: 0 } } },
					{ ...item, item_id: "884", reel_share: { ...share, media: undefined } },
				],
			},
		};
		vi.stubGlobal("window", {
			require: (name: string) =>
				name === "PolarisViewer"
					? { id: "123", data: { username: "owner" } }
					: name === "Cookie"
						? { get: () => "123" }
						: { apiGet: vi.fn(async () => ({ statusCode: 200, data })) },
		});
		const result = await readMentionsInBrowser({ account, threadId: "999" });
		expect(result?.mentions.map((m) => m.status)).toEqual(["available", "expired", "removed"]);
		expect(JSON.stringify(result)).not.toContain("secret-url");
	});
});
