import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { StoryPublisher } from "../src/stories/browser.js";
import { StoryError } from "../src/stories/errors.js";
import { IMAGE_MAX_BYTES, inspectProbe, prepareMedia, probeMedia } from "../src/stories/media.js";
import { StoryService } from "../src/stories/service.js";
import { StoryStore } from "../src/stories/store.js";
import type { RelayProfile } from "../src/types.js";
import { SerialQueue } from "../src/utils/queue.js";
import { loadSettings } from "../src/utils/settings.js";

const directories: string[] = [];
const services: StoryService[] = [];
const stores: StoryStore[] = [];
afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.close()));
	await Promise.all(stores.splice(0).map((store) => store.close()));
	await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const png = Buffer.from("89504e470d0a1a0a", "hex");
const imageProbe = async () => ({
	streams: [{ codec_type: "video", codec_name: "png", width: 1080, height: 1920 }],
	format: { format_name: "png_pipe" },
});
const temp = async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instagram-story-"));
	directories.push(directory);
	return directory;
};
const account = { id: "123", username: "owner" };
const backend = (): StoryPublisher => ({
	getAccount: vi.fn(async () => account),
	upload: vi.fn(async () => undefined),
	publish: vi.fn(async () => "999"),
	close: vi.fn(async () => undefined),
});
const fixture = async (publisher = backend()) => {
	const directory = await temp();
	const mediaDirectory = path.join(directory, "media");
	await fs.mkdir(mediaDirectory);
	const filePath = path.join(mediaDirectory, "story.png");
	await fs.writeFile(filePath, png);
	const store = new StoryStore(path.join(directory, "state"));
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
	const settings = {
		enabled: true,
		allowedMediaDirectories: [mediaDirectory],
		stateDir: store.directory,
		ffprobePath: "ffprobe",
		operationTimeoutMs: 30_000,
	};
	const factory = vi.fn(async () => publisher);
	const service = new StoryService({
		settings,
		profiles: [profile, { name: "two", state: "ready" }],
		store,
		publisher: factory,
		prepare: (file, roots, assets, id, probe) => prepareMedia(file, roots, assets, id, probe, imageProbe),
	});
	services.push(service);
	return { directory, filePath, store, service, publisher, profile, factory, settings };
};
const waitFor = async (service: StoryService, id: string) => {
	await vi.waitFor(() => expect(["published", "failed", "unknown"]).toContain(service.get("one", id).state));
	return service.get("one", id);
};

describe("素材の検証", () => {
	it("拡張子に依存せず実体形式を確認し、許可範囲外を拒否する", async () => {
		const root = await temp();
		const outside = await temp();
		const assets = path.join(root, "assets");
		const file = path.join(outside, "image.png");
		await fs.writeFile(file, png);
		await expect(prepareMedia(file, [root], assets, "test", "ffprobe", imageProbe)).rejects.toMatchObject({
			code: "MEDIA_NOT_ALLOWED",
		});
		await expect(prepareMedia("relative.png", [root], assets, "test", "ffprobe", imageProbe)).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(
			prepareMedia(path.join(root, "missing.png"), [root], assets, "test", "ffprobe", imageProbe),
		).rejects.toMatchObject({ code: "MEDIA_INVALID" });
		const invalid = path.join(root, "wrong.jpg");
		await fs.writeFile(invalid, png);
		await expect(prepareMedia(invalid, [root], assets, "test", "ffprobe", imageProbe)).rejects.toMatchObject({
			code: "MEDIA_INVALID",
		});
		await fs.writeFile(invalid, "not a JPEG");
		await expect(prepareMedia(invalid, [root], assets, "test", "ffprobe", imageProbe)).rejects.toMatchObject({
			code: "MEDIA_INVALID",
		});
	});
	it("許可範囲外を指すリンクを拒否する", async () => {
		const root = await temp();
		const outside = await temp();
		await fs.writeFile(path.join(outside, "story.png"), png);
		await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		await expect(
			prepareMedia(
				path.join(root, "linked", "story.png"),
				[root],
				path.join(root, "assets"),
				"test",
				"ffprobe",
				imageProbe,
			),
		).rejects.toMatchObject({ code: "MEDIA_NOT_ALLOWED" });
	});
	it("画像の容量超過と不正な解析結果を拒否する", async () => {
		const root = await temp();
		const file = path.join(root, "story.png");
		await fs.writeFile(file, Buffer.concat([png, Buffer.alloc(IMAGE_MAX_BYTES)]));
		await expect(
			prepareMedia(file, [root], path.join(root, "assets"), "test", "ffprobe", imageProbe),
		).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
		await fs.writeFile(file, png);
		await expect(
			prepareMedia(file, [root], path.join(root, "assets"), "test", "ffprobe", async () => ({})),
		).rejects.toMatchObject({ code: "MEDIA_INVALID" });
		expect(await fs.readdir(path.join(root, "assets"))).toEqual([]);
	});
	it("MP4のH.264/AACと1〜60秒を検証する", () => {
		const probe = {
			streams: [
				{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 },
				{ codec_type: "audio", codec_name: "aac" },
			],
			format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12" },
		};
		expect(inspectProbe(probe, "video/mp4")).toMatchObject({ durationSeconds: 12 });
		for (const duration of ["0", "61", "NaN"])
			expect(() => inspectProbe({ ...probe, format: { ...probe.format, duration } }, "video/mp4")).toThrow(StoryError);
		expect(() =>
			inspectProbe({ ...probe, streams: [{ ...probe.streams[0], codec_name: "hevc" }] }, "video/mp4"),
		).toThrow(StoryError);
	});
	it("ffprobe未導入を明確なエラーにする", async () => {
		await expect(probeMedia("unused", path.join(await temp(), "missing-ffprobe"))).rejects.toMatchObject({
			code: "MEDIA_PROBE_UNAVAILABLE",
		});
	});
});

describe("ジョブと重複防止", () => {
	it("ブラウザークライアントなしでも同じ台帳・文面・公開範囲を使う", async () => {
		const f = await fixture();
		delete f.profile.client;
		delete f.profile.runExclusive;
		const queue = new SerialQueue();
		f.profile.runMediaExclusive = (task) =>
			queue.run(() =>
				task({
					getSessionStatus: async () => ({ state: "ready" }),
					createPublisher: async () => f.publisher,
					createHighlights: async () => {
						throw new Error("対象外");
					},
				}),
			);
		const input = { filePath: f.filePath, audience: "close_friends", caption: "文面" };
		const preview = await f.service.preview("one", input);
		expect(preview.account).toEqual(account);
		expect(f.publisher.upload).not.toHaveBeenCalled();
		const job = await f.service.create("one", "http-only", input);
		expect(await waitFor(f.service, job.id)).toMatchObject({ state: "published", audience: "close_friends" });
		expect((await f.service.create("one", "http-only", input)).id).toBe(job.id);
		expect(f.publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "close_friends", "文面");
		expect(f.factory).not.toHaveBeenCalled();
	});

	it("キャプションを公開処理へ渡し、同じキーの文面変更を拒否する", async () => {
		const { service, filePath, publisher } = await fixture();
		const caption = "コメント🌸\n次の行";
		const job = await service.create("one", "caption", { filePath, audience: "close_friends", caption });
		await waitFor(service, job.id);
		expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "close_friends", caption);
		expect((await service.create("one", "caption", { filePath, audience: "close_friends", caption })).id).toBe(job.id);
		await expect(
			service.create("one", "caption", { filePath, audience: "close_friends", caption: "変更" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});
	it("キャプションの型・長さを検証し、省略と空文字では同じジョブを返す", async () => {
		const { service, filePath } = await fixture();
		for (const caption of [123, "あ".repeat(2201)]) {
			await expect(service.create("one", "invalid-caption", { filePath, caption })).rejects.toMatchObject({
				code: "INVALID_INPUT",
			});
		}
		const job = await service.create("one", "empty-caption", { filePath });
		expect((await service.create("one", "empty-caption", { filePath, caption: "" })).id).toBe(job.id);
	});
	it("キャプション付きジョブを再起動後に再公開せず、文面変更を拒否する", async () => {
		const test = await fixture();
		const input = { filePath: test.filePath, caption: "保存した文" };
		const job = await test.service.create("one", "caption-restart", input);
		await waitFor(test.service, job.id);
		await test.service.close();
		const reopened = new StoryStore(test.store.directory);
		await reopened.open();
		stores.push(reopened);
		const publisher = vi.fn(async () => backend());
		const service = new StoryService({ settings: test.settings, profiles: [test.profile], store: reopened, publisher });
		services.push(service);
		expect((await service.create("one", "caption-restart", input)).id).toBe(job.id);
		await expect(service.create("one", "caption-restart", { ...input, caption: "変更" })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		expect(publisher).not.toHaveBeenCalled();
	});
	it("親しい友達の指定を台帳と公開処理へ渡し、同じキーの公開範囲変更を拒否する", async () => {
		const { service, filePath, publisher } = await fixture();
		const job = await service.create("one", "private", { filePath, audience: "close_friends" });
		expect(job.audience).toBe("close_friends");
		await waitFor(service, job.id);
		expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "close_friends", "");
		await expect(service.create("one", "private", { filePath, audience: "all" })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
	});
	it("明示的なallと従来の要求で同じキーを再利用しても重複公開しない", async () => {
		const { service, filePath, publisher } = await fixture();
		const job = await service.create("one", "compatible", { filePath });
		const repeated = await service.create("one", "compatible", { filePath, audience: "all" });
		expect(repeated.id).toBe(job.id);
		await waitFor(service, job.id);
		expect(publisher.publish).toHaveBeenCalledTimes(1);
	});
	it("公開直前に台帳を保存し、公開の証拠がある場合だけ成功にする", async () => {
		const test = await fixture();
		vi.mocked(test.publisher.publish).mockImplementation(async () => {
			const files = await fs.readdir(path.join(test.store.directory, "jobs"));
			const entry = JSON.parse(await fs.readFile(path.join(test.store.directory, "jobs", files[0] ?? ""), "utf8"));
			expect(entry.job.state).toBe("publishing");
			return "999";
		});
		const job = await test.service.create("one", "request-1", { filePath: test.filePath });
		expect(job.state).toBe("queued");
		expect(await waitFor(test.service, job.id)).toMatchObject({ state: "published", mediaId: "999", account });
		expect(test.publisher.upload).toHaveBeenCalledOnce();
		expect(test.publisher.close).toHaveBeenCalledOnce();
	});
	it("同時の同一キーは1ジョブにまとめ、異なる要求を拒否する", async () => {
		const test = await fixture();
		const jobs = await Promise.all(
			Array.from({ length: 3 }, () => test.service.create("one", "same", { filePath: test.filePath })),
		);
		expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
		await waitFor(test.service, jobs[0]?.id ?? "");
		expect(test.publisher.publish).toHaveBeenCalledOnce();
		await expect(
			test.service.create("one", "same", { filePath: path.join(test.directory, "different.png") }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await fs.unlink(test.filePath);
		expect((await test.service.create("one", "same", { filePath: test.filePath })).id).toBe(jobs[0]?.id);
	});
	it("同じプロファイルの異なるジョブを直列化する", async () => {
		const test = await fixture();
		let release: () => void = () => undefined;
		vi.mocked(test.publisher.upload).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = await test.service.create("one", "first", { filePath: test.filePath });
		const second = await test.service.create("one", "second", { filePath: test.filePath });
		await vi.waitFor(() => expect(test.publisher.upload).toHaveBeenCalledTimes(1));
		expect(test.service.get("one", second.id).state).toBe("queued");
		release();
		await waitFor(test.service, first.id);
		await waitFor(test.service, second.id);
		expect(test.publisher.publish).toHaveBeenCalledTimes(2);
	});
	it("アップロード失敗では公開せず、公開後の応答喪失はunknownになる", async () => {
		const test = await fixture();
		vi.mocked(test.publisher.upload).mockRejectedValueOnce(new Error("private upstream details"));
		const failed = await test.service.create("one", "failed", { filePath: test.filePath });
		expect(await waitFor(test.service, failed.id)).toMatchObject({ state: "failed", errorCode: "UPLOAD_FAILED" });
		expect(test.publisher.publish).not.toHaveBeenCalled();
		vi.mocked(test.publisher.publish).mockRejectedValueOnce(new Error("page closed after sending"));
		const unknown = await test.service.create("one", "unknown", { filePath: test.filePath, audience: "close_friends" });
		expect(await waitFor(test.service, unknown.id)).toMatchObject({
			state: "unknown",
			errorCode: "PUBLICATION_UNKNOWN",
			mediaId: null,
		});
		await test.service.create("one", "unknown", { filePath: test.filePath, audience: "close_friends" });
		expect(test.publisher.publish).toHaveBeenCalledOnce();
	});
	it("投稿先の変更を検出したら公開しない", async () => {
		const test = await fixture();
		vi.mocked(test.publisher.getAccount)
			.mockResolvedValueOnce(account)
			.mockResolvedValueOnce({ id: "456", username: "other" });
		const job = await test.service.create("one", "changed", { filePath: test.filePath });
		expect(await waitFor(test.service, job.id)).toMatchObject({ state: "failed", errorCode: "ACCOUNT_CHANGED" });
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it.each(["all", "close_friends"] as const)("再起動後も%sの同じキーの結果を返して再公開しない", async (audience) => {
		const test = await fixture();
		const job = await test.service.create("one", "persistent", { filePath: test.filePath, audience });
		await waitFor(test.service, job.id);
		await test.service.close();
		const reopened = new StoryStore(test.store.directory);
		await reopened.open();
		stores.push(reopened);
		const publisher = vi.fn(async () => backend());
		const service = new StoryService({ settings: test.settings, profiles: [test.profile], store: reopened, publisher });
		services.push(service);
		expect((await service.create("one", "persistent", { filePath: test.filePath, audience })).state).toBe("published");
		expect(service.get("one", job.id).audience).toBe(audience);
		expect(publisher).not.toHaveBeenCalled();
	});
	it("audienceを持たない旧台帳を通常公開として読み、同じキーで再公開しない", async () => {
		const test = await fixture();
		const job = await test.service.create("one", "legacy", { filePath: test.filePath });
		await waitFor(test.service, job.id);
		await test.service.close();
		const file = path.join(test.store.directory, "jobs", `${job.id}.json`);
		const record = JSON.parse(await fs.readFile(file, "utf8"));
		delete record.job.audience;
		await fs.writeFile(file, JSON.stringify(record));
		const reopened = new StoryStore(test.store.directory);
		await reopened.open();
		stores.push(reopened);
		const publisher = vi.fn(async () => backend());
		const service = new StoryService({ settings: test.settings, profiles: [test.profile], store: reopened, publisher });
		services.push(service);
		expect(await service.create("one", "legacy", { filePath: test.filePath, audience: "all" })).toMatchObject({
			id: job.id,
			audience: "all",
			state: "published",
		});
		expect(publisher).not.toHaveBeenCalled();
	});
	it("再起動時はpublishingをunknown、queued/uploadingをfailedにして再送しない", async () => {
		const test = await fixture();
		for (const [index, state] of ["queued", "uploading", "publishing"].entries()) {
			const id = `00000000-0000-4000-8000-00000000000${index}`;
			const now = new Date().toISOString();
			await test.store.save({
				version: 1,
				keyHash: digest(String(index)),
				requestHash: digest("request"),
				job: {
					id,
					profile: "one",
					audience: "all",
					state: state as "queued" | "uploading" | "publishing",
					createdAt: now,
					updatedAt: now,
					account: null,
					mediaId: null,
					errorCode: null,
				},
			});
		}
		await test.service.close();
		const reopened = new StoryStore(test.store.directory);
		await reopened.open();
		stores.push(reopened);
		expect(reopened.get("00000000-0000-4000-8000-000000000002")?.job.state).toBe("unknown");
		expect(reopened.get("00000000-0000-4000-8000-000000000001")?.job.state).toBe("failed");
		expect(reopened.get("00000000-0000-4000-8000-000000000000")?.job.state).toBe("failed");
	});
	it("同じ台帳の二重起動と破損を拒否する", async () => {
		const test = await fixture();
		const second = new StoryStore(test.store.directory);
		await expect(second.open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
		await test.service.close();
		await fs.writeFile(path.join(test.store.directory, "jobs", "broken.json"), "broken");
		await expect(second.open()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
	});
	it("publishingの永続化に失敗した場合は公開しない", async () => {
		const test = await fixture();
		const save = test.store.save.bind(test.store);
		vi.spyOn(test.store, "save").mockImplementation(async (record) => {
			if (record.job.state === "publishing") throw new StoryError("STORAGE_UNAVAILABLE", "test disk failure");
			await save(record);
		});
		const job = await test.service.create("one", "disk-failure", { filePath: test.filePath });
		expect(await waitFor(test.service, job.id)).toMatchObject({ state: "failed", errorCode: "STORAGE_UNAVAILABLE" });
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it("公開成功後の台帳障害でも保存済みpublishingを残し、再起動後に再送しない", async () => {
		const test = await fixture();
		const save = test.store.save.bind(test.store);
		vi.spyOn(test.store, "save").mockImplementation(async (record) => {
			if (["published", "unknown"].includes(record.job.state))
				throw new StoryError("STORAGE_UNAVAILABLE", "test disk failure");
			await save(record);
		});
		const job = await test.service.create("one", "after-publish", { filePath: test.filePath });
		await vi.waitFor(() => expect(test.publisher.publish).toHaveBeenCalledOnce());
		await test.service.close();
		const store = new StoryStore(test.store.directory);
		await store.open();
		stores.push(store);
		expect(store.get(job.id)?.job.state).toBe("unknown");
	});
	it("処理期限または終了時の中断で、アップロード後に公開しない", async () => {
		const test = await fixture();
		let started: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		test.factory.mockImplementation(async (_page, signal) => ({
			...test.publisher,
			upload: async () => {
				started();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		}));
		const job = await test.service.create("one", "cancelled", { filePath: test.filePath });
		await ready;
		await test.service.close();
		expect(test.publisher.publish).not.toHaveBeenCalled();
		const store = new StoryStore(test.store.directory);
		await store.open();
		stores.push(store);
		expect(store.get(job.id)?.job).toMatchObject({ state: "failed", errorCode: "INTERRUPTED" });
	});
});

describe("投稿前プレビューと確認", () => {
	it("実アカウントと表示用素材を返し、確認前はアップロードも公開も行わない", async () => {
		const test = await fixture();
		const preview = await test.service.preview("one", {
			filePath: test.filePath,
			audience: "close_friends",
			caption: "private draft",
		});
		expect(preview).toMatchObject({
			profile: "one",
			account,
			audience: "close_friends",
			media: { sha256: createHash("sha256").update(png).digest("hex") },
		});
		expect(JSON.stringify(preview)).not.toContain(test.filePath);
		expect(JSON.stringify(preview)).not.toContain("private draft");
		expect(Buffer.from((await test.service.previewMedia("one", preview.id)).bytes)).toEqual(png);
		expect((await test.service.getPreview("one", preview.id)).job).toBeNull();
		expect(test.publisher.upload).not.toHaveBeenCalled();
		expect(test.publisher.publish).not.toHaveBeenCalled();
		await expect(test.service.publishPreview("one", preview.id, {})).rejects.toMatchObject({
			code: "CONFIRMATION_REQUIRED",
		});
		await expect(test.service.publishPreview("one", preview.id, { confirmed: false })).rejects.toMatchObject({
			code: "CONFIRMATION_REQUIRED",
		});
		await expect(
			test.service.publishPreview("one", preview.id, { confirmed: true, audience: "all" }),
		).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
	});
	it("キャンセル・期限切れ・別プロファイルでは公開せず、素材を削除する", async () => {
		const test = await fixture();
		const preview = await test.service.preview("one", { filePath: test.filePath });
		await expect(test.service.getPreview("two", preview.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await test.service.cancelPreview("one", preview.id);
		await test.service.cancelPreview("one", preview.id);
		await expect(test.service.publishPreview("one", preview.id, { confirmed: true })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await fs.readdir(test.store.assetDirectory)).toEqual([]);
		const expired = await test.service.preview("one", { filePath: test.filePath });
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(expired.expiresAt));
		try {
			await expect(test.service.publishPreview("one", expired.id, { confirmed: true })).rejects.toMatchObject({
				code: "PREVIEW_EXPIRED",
			});
		} finally {
			clock.mockRestore();
		}
		expect(test.publisher.upload).not.toHaveBeenCalled();
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it("原本の差し替えとプレビューコピーの改変を検出し再確認を要求する", async () => {
		const test = await fixture();
		const preview = await test.service.preview("one", { filePath: test.filePath });
		await fs.writeFile(test.filePath, Buffer.concat([png, Buffer.from("changed")]));
		await expect(test.service.publishPreview("one", preview.id, { confirmed: true })).rejects.toMatchObject({
			code: "PREVIEW_CHANGED",
		});
		const next = await test.service.preview("one", { filePath: test.filePath });
		const [name] = await fs.readdir(test.store.assetDirectory);
		await fs.writeFile(path.join(test.store.assetDirectory, name as string), "tampered");
		await expect(test.service.previewMedia("one", next.id)).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
		expect(test.publisher.upload).not.toHaveBeenCalled();
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it.each(["before_upload", "after_upload"])("確認後のアカウント変更を%sで検出して公開しない", async (phase) => {
		const test = await fixture();
		const getAccount = vi.mocked(test.publisher.getAccount);
		getAccount.mockResolvedValueOnce(account);
		if (phase === "after_upload") getAccount.mockResolvedValueOnce(account);
		getAccount.mockResolvedValue({ id: "456", username: "other" });
		const preview = await test.service.preview("one", { filePath: test.filePath });
		const job = await test.service.publishPreview("one", preview.id, { confirmed: true });
		expect(await waitFor(test.service, job.id)).toMatchObject({
			state: "failed",
			errorCode: "ACCOUNT_CHANGED",
			account,
		});
		if (phase === "before_upload") expect(test.publisher.upload).not.toHaveBeenCalled();
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it("連打は同じジョブにまとめ、受理済み操作のキャンセルは拒否する", async () => {
		const test = await fixture();
		const preview = await test.service.preview("one", {
			filePath: test.filePath,
			audience: "close_friends",
			caption: "draft",
		});
		const jobs = await Promise.all(
			Array.from({ length: 5 }, () => test.service.publishPreview("one", preview.id, { confirmed: true })),
		);
		expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
		expect((await waitFor(test.service, preview.id)).state).toBe("published");
		expect(test.publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "close_friends", "draft");
		await expect(test.service.cancelPreview("one", preview.id)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});
	it.each(["published", "unknown"])("応答喪失・再起動後も%sの同じ操作を再送しない", async (state) => {
		const test = await fixture();
		if (state === "unknown") vi.mocked(test.publisher.publish).mockRejectedValue(new Error("lost response"));
		const preview = await test.service.preview("one", { filePath: test.filePath });
		await test.service.publishPreview("one", preview.id, { confirmed: true });
		expect((await waitFor(test.service, preview.id)).state).toBe(state);
		await test.service.close();
		const store = new StoryStore(test.store.directory);
		await store.open();
		stores.push(store);
		const service = new StoryService({
			settings: test.settings,
			profiles: [test.profile],
			store,
			publisher: test.factory,
		});
		services.push(service);
		expect((await service.getPreview("one", preview.id)).job?.state).toBe(state);
		expect((await service.publishPreview("one", preview.id, { confirmed: true })).state).toBe(state);
		expect(test.publisher.publish).toHaveBeenCalledOnce();
	});
	it("確認受付の台帳保存に失敗したらアップロード・公開しない", async () => {
		const test = await fixture();
		const preview = await test.service.preview("one", { filePath: test.filePath });
		vi.spyOn(test.store, "save").mockRejectedValue(new StoryError("STORAGE_UNAVAILABLE", "disk failure"));
		await expect(test.service.publishPreview("one", preview.id, { confirmed: true })).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
		});
		expect(test.publisher.upload).not.toHaveBeenCalled();
		expect(test.publisher.publish).not.toHaveBeenCalled();
	});
	it("HTTPでプレビュー・素材・照会・取消・公開を認証し、公開要求を分離する", async () => {
		const test = await fixture();
		const token = "0123456789abcdef0123456789abcdef";
		const headers = { host: "127.0.0.1", authorization: `Bearer ${token}`, "content-type": "application/json" };
		const app = createApp({ profiles: [test.profile, { name: "two", state: "ready" }], token, stories: test.service });
		const response = await app.request("http://127.0.0.1/v1/story-previews", {
			method: "POST",
			headers: { ...headers, "x-profile-name": "one" },
			body: JSON.stringify({ filePath: test.filePath }),
		});
		expect(response.status).toBe(200);
		const { data } = await response.json();
		const route = `http://127.0.0.1/v1/story-previews/${data.id}`;
		for (const [suffix, method] of [
			["", "GET"],
			["/media", "GET"],
			["", "DELETE"],
			["/publish", "POST"],
		]) {
			expect((await app.request(route + suffix, { method, headers: { host: "127.0.0.1" } })).status).toBe(401);
			expect(
				(
					await app.request(route + suffix, {
						method,
						headers: { ...headers, "x-profile-name": "two" },
						body: method === "POST" ? JSON.stringify({ confirmed: true }) : undefined,
					})
				).status,
			).toBe(method === "DELETE" ? 200 : 404);
		}
		expect(
			(await app.request(`${route}/media`, { headers: { ...headers, "x-profile-name": "one" } })).headers.get(
				"content-type",
			),
		).toBe("image/png");
		expect(test.publisher.publish).not.toHaveBeenCalled();
		const published = await app.request(`${route}/publish`, {
			method: "POST",
			headers: { ...headers, "x-profile-name": "one" },
			body: JSON.stringify({ confirmed: true }),
		});
		expect(published.status).toBe(202);
		await waitFor(test.service, data.id);
		expect(test.publisher.publish).toHaveBeenCalledOnce();
		const disabled = createApp({ profiles: [test.profile], token });
		expect((await disabled.request(route, { headers })).status).toBe(403);
		expect((await disabled.request(route, { method: "DELETE", headers })).status).toBe(403);
	});
});

describe("HTTPと設定", () => {
	const token = "0123456789abcdef0123456789abcdef";
	const headers = {
		host: "127.0.0.1",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"idempotency-key": "http-request",
	};
	it("認証・無効化・不正JSON・キー・プロファイルを検証する", async () => {
		const test = await fixture();
		const app = createApp({ profiles: [test.profile], token, stories: test.service });
		expect(
			(await app.request("http://127.0.0.1/v1/stories", { method: "POST", headers: { host: "127.0.0.1" } })).status,
		).toBe(401);
		expect((await app.request("http://127.0.0.1/v1/story-jobs/id", { headers: { host: "127.0.0.1" } })).status).toBe(
			401,
		);
		const disabled = createApp({ profiles: [test.profile], token });
		expect((await disabled.request("http://127.0.0.1/v1/stories", { method: "POST", headers })).status).toBe(403);
		expect(
			(
				await app.request("http://127.0.0.1/v1/stories", {
					method: "POST",
					headers,
					body: JSON.stringify({ filePath: "a".repeat(9000) }),
				})
			).status,
		).toBe(413);
		expect(
			(await app.request("http://127.0.0.1/v1/stories", { method: "POST", headers, body: "invalid" })).status,
		).toBe(400);
		expect(
			(
				await app.request("http://127.0.0.1/v1/stories", {
					method: "POST",
					headers: { ...headers, "idempotency-key": "" },
					body: JSON.stringify({ filePath: test.filePath }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("http://127.0.0.1/v1/stories", {
					method: "POST",
					headers: { ...headers, "x-profile-name": "missing" },
					body: "{}",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("http://127.0.0.1/v1/stories", {
					method: "POST",
					headers,
					body: JSON.stringify({ filePath: test.filePath, overlay: "unsupported" }),
				})
			).status,
		).toBe(400);
	});
	it("HTTPの親しい友達指定を保持してジョブを受け付ける", async () => {
		const test = await fixture();
		const app = createApp({ profiles: [test.profile], token, stories: test.service });
		const response = await app.request("http://127.0.0.1/v1/stories", {
			method: "POST",
			headers,
			body: JSON.stringify({ filePath: test.filePath, audience: "close_friends" }),
		});
		expect(response.status).toBe(202);
		const { data } = await response.json();
		expect(data.audience).toBe("close_friends");
		await waitFor(test.service, data.id);
		expect(test.publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "close_friends", "");
	});
	it("202で受付し、結果にパスやキーを含めず、別プロファイルのジョブを隠す", async () => {
		const test = await fixture();
		const app = createApp({ profiles: [test.profile, { name: "two", state: "ready" }], token, stories: test.service });
		expect((await app.request("http://127.0.0.1/v1/stories", { method: "POST", headers, body: "{}" })).status).toBe(
			400,
		);
		const response = await app.request("http://127.0.0.1/v1/stories", {
			method: "POST",
			headers: { ...headers, "x-profile-name": "one" },
			body: JSON.stringify({ filePath: test.filePath }),
		});
		expect(response.status).toBe(202);
		const { data } = await response.json();
		expect(JSON.stringify(data)).not.toContain(test.filePath);
		expect(data).not.toHaveProperty("keyHash");
		await waitFor(test.service, data.id);
		expect(
			(
				await app.request(`http://127.0.0.1/v1/story-jobs/${data.id}`, {
					headers: { ...headers, "x-profile-name": "one" },
				})
			).status,
		).toBe(200);
		expect(
			(
				await app.request(`http://127.0.0.1/v1/story-jobs/${data.id}`, {
					headers: { ...headers, "x-profile-name": "two" },
				})
			).status,
		).toBe(404);
	});
	it("旧設定は投稿無効のまま、投稿有効時は許可ディレクトリとChromiumを要求する", () => {
		const profile = { name: "one", browser: { type: "launch", userDataDir: "./data" } };
		expect(loadSettings({ profiles: [profile] }).stories.enabled).toBe(false);
		expect(() => loadSettings({ profiles: [profile], stories: { enabled: true } })).toThrow();
		expect(() =>
			loadSettings({
				profiles: [{ ...profile, browser: { ...profile.browser, browserType: "firefox" } }],
				stories: { enabled: true, allowedMediaDirectories: ["./media"] },
			}),
		).toThrow();
	});
});

describe("元投稿カードの共有", () => {
	const feedPost = { shortcode: "BA", mediaId: "64", ownerId: "456" };
	const source = { ...feedPost, username: "source", width: 160, height: 90, carouselCount: 4 };
	it("元投稿と画像の読み取りにも認証を要求し、公開を開始しない", async () => {
		const publisher = {
			...backend(),
			getFeedPost: vi.fn(async () => source),
			getFeedImage: vi.fn(async () => ({ bytes: png, mimeType: "image/png" })),
		};
		const f = await fixture(publisher);
		const token = "0123456789abcdef0123456789abcdef";
		const app = createApp({ profiles: [f.profile], token, stories: f.service });
		for (const suffix of ["", "/image"]) {
			expect(
				(await app.request(`http://127.0.0.1/v1/story-feed-posts/BA${suffix}`, { headers: { host: "127.0.0.1" } }))
					.status,
			).toBe(401);
		}
		expect(publisher.getFeedPost).not.toHaveBeenCalled();
		const headers = { host: "127.0.0.1", authorization: `Bearer ${token}`, "x-profile-name": "one" };
		const response = await app.request("http://127.0.0.1/v1/story-feed-posts/BA", { headers });
		expect(await response.json()).toEqual({ data: source });
		const image = await app.request("http://127.0.0.1/v1/story-feed-posts/BA/image", { headers });
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
		expect(publisher.upload).not.toHaveBeenCalled();
		expect(publisher.publish).not.toHaveBeenCalled();
	});
	it("元投稿を照合し、異なるキーでも同じ投稿の重複を拒否する", async () => {
		const publisher = { ...backend(), supportsFeedPost: true, getFeedPost: vi.fn(async () => source) };
		const f = await fixture(publisher);
		const preview = await f.service.preview("one", { filePath: f.filePath, feedPost });
		expect(preview.feedPost).toEqual(source);
		const results = await Promise.allSettled([
			f.service.create("one", "feed-a", { filePath: f.filePath, feedPost }),
			f.service.create("one", "feed-b", { filePath: f.filePath, feedPost }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const accepted = results.find((r) => r.status === "fulfilled");
		if (accepted?.status !== "fulfilled") throw new Error("受理されたジョブが必要です");
		const job = await waitFor(f.service, accepted.value.id);
		expect(job).toMatchObject({ state: "published", feedPost });
		expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(account, "all", "", feedPost);
		expect(await f.service.create("one", "feed-a", { filePath: f.filePath, feedPost })).toMatchObject({ id: job.id });
		await expect(f.service.publishPreview("one", preview.id, { confirmed: true })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		await expect(
			f.service.create("one", "feed-a", { filePath: f.filePath, feedPost: { ...feedPost, ownerId: "987" } }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await f.service.close();
		const restored = new StoryStore(f.store.directory);
		stores.push(restored);
		await restored.open();
		expect(restored.findFeedPost("one", "64")?.job).toMatchObject({ id: job.id, state: "published", feedPost });
		const record = restored.get(job.id);
		if (!record) throw new Error("元の台帳が必要です");
		await restored.save({
			...record,
			job: { ...record.job, removal: { mediaId: "999", verifiedAt: new Date().toISOString() } },
		});
		expect(restored.findFeedPost("one", "64")).toBeUndefined();
		expect(restored.get(job.id)?.job.state).toBe("published");
	});
	it("カード用セッションが利用不可なら素材をアップロードしない", async () => {
		const publisher = {
			...backend(),
			supportsFeedPost: true,
			getFeedPost: vi.fn(async () => source),
			checkFeedPostSession: vi.fn(async () => {
				throw new StoryError("SESSION_NOT_READY", "モバイルAPI利用不可");
			}),
		};
		const f = await fixture(publisher);
		const job = await f.service.create("one", "feed-preflight", { filePath: f.filePath, feedPost });
		expect(await waitFor(f.service, job.id)).toMatchObject({ state: "failed", errorCode: "SESSION_NOT_READY" });
		expect(publisher.upload).not.toHaveBeenCalled();
		expect(publisher.publish).not.toHaveBeenCalled();
	});
	it("結果不明は明示した試験の解除注記がなければ再送せず、元の状態を保持する", async () => {
		const publisher = {
			...backend(),
			supportsFeedPost: true,
			getFeedPost: vi.fn(async () => source),
			publish: vi.fn(async () => {
				throw new StoryError("PUBLICATION_UNKNOWN", "結果不明");
			}),
		};
		const f = await fixture(publisher);
		const job = await f.service.create("one", "feed-unknown", { filePath: f.filePath, feedPost });
		expect(await waitFor(f.service, job.id)).toMatchObject({ state: "unknown" });
		await expect(f.service.create("one", "feed-again", { filePath: f.filePath, feedPost })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		const record = f.store.get(job.id);
		if (!record) throw new Error("元の台帳が必要です");
		await f.store.save({
			...record,
			job: {
				...record.job,
				retryRelease: { verifiedAt: new Date().toISOString(), reason: "no_active_story", authorization: "explicit" },
			},
		});
		expect(f.store.findFeedPost("one", "64")).toBeUndefined();
		expect(f.store.get(job.id)?.job.state).toBe("unknown");
		await f.store.save({
			...record,
			job: {
				...record.job,
				state: "published",
				retryRelease: { verifiedAt: new Date().toISOString(), reason: "no_active_story", authorization: "explicit" },
			},
		});
		expect(f.store.findFeedPost("one", "64")?.job.state).toBe("published");
	});
	it("未対応アダプター・元投稿の不一致ではアップロードしない", async () => {
		for (const publisher of [
			backend(),
			{ ...backend(), supportsFeedPost: true, getFeedPost: vi.fn(async () => ({ ...source, ownerId: "987" })) },
		]) {
			const f = await fixture(publisher);
			const job = await f.service.create("one", "feed-a", { filePath: f.filePath, feedPost });
			expect(await waitFor(f.service, job.id)).toMatchObject({ state: "failed", errorCode: "MEDIA_NOT_ALLOWED" });
			expect(publisher.upload).not.toHaveBeenCalled();
			expect(publisher.publish).not.toHaveBeenCalled();
		}
	});
});

it("投稿カードの公開フラグが無効ならアップロード前に停止する", async () => {
	const publisher = {
		...backend(),
		supportsFeedPost: false,
		getFeedPost: vi.fn(async () => ({
			shortcode: "BA",
			mediaId: "64",
			ownerId: "456",
			username: "source",
			width: 160,
			height: 90,
			carouselCount: 1,
		})),
	};
	const f = await fixture(publisher);
	const job = await f.service.create("one", "disabled-feed", {
		filePath: f.filePath,
		feedPost: { shortcode: "BA", mediaId: "64", ownerId: "456" },
	});
	expect(await waitFor(f.service, job.id)).toMatchObject({ state: "failed", errorCode: "FEED_SHARE_UNAVAILABLE" });
	expect(publisher.upload).not.toHaveBeenCalled();
	expect(publisher.publish).not.toHaveBeenCalled();
});

describe("ストーリー公開と実コメントの分離", () => {
	it("送信中を永続化し、結果不明を再送せず読み取りだけで確定する", async () => {
		let jobId = "";
		const find = vi.fn<() => Promise<string | null>>(async () => null);
		const publisher = {
			...backend(),
			resolveOwnStory: vi.fn(async () => "999"),
			findOwnStoryComment: find,
			commentOwnStory: vi.fn(async (_id: string, _text: string, _key: string, beforeSend: () => Promise<void>) => {
				await beforeSend();
				expect(f.store.get(jobId)?.job.comment?.state).toBe("sending");
				throw new Error("PRIVATE");
			}),
		};
		const f = await fixture(publisher);
		const job = await f.service.create("one", "comment-story", { filePath: f.filePath });
		jobId = job.id;
		await waitFor(f.service, job.id);
		expect(await f.service.comment("one", job.id, "comment-a", { text: "文面" })).toMatchObject({
			state: "published",
			comment: { state: "unknown" },
		});
		expect(await f.service.comment("one", job.id, "comment-b", { text: "文面" })).toMatchObject({
			comment: { state: "unknown" },
		});
		expect(publisher.commentOwnStory).toHaveBeenCalledTimes(1);
		find.mockResolvedValueOnce("777");
		expect(await f.service.comment("one", job.id, "comment-a", { text: "文面" })).toMatchObject({
			comment: { state: "completed", commentId: "777" },
		});
		expect(publisher.commentOwnStory).toHaveBeenCalledTimes(1);
		await expect(f.service.comment("one", job.id, "comment-a", { text: "別の文面" })).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		const serialized = JSON.stringify(f.store.get(job.id));
		expect(serialized).not.toContain("PRIVATE");
		expect(serialized).not.toContain("文面");
	});
	it("実公開を照合してから結果不明を回復し、元のエラーを履歴に残す", async () => {
		const publisher = {
			...backend(),
			publish: vi.fn(async () => {
				throw new StoryError("PUBLICATION_UNKNOWN", "照合待ち");
			}),
			resolveOwnStory: vi.fn(async () => "999"),
			findOwnStoryComment: vi.fn(async () => null),
			commentOwnStory: vi.fn(async (_id: string, _text: string, _key: string, beforeSend: () => Promise<void>) => {
				await beforeSend();
				return "777";
			}),
		};
		const f = await fixture(publisher);
		const job = await f.service.create("one", "legacy-caption", { filePath: f.filePath, caption: "文面" });
		await waitFor(f.service, job.id);
		await expect(f.service.comment("one", job.id, "comment-a", { text: "文面", mediaId: "888" })).rejects.toMatchObject(
			{ code: "MEDIA_NOT_ALLOWED" },
		);
		expect(f.store.get(job.id)?.job.state).toBe("unknown");
		expect(await f.service.comment("one", job.id, "comment-a", { text: "文面", mediaId: "999" })).toMatchObject({
			state: "published",
			mediaId: "999",
			recovery: { fromState: "unknown", previousErrorCode: "PUBLICATION_UNKNOWN" },
			comment: { state: "completed", commentId: "777" },
		});
		expect(publisher.publish).toHaveBeenCalledTimes(1);
		const saved = f.store.get(job.id);
		if (!saved?.job.comment) throw new Error("コメント台帳が必要です");
		await f.store.save({ ...saved, job: { ...saved.job, comment: { ...saved.job.comment, state: "sending" } } });
		await f.service.close();
		const restored = new StoryStore(f.store.directory);
		stores.push(restored);
		await restored.open();
		expect(restored.get(job.id)?.job.comment?.state).toBe("unknown");
	});
});
