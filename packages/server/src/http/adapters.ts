import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { HighlightBrowser } from "../highlights/browser.js";
import type { StoryPublisher } from "../stories/browser.js";
import { StoryError } from "../stories/errors.js";
import type { InstagramHttpClient } from "./client.js";

const execute = promisify(execFile);

export const createHttpStoryPublisher = async (
	client: InstagramHttpClient,
	signal: AbortSignal,
	ffmpegPath = "ffmpeg",
): Promise<StoryPublisher> => {
	const uploadId = `${Date.now()}${randomInt(1000, 10000)}`;
	let uploaded = false;
	let uploadAttempted = false;
	let publishAttempted = false;
	let closed = false;
	const check = () => {
		if (closed || signal.aborted) throw new StoryError("INTERRUPTED", "HTTP投稿を中断しました");
	};
	return {
		getAccount: async () => {
			check();
			return client.getAccount(signal);
		},
		upload: async (media) => {
			check();
			if (uploadAttempted) throw new StoryError("UPLOAD_FAILED", "素材のアップロードは再送しません");
			uploadAttempted = true;
			const bytes = await fs.readFile(media.assetPath);
			if (bytes.length !== media.size || createHash("sha256").update(bytes).digest("hex") !== media.sha256)
				throw new StoryError("MEDIA_INVALID", "検証済み素材が変更されました");
			if (media.mimeType === "video/mp4") {
				// 動画本体は変換せず、必要なサムネイル1枚だけを生成する。
				let thumbnail: Buffer;
				try {
					const result = await execute(
						ffmpegPath,
						["-v", "error", "-i", media.assetPath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
						{ encoding: "buffer", signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
					);
					thumbnail = result.stdout;
				} catch {
					throw new StoryError("UPLOAD_FAILED", "動画のサムネイルを生成できません");
				}
				check();
				await client.uploadVideo(uploadId, bytes, media.width, media.height, media.durationSeconds ?? 0, signal);
				await client.uploadPhoto(uploadId, thumbnail, media.width, media.height, "image/jpeg", signal);
				if ((media.durationSeconds ?? 0) >= 30) await delay(30000, undefined, { signal });
			} else await client.uploadPhoto(uploadId, bytes, media.width, media.height, media.mimeType, signal);
			check();
			uploaded = true;
		},
		publish: async (account, audience = "all", caption = "") => {
			check();
			if (!uploaded || publishAttempted)
				throw new StoryError("PUBLICATION_UNKNOWN", "未アップロードの公開・公開要求の再送を拒否しました");
			const current = await client.getAccount(signal);
			if (current.id !== account.id || current.username !== account.username)
				throw new StoryError("ACCOUNT_CHANGED", "投稿先アカウントが変わりました");
			publishAttempted = true;
			return client.publish(uploadId, account, audience, caption, signal);
		},
		close: async () => {
			closed = true;
		},
	};
};

export const createHttpHighlights = async (
	client: InstagramHttpClient,
	signal: AbortSignal,
): Promise<HighlightBrowser> => {
	let closed = false;
	let saveAttempted = false;
	const check = () => {
		if (closed || signal.aborted) throw new StoryError("INTERRUPTED", "ハイライト操作を中断しました");
	};
	return {
		list: async () => {
			check();
			return client.listHighlights(signal);
		},
		add: async (highlight, mediaId, account, beforeSave) => {
			check();
			const own = await client.listHighlights(signal);
			if (own.account.id !== account.id || own.account.username !== account.username)
				throw new StoryError("ACCOUNT_CHANGED", "投稿時のアカウントと一致しません");
			if (!own.highlights.some((item) => item.id === highlight.id && item.title === highlight.title))
				throw new StoryError("NOT_FOUND", "指定した既存ハイライトが見つかりません");
			const before = await client.highlightItems(highlight.id, signal);
			if (before.includes(mediaId)) return true;
			const current = await client.getAccount(signal);
			if (current.id !== account.id || current.username !== account.username)
				throw new StoryError("ACCOUNT_CHANGED", "登録前にアカウントが変わりました");
			if (saveAttempted) throw new StoryError("PUBLICATION_UNKNOWN", "ハイライト登録は再送しません");
			check();
			await beforeSave();
			check();
			saveAttempted = true;
			await client.addHighlightStory(highlight.id, mediaId, signal);
			const after = await client.highlightItems(highlight.id, signal);
			if (
				!after.includes(mediaId) ||
				!before.every((id) => after.includes(id)) ||
				after.length !== new Set([...before, mediaId]).size
			)
				throw new StoryError("PUBLICATION_UNKNOWN", "登録後の選択を確認できません。再登録しません");
			return false;
		},
		close: async () => {
			closed = true;
		},
	};
};
