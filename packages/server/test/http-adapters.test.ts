import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpHighlights, createHttpStoryPublisher } from "../src/http/adapters.js";
import type { InstagramHttpClient } from "../src/http/client.js";
import { StoryError } from "../src/stories/errors.js";
import type { StoryMedia } from "../src/stories/media.js";
import { loadSettings } from "../src/utils/settings.js";

const account = { id: "123", username: "owner" };
const highlight = { id: "456", title: "保存先" };
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
const fake = () => ({
	getAccount: vi.fn(async () => account),
	getMobileAccount: vi.fn(async () => account),
	uploadPhoto: vi.fn(async () => undefined),
	uploadVideo: vi.fn(async () => undefined),
	publish: vi.fn(async () => "999"),
	listHighlights: vi.fn(async () => ({ account, highlights: [highlight] })),
	highlightItems: vi.fn<() => Promise<string[]>>(async () => ["100"]),
	addHighlightStory: vi.fn(async () => undefined),
});
const signal = () => new AbortController().signal;

describe("HTTP投稿アダプター", () => {
	it("文面なし動画もアップロード前にモバイル認証を確認し、失敗時は素材を送らない", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-video-preflight-"));
		dirs.push(dir);
		const assetPath = path.join(dir, "video.mp4");
		const bytes = Buffer.from("video");
		await fs.writeFile(assetPath, bytes);
		const client = fake();
		client.getMobileAccount.mockRejectedValueOnce(new StoryError("SESSION_NOT_READY", "モバイル認証が必要です"));
		const publisher = await createHttpStoryPublisher(client as unknown as InstagramHttpClient, signal());
		await expect(
			publisher.upload({
				assetPath,
				mimeType: "video/mp4",
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				width: 720,
				height: 1280,
				durationSeconds: 15,
			}),
		).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
		expect(client.getMobileAccount).toHaveBeenCalledTimes(1);
		expect(client.uploadVideo).not.toHaveBeenCalled();
		expect(client.uploadPhoto).not.toHaveBeenCalled();
		expect(client.publish).not.toHaveBeenCalled();
	});
	it("投稿時コメントの前にモバイルの実アカウントを照合する", async () => {
		const client = fake();
		const publisher = await createHttpStoryPublisher(client as unknown as InstagramHttpClient, signal());
		expect(publisher.supportsStoryCaption).toBe(true);
		await publisher.checkStoryCaptionSession?.();
		expect(client.getMobileAccount).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
		await expect(publisher.publish(account, "close_friends", "文面")).rejects.toMatchObject({
			code: "PUBLICATION_UNKNOWN",
		});
		expect(client.uploadPhoto).not.toHaveBeenCalled();
		expect(client.publish).not.toHaveBeenCalled();
	});
	it("素材が変わればアップロードせず、公開要求を再送しない", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ig-adapter-"));
		dirs.push(dir);
		const assetPath = path.join(dir, "image.jpg");
		const bytes = Buffer.from("image");
		await fs.writeFile(assetPath, bytes);
		const media: StoryMedia = {
			assetPath,
			mimeType: "image/jpeg",
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			width: 720,
			height: 1280,
			durationSeconds: null,
		};
		const client = fake();
		const publisher = await createHttpStoryPublisher(client as unknown as InstagramHttpClient, signal());
		await expect(publisher.publish(account)).rejects.toMatchObject({ code: "PUBLICATION_UNKNOWN" });
		await publisher.upload(media);
		client.publish.mockRejectedValueOnce(new StoryError("PUBLICATION_UNKNOWN", "応答喪失"));
		await expect(publisher.publish(account, "close_friends")).rejects.toMatchObject({
			code: "PUBLICATION_UNKNOWN",
		});
		await expect(publisher.publish(account, "close_friends")).rejects.toMatchObject({
			code: "PUBLICATION_UNKNOWN",
		});
		expect(client.publish).toHaveBeenCalledTimes(1);
		const other = await createHttpStoryPublisher(client as unknown as InstagramHttpClient, signal());
		await fs.writeFile(assetPath, "changed");
		await expect(other.upload(media)).rejects.toMatchObject({ code: "MEDIA_INVALID" });
		expect(client.uploadPhoto).toHaveBeenCalledTimes(1);
	});
	it("既存選択を維持し、台帳保存後に一度だけハイライトへ追加する", async () => {
		const client = fake();
		client.highlightItems.mockResolvedValueOnce(["100"]).mockResolvedValueOnce(["100", "999"]);
		const adapter = await createHttpHighlights(client as unknown as InstagramHttpClient, signal());
		const save = vi.fn(async () => {
			expect(client.addHighlightStory).not.toHaveBeenCalled();
		});
		expect(await adapter.add(highlight, "999", account, save)).toBe(false);
		expect(save).toHaveBeenCalledTimes(1);
		expect(client.addHighlightStory).toHaveBeenCalledExactlyOnceWith("456", "999", expect.any(AbortSignal), "保存先");
	});
	it("登録済みなら保存を省き、保存後に選択が欠けたら結果不明にする", async () => {
		const client = fake();
		client.highlightItems.mockResolvedValueOnce(["999"]);
		const adapter = await createHttpHighlights(client as unknown as InstagramHttpClient, signal(), async () => {});
		const save = vi.fn();
		expect(await adapter.add(highlight, "999", account, save)).toBe(true);
		expect(save).not.toHaveBeenCalled();
		expect(client.addHighlightStory).not.toHaveBeenCalled();
		client.highlightItems.mockResolvedValueOnce(["100"]).mockResolvedValueOnce(["999"]);
		await expect(adapter.add(highlight, "999", account, save)).rejects.toMatchObject({ code: "PUBLICATION_UNKNOWN" });
	});
	it("反映遅延時は読み取りだけを再試行し、保存要求を再送しない", async () => {
		const client = fake();
		client.highlightItems.mockResolvedValueOnce(["100"]).mockResolvedValueOnce(["100"]).mockResolvedValueOnce(["100", "999"]);
		const wait = vi.fn(async () => {});
		const adapter = await createHttpHighlights(client as unknown as InstagramHttpClient, signal(), wait);
		expect(await adapter.add(highlight, "999", account, vi.fn(async () => {}))).toBe(false);
		expect(client.addHighlightStory).toHaveBeenCalledTimes(1);
		expect(client.highlightItems).toHaveBeenCalledTimes(3);
		expect(wait).toHaveBeenCalledTimes(1);
	});
	it("既存項目が欠けたままなら詳細を残して結果不明とし、保存を再送しない", async () => {
		const client = fake();
		client.highlightItems.mockResolvedValueOnce(["100"]).mockResolvedValue(["999"]);
		const wait = vi.fn(async () => {});
		const adapter = await createHttpHighlights(client as unknown as InstagramHttpClient, signal(), wait);
		await expect(adapter.add(highlight, "999", account, vi.fn(async () => {}))).rejects.toThrow(
			"targetPresent=true, missingCount=1, expectedCount=2, actualCount=1",
		);
		expect(client.addHighlightStory).toHaveBeenCalledTimes(1);
		expect(client.highlightItems).toHaveBeenCalledTimes(4);
		expect(wait).toHaveBeenCalledTimes(2);
	});
	it("HTTPモードはブラウザー設定なしで使え、DMの誤用を拒否する", () => {
		const profiles = [{ name: "http", browser: { type: "http", sessionFile: "/private/session.json" } }];
		expect(loadSettings({ profiles }).profiles[0]?.browser.type).toBe("http");
		expect(() => loadSettings({ profiles, direct: { enabled: true } })).toThrow();
	});
});
