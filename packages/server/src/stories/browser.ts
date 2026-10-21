import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { StoryAccount, StoryFeedPostReference, StoryFeedPost } from "instagram-api-safe-contracts";
import { storyAccountSchema } from "instagram-api-safe-contracts";
import type { Page } from "playwright";
import { StoryError } from "./errors.js";
import { finalizeStoryInBrowser } from "./browser-finalize.js";
import type { StoryMedia } from "./media.js";

export type StoryPublisher = {
	getAccount: () => Promise<StoryAccount>;
	getFeedPost?: (shortcode: string) => Promise<StoryFeedPost>;
	getFeedImage?: (shortcode: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
	upload: (media: StoryMedia) => Promise<void>;
	publish: (
		account: StoryAccount,
		audience?: "all" | "close_friends",
		caption?: string,
		feedPost?: StoryFeedPostReference,
	) => Promise<string>;
	close: () => Promise<void>;
};

// 2026-10-02にログイン済みモバイルWebの配信コードとexportを確認した固定アダプター。
// 外部APIの認証値を取り出さず、Instagram自身のアップロード関数をブラウザ内で実行する。
export const createBrowserStoryPublisher = async (sourcePage: Page, signal: AbortSignal): Promise<StoryPublisher> => {
	const page = await sourcePage.context().newPage();
	const close = async () => {
		await page.close().catch(() => undefined);
	};
	const abort = () => {
		void close();
	};
	signal.addEventListener("abort", abort, { once: true });
	let uploadId = "";
	let publishRequests = 0;
	const publicationWasRequested = () => publishRequests !== 0;
	let publicationAllowed = false;
	let uploadCompleted = false;
	const check = () => {
		if (signal.aborted) throw new StoryError("UPLOAD_FAILED", "投稿処理の時間制限に達しました");
		if (new URL(page.url()).origin !== "https://www.instagram.com")
			throw new StoryError("SESSION_NOT_READY", "Instagramのセッションが必要です");
	};
	try {
		if (signal.aborted) throw new Error("ABORTED");
		const cdp = await sourcePage.context().newCDPSession(page);
		await cdp.send("Network.setUserAgentOverride", {
			userAgent:
				"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
		check();
		await page.waitForFunction(
			() => {
				const loader = (window as unknown as { require?: (name: string) => unknown }).require;
				try {
					return Boolean(loader?.("PolarisAPICreationFinalizeStory")) && Boolean(loader?.("PolarisAPIRuploadVideo"));
				} catch {
					return false;
				}
			},
			undefined,
			{ timeout: 20_000 },
		);
		// 投稿中のPOSTは、確認済みのアップロード先と公開先だけに制限する。
		await page.route("**/*", async (route) => {
			const request = route.request();
			if (request.method() !== "POST") {
				await route.continue();
				return;
			}
			const url = new URL(request.url());
			const upload =
				url.origin === "https://i.instagram.com" &&
				uploadId !== "" &&
				[
					`/rupload_igphoto/fb_uploader_${uploadId}`,
					`/rupload_igphoto/story_${uploadId}`,
					`/rupload_igvideo/story_${uploadId}`,
				].includes(url.pathname);
			const publish =
				url.origin === "https://www.instagram.com" && url.pathname === "/api/v1/media/configure_to_story/";
			if (publish && publicationAllowed && publishRequests === 0 && !signal.aborted) {
				publishRequests += 1;
				await route.continue();
			} else if (upload && !signal.aborted) await route.continue();
			else await route.abort("blockedbyclient");
		});
	} catch {
		signal.removeEventListener("abort", abort);
		await close();
		throw new StoryError("CATALOG_STALE", "投稿用モジュールまたはブラウザセッションを確認できません");
	}

	const getAccount = async (): Promise<StoryAccount> => {
		check();
		const account = await page.evaluate(() => {
			if (
				location.origin !== "https://www.instagram.com" ||
				/\/accounts\/login|\/challenge|\/checkpoint/.test(location.pathname)
			)
				return null;
			try {
				const loader = (
					window as unknown as {
						require: (name: string) => { id?: string; data?: { username?: string }; get?: (name: string) => string };
					}
				).require;
				const viewer = loader("PolarisViewer");
				if (String(viewer.id) !== loader("Cookie").get?.("ds_user_id")) return null;
				return { id: String(viewer.id ?? ""), username: viewer.data?.username ?? "" };
			} catch {
				return null;
			}
		});
		const parsed = storyAccountSchema.safeParse(account);
		if (!parsed.success || parsed.data.id === "0")
			throw new StoryError("SESSION_NOT_READY", "投稿先のログインアカウントを確認できません");
		return parsed.data;
	};

	const upload = async (media: StoryMedia): Promise<void> => {
		check();
		const bytes = await fs.readFile(media.assetPath);
		if (bytes.length !== media.size || createHash("sha256").update(bytes).digest("hex") !== media.sha256) {
			throw new StoryError("MEDIA_INVALID", "検証済み素材が変更されました");
		}
		const prepared = await page.evaluate(() => {
			try {
				const loader = (window as unknown as { require: (name: string) => Record<string, unknown> }).require;
				const functions: [string, string][] = [
					["PolarisAPICreationFinalizeStory", "creationFinalizeStory"],
					["PolarisAPIFbUploaderPhoto", "fbUploaderPhoto"],
					["PolarisAPIRuploadVideo", "ruploadVideo"],
					["PolarisAPIRuploadPhoto", "ruploadPhoto"],
					["polarisReadVideoFile", "readVideoFile"],
					["polarisGetVideoCoverPhoto", "getVideoCoverPhoto"],
				];
				if (functions.some(([module, method]) => typeof loader(module)[method] !== "function")) return null;
				const helpers = loader("PolarisUploadHelpers") as { createUploadId: () => string };
				const input = document.createElement("input");
				input.type = "file";
				input.id = "instagram-relay-story-file";
				input.hidden = true;
				document.body.append(input);
				return helpers.createUploadId();
			} catch {
				return null;
			}
		});
		if (!prepared || !/^\d{10,20}$/.test(prepared))
			throw new StoryError("CATALOG_STALE", "投稿カタログが変更されています");
		uploadId = prepared;
		check();
		// Playwrightのインメモリ転送は50MiBまで。大きい素材は検証済みローカルコピーを使う。
		await page.locator("#instagram-relay-story-file").setInputFiles(
			bytes.length > 50 * 1024 * 1024
				? media.assetPath
				: {
						name:
							media.mimeType === "video/mp4" ? "story.mp4" : media.mimeType === "image/png" ? "story.png" : "story.jpg",
						mimeType: media.mimeType,
						buffer: bytes,
					},
		);
		const result = await page.evaluate(
			async ({ uploadId, media }) => {
				// raw responseと例外はブラウザ内だけで扱う。
				type Modules = {
					fbUploaderPhoto: (
						file: File,
						progress: undefined,
						id: string,
					) => Promise<{ statusCode?: number; upload_id?: string }>;
					readVideoFile: (file: File) => Promise<HTMLVideoElement>;
					getVideoCoverPhoto: (
						video: HTMLVideoElement,
					) => Promise<{ file: Blob; uploadMediaHeight: number; uploadMediaWidth: number }>;
					ruploadVideo: (input: Record<string, unknown>) => Promise<{ statusCode?: number }>;
					ruploadPhoto: (input: Record<string, unknown>) => Promise<{ statusCode?: number }>;
					MediaPublishMode: { REEL: string };
				};
				try {
					const loader = (window as unknown as { require: (name: string) => Modules }).require;
					const file = (document.getElementById("instagram-relay-story-file") as HTMLInputElement | null)?.files?.[0];
					if (!file) return false;
					if (media.mimeType !== "video/mp4") {
						const response = await loader("PolarisAPIFbUploaderPhoto").fbUploaderPhoto(file, undefined, uploadId);
						return (
							response.upload_id === uploadId &&
							response.statusCode !== undefined &&
							response.statusCode >= 200 &&
							response.statusCode < 300
						);
					}
					const video = await loader("polarisReadVideoFile").readVideoFile(file);
					if (
						video.videoWidth !== media.width ||
						video.videoHeight !== media.height ||
						!Number.isFinite(video.duration) ||
						video.duration > 60 ||
						Math.abs(video.duration - (media.durationSeconds ?? 0)) > 0.5
					)
						return false;
					const cover = await loader("polarisGetVideoCoverPhoto").getVideoCoverPhoto(video);
					const common = { entityName: `story_${uploadId}`, uploadId };
					const uploaded = await loader("PolarisAPIRuploadVideo").ruploadVideo({
						...common,
						file,
						mediaPublishMode: loader("PolarisMediaConstants").MediaPublishMode.REEL,
						uploadMediaDurationMs: Math.floor(video.duration * 1000),
						uploadMediaHeight: video.videoHeight,
						uploadMediaWidth: video.videoWidth,
						videoTransform: null,
					});
					if (uploaded.statusCode === undefined || uploaded.statusCode < 200 || uploaded.statusCode >= 300)
						return false;
					const thumbnail = await loader("PolarisAPIRuploadPhoto").ruploadPhoto({ ...common, ...cover });
					return thumbnail.statusCode !== undefined && thumbnail.statusCode >= 200 && thumbnail.statusCode < 300;
				} catch {
					return false;
				}
			},
			{
				uploadId,
				media: {
					mimeType: media.mimeType,
					width: media.width,
					height: media.height,
					durationSeconds: media.durationSeconds,
				},
			},
		);
		if (!result) throw new StoryError("UPLOAD_FAILED", "素材のアップロードを確認できませんでした");
		check();
		// 長い動画は、アップロード受付後もInstagram側の変換処理が続く場合がある。
		// 公開要求を繰り返さず、公開前に処理時間を確保する。
		if (media.mimeType === "video/mp4" && (media.durationSeconds ?? 0) >= 30) {
			await page.waitForTimeout(30_000);
			check();
		}
		uploadCompleted = true;
	};

	const publish = async (
		account: StoryAccount,
		audience: "all" | "close_friends" = "all",
		caption = "",
	): Promise<string> => {
		check();
		if (!uploadCompleted || publicationWasRequested())
			throw new StoryError("PUBLICATION_UNKNOWN", "公開処理を再実行できません");
		const current = await getAccount();
		if (current.id !== account.id || current.username !== account.username)
			throw new StoryError("ACCOUNT_CHANGED", "投稿先アカウントが変更されています");
		publicationAllowed = true;
		let result: string | null;
		try {
			result = await page.evaluate(finalizeStoryInBrowser, { uploadId, account, audience, caption });
		} finally {
			publicationAllowed = false;
		}
		if (!result || !/^\d+$/.test(result) || publishRequests !== 1)
			throw new StoryError("PUBLICATION_UNKNOWN", "公開結果を確認できません。Instagram上で確認してください");
		return result;
	};
	return {
		getAccount,
		upload,
		publish,
		close: async () => {
			signal.removeEventListener("abort", abort);
			await close();
		},
	};
};
