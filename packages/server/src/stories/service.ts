import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
	CreateStoryInput,
	StoryFeedPost,
	StoryFeedPostReference,
	StoryAccount,
	StoryJob,
	StoryPreview,
	StoryPreviewStatus,
} from "instagram-api-safe-contracts";
import { confirmStoryInputSchema, createStoryInputSchema } from "instagram-api-safe-contracts";
import { mediaReady, withMediaSession } from "../media-session.js";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";
import type { Settings } from "../utils/settings.js";
import type { createBrowserStoryPublisher, StoryPublisher } from "./browser.js";
import { StoryError } from "./errors.js";
import { prepareMedia, type StoryMedia } from "./media.js";
import type { StoryRecord, StoryStore } from "./store.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const previewLifetimeMs = 10 * 60_000;
type PreviewEntry = { view: StoryPreview; input: CreateStoryInput; media: StoryMedia };

type ServiceOptions = {
	settings: Settings["stories"];
	profiles: RelayProfile[];
	store: StoryStore;
	prepare?: typeof prepareMedia;
	publisher?: typeof createBrowserStoryPublisher;
	onStorageError?: (id: string) => void;
};

export class StoryService {
	readonly #options: ServiceOptions;
	readonly #intake = new SerialQueue();
	readonly #tasks = new Set<Promise<void>>();
	readonly #controllers = new Set<AbortController>();
	readonly #previews = new Map<string, PreviewEntry>();
	#closing = false;
	constructor(options: ServiceOptions) {
		this.#options = options;
	}

	#profile(name: string): RelayProfile {
		if (!this.#options.settings.enabled) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
		if (this.#closing) throw new StoryError("STORAGE_UNAVAILABLE", "Relayを終了しています");
		this.#options.store.assertHealthy();
		const profile = this.#options.profiles.find((entry) => entry.name === name);
		if (!profile) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
		return profile;
	}

	async #feedReference(
		publisher: StoryPublisher,
		reference: StoryFeedPostReference | undefined,
		media: StoryMedia,
		publishing = false,
	) {
		if (!reference) return undefined;
		if (!publisher.getFeedPost)
			throw new StoryError("MEDIA_NOT_ALLOWED", "投稿カードの共有はHTTPモードのみ対応しています");
		if (media.mimeType === "video/mp4")
			throw new StoryError("MEDIA_INVALID", "投稿カードの背景は画像で指定してください");
		if (publishing && publisher.supportsFeedPost !== true)
			throw new StoryError("FEED_SHARE_UNAVAILABLE", "投稿カードの公開は未検証のため停止しています");
		if (publishing) await publisher.checkFeedPostSession?.();
		const post = await publisher.getFeedPost(reference.shortcode);
		if (post.mediaId !== reference.mediaId || post.ownerId !== reference.ownerId)
			throw new StoryError("MEDIA_NOT_ALLOWED", "元投稿のID・所有者が一致しません");
		return post;
	}
	sourcePost(
		profileName: string,
		shortcode: string,
		image = false,
	): Promise<{ post: StoryFeedPost; image?: { bytes: Uint8Array; mimeType: string } }> {
		const profile = this.#profile(profileName);
		return withMediaSession(
			profile,
			async (session) => {
				const controller = new AbortController();
				this.#controllers.add(controller);
				const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
				let publisher: StoryPublisher | undefined;
				try {
					publisher = await session.createPublisher(controller.signal);
					if (!publisher.getFeedPost || (image && !publisher.getFeedImage))
						throw new StoryError("MEDIA_NOT_ALLOWED", "投稿カードの共有はHTTPモードのみ対応しています");
					const post = await publisher.getFeedPost(shortcode);
					if (image) {
						if (!publisher.getFeedImage) throw new StoryError("MEDIA_NOT_ALLOWED", "画像の読み取りに対応していません");
						return { post, image: await publisher.getFeedImage(shortcode) };
					}
					return { post };
				} finally {
					clearTimeout(timer);
					controller.abort();
					this.#controllers.delete(controller);
					await publisher?.close().catch(() => undefined);
				}
			},
			{ publisher: this.#options.publisher },
		);
	}
	async #discard(id: string): Promise<void> {
		const entry = this.#previews.get(id);
		this.#previews.delete(id);
		if (entry) await fs.unlink(entry.media.assetPath).catch(() => undefined);
	}

	async #preview(profileName: string, id: string): Promise<PreviewEntry> {
		const entry = this.#previews.get(id);
		if (!entry || entry.view.profile !== profileName) throw new StoryError("NOT_FOUND", "プレビューが見つかりません");
		if (Date.parse(entry.view.expiresAt) <= Date.now()) {
			await this.#discard(id);
			throw new StoryError("PREVIEW_EXPIRED", "プレビューの期限が切れました。再確認してください");
		}
		return entry;
	}

	preview(profileName: string, input: unknown): Promise<StoryPreview> {
		return this.#intake.run(async () => {
			const profile = this.#profile(profileName);
			const parsed = createStoryInputSchema.safeParse(input);
			if (!parsed.success || !path.isAbsolute(parsed.data.filePath))
				throw new StoryError("INVALID_INPUT", "素材の絶対パスと任意のaudience・captionが必要です");
			for (const [id, entry] of this.#previews) {
				if (Date.parse(entry.view.expiresAt) <= Date.now()) await this.#discard(id);
			}
			if (this.#previews.size >= 20) throw new StoryError("INVALID_INPUT", "不要なプレビューをキャンセルしてください");
			if (parsed.data.feedPost && this.#options.store.findFeedPost(profileName, parsed.data.feedPost.mediaId))
				throw new StoryError("IDEMPOTENCY_CONFLICT", "この元投稿の共有はすでに受理されています");
			if (!mediaReady(profile)) throw new StoryError("SESSION_NOT_READY", "ブラウザセッションの準備ができていません");
			const id = randomUUID();
			const media = await (this.#options.prepare ?? prepareMedia)(
				parsed.data.filePath,
				this.#options.settings.allowedMediaDirectories,
				this.#options.store.assetDirectory,
				id,
				this.#options.settings.ffprobePath,
			);
			let feedPost: StoryFeedPost | undefined;
			try {
				const account = await withMediaSession(
					profile,
					async (session) => {
						const controller = new AbortController();
						this.#controllers.add(controller);
						const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
						let publisher: Awaited<ReturnType<typeof createBrowserStoryPublisher>> | undefined;
						try {
							if (this.#closing || (await session.getSessionStatus()).state !== "ready")
								throw new StoryError("SESSION_NOT_READY", "実ログインアカウントを確認できません");
							publisher = await session.createPublisher(controller.signal);
							const current = await publisher.getAccount();
							feedPost = await this.#feedReference(publisher, parsed.data.feedPost, media);
							if (controller.signal.aborted) throw new StoryError("INTERRUPTED", "プレビューを中断しました");
							return current;
						} finally {
							clearTimeout(timer);
							controller.abort();
							await publisher?.close().catch(() => undefined);
							this.#controllers.delete(controller);
						}
					},
					{ publisher: this.#options.publisher },
				);
				const { assetPath: _assetPath, ...metadata } = media;
				const view: StoryPreview = {
					id,
					profile: profileName,
					account,
					audience: parsed.data.audience,
					expiresAt: new Date(Date.now() + previewLifetimeMs).toISOString(),
					...(feedPost ? { feedPost } : {}),
					media: metadata,
				};
				this.#previews.set(id, { view, input: parsed.data, media });
				return structuredClone(view);
			} catch (error) {
				await fs.unlink(media.assetPath).catch(() => undefined);
				throw error;
			}
		});
	}

	getPreview(profileName: string, id: string): Promise<StoryPreviewStatus> {
		return this.#intake.run(async () => {
			this.#profile(profileName);
			const record = this.#options.store.get(id);
			if (record?.job.profile === profileName) return { preview: null, job: record.job };
			return { preview: structuredClone((await this.#preview(profileName, id)).view), job: null };
		});
	}

	previewMedia(profileName: string, id: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
		return this.#intake.run(async () => {
			this.#profile(profileName);
			const entry = await this.#preview(profileName, id);
			const bytes = await fs.readFile(entry.media.assetPath);
			if (createHash("sha256").update(bytes).digest("hex") !== entry.media.sha256) {
				await this.#discard(id);
				throw new StoryError("PREVIEW_CHANGED", "素材が変更されました。再確認してください");
			}
			return { bytes, mimeType: entry.media.mimeType };
		});
	}

	cancelPreview(profileName: string, id: string): Promise<void> {
		return this.#intake.run(async () => {
			this.#profile(profileName);
			if (this.#options.store.get(id)?.job.profile === profileName)
				throw new StoryError("IDEMPOTENCY_CONFLICT", "公開を受け付けた操作は中止できません。状態を照会してください");
			if (this.#previews.get(id)?.view.profile === profileName) await this.#discard(id);
		});
	}

	publishPreview(profileName: string, id: string, input: unknown): Promise<StoryJob> {
		return this.#intake.run(async () => {
			const profile = this.#profile(profileName);
			if (!confirmStoryInputSchema.safeParse(input).success)
				throw new StoryError("CONFIRMATION_REQUIRED", "プレビューへの明示確認が必要です");
			const previous = this.#options.store.get(id);
			if (previous?.job.profile === profileName) return previous.job;
			const entry = await this.#preview(profileName, id);
			if (entry.input.feedPost && this.#options.store.findFeedPost(profileName, entry.input.feedPost.mediaId))
				throw new StoryError("IDEMPOTENCY_CONFLICT", "この元投稿の共有はすでに受理されています");
			// 原本の差し替えも再確認を要求する。公開に使うのは表示済みコピーだけ。
			const current = await (this.#options.prepare ?? prepareMedia)(
				entry.input.filePath,
				this.#options.settings.allowedMediaDirectories,
				this.#options.store.assetDirectory,
				randomUUID(),
				this.#options.settings.ffprobePath,
			);
			await fs.unlink(current.assetPath).catch(() => undefined);
			if (current.sha256 !== entry.media.sha256) {
				await this.#discard(id);
				throw new StoryError("PREVIEW_CHANGED", "素材が変更されました。再確認してください");
			}
			const now = new Date().toISOString();
			const record: StoryRecord = {
				version: 1,
				keyHash: hash(`${profileName}\0${id}`),
				requestHash: hash(
					JSON.stringify({ id, account: entry.view.account, media: entry.media.sha256, input: entry.input }),
				),
				job: {
					id,
					profile: profileName,
					audience: entry.view.audience,
					state: "queued",
					createdAt: now,
					updatedAt: now,
					account: entry.view.account,
					mediaId: null,
					errorCode: null,
					...(entry.input.feedPost ? { feedPost: entry.input.feedPost } : {}),
				},
			};
			if (this.#options.store.find(record.keyHash))
				throw new StoryError("IDEMPOTENCY_CONFLICT", "操作IDはすでに使用されています");
			await this.#options.store.save(record);
			this.#previews.delete(id);
			this.#track(
				this.#execute(profile, record, entry.media, entry.input.caption, entry.view.account, entry.input.feedPost),
			);
			return record.job;
		});
	}

	#track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.then(
			() => this.#tasks.delete(task),
			() => this.#tasks.delete(task),
		);
	}

	create(profileName: string, key: string | undefined, input: unknown): Promise<StoryJob> {
		return this.#intake.run(async () => {
			if (!this.#options.settings.enabled) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
			if (this.#closing) throw new StoryError("STORAGE_UNAVAILABLE", "Relayを終了しています");
			if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
				throw new StoryError("INVALID_INPUT", "Idempotency-Keyは1〜128文字の英数字・._:-で指定してください");
			const parsed = createStoryInputSchema.safeParse(input);
			if (!parsed.success || !path.isAbsolute(parsed.data.filePath))
				throw new StoryError("INVALID_INPUT", "filePathと任意のaudience・captionを含むJSONと絶対パスが必要です");
			const profile = this.#options.profiles.find((entry) => entry.name === profileName);
			if (!profile) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
			const keyHash = hash(`${profile.name}\0${key}`);
			const requestHash = hash(
				JSON.stringify({
					profile: profile.name,
					filePath: path.normalize(parsed.data.filePath),
					// 既存の通常公開台帳と同じハッシュを維持する。
					...(parsed.data.audience === "close_friends" ? { audience: "close_friends" } : {}),
					...(parsed.data.caption !== "" ? { caption: parsed.data.caption } : {}),
					...(parsed.data.feedPost ? { feedPost: parsed.data.feedPost } : {}),
				}),
			);
			const previous = this.#options.store.find(keyHash);
			if (previous) {
				if (previous.requestHash !== requestHash)
					throw new StoryError("IDEMPOTENCY_CONFLICT", "同じキーを異なる要求に再利用できません");
				return previous.job;
			}
			if (parsed.data.feedPost && this.#options.store.findFeedPost(profileName, parsed.data.feedPost.mediaId))
				throw new StoryError("IDEMPOTENCY_CONFLICT", "この元投稿の共有はすでに受理されています");
			if (!mediaReady(profile)) throw new StoryError("SESSION_NOT_READY", "ブラウザセッションの準備ができていません");
			const id = randomUUID();
			const media = await (this.#options.prepare ?? prepareMedia)(
				parsed.data.filePath,
				this.#options.settings.allowedMediaDirectories,
				this.#options.store.assetDirectory,
				id,
				this.#options.settings.ffprobePath,
			);
			const now = new Date().toISOString();
			const record: StoryRecord = {
				version: 1,
				keyHash,
				requestHash,
				job: {
					id,
					profile: profile.name,
					audience: parsed.data.audience,
					state: "queued",
					createdAt: now,
					updatedAt: now,
					account: null,
					mediaId: null,
					errorCode: null,
					...(parsed.data.feedPost ? { feedPost: parsed.data.feedPost } : {}),
				},
			};
			try {
				await this.#options.store.save(record);
			} catch (error) {
				await fs.unlink(media.assetPath).catch(() => undefined);
				throw error;
			}
			this.#track(this.#execute(profile, record, media, parsed.data.caption, undefined, parsed.data.feedPost));
			return record.job;
		});
	}

	get(profileName: string, id: string): StoryJob {
		const record = this.#options.store.get(id);
		if (!record || record.job.profile !== profileName) throw new StoryError("NOT_FOUND", "ジョブが見つかりません");
		return record.job;
	}

	async #execute(
		profile: RelayProfile,
		initial: StoryRecord,
		media: Awaited<ReturnType<typeof prepareMedia>>,
		caption: string,
		expectedAccount?: StoryAccount,
		feedPost?: StoryFeedPostReference,
	): Promise<void> {
		let record = initial;
		const update = async (patch: Partial<StoryJob>) => {
			const next = { ...record, job: { ...record.job, ...patch, updatedAt: new Date().toISOString() } };
			await this.#options.store.save(next);
			record = next;
		};
		try {
			await withMediaSession(
				profile,
				async (session) => {
					if (this.#closing) throw new StoryError("INTERRUPTED", "Relayを終了しています");
					const controller = new AbortController();
					this.#controllers.add(controller);
					const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
					const check = () => {
						if (controller.signal.aborted) throw new StoryError("INTERRUPTED", "投稿処理が中断されました");
					};
					let publisher: Awaited<ReturnType<typeof createBrowserStoryPublisher>> | undefined;
					try {
						check();
						const status = await session.getSessionStatus();
						if (status.state !== "ready") throw new StoryError("SESSION_NOT_READY", "Instagramへのログインが必要です");
						publisher = await session.createPublisher(controller.signal);
						check();
						const account = await publisher.getAccount();
						if (expectedAccount && (expectedAccount.id !== account.id || expectedAccount.username !== account.username))
							throw new StoryError("ACCOUNT_CHANGED", "プレビューのアカウントが変更されました。再確認してください");
						await this.#feedReference(publisher, feedPost, media, true);
						await update({ state: "uploading", account });
						check();
						await publisher.upload(media);
						check();
						const current = await publisher.getAccount();
						if (current.id !== account.id || current.username !== account.username)
							throw new StoryError("ACCOUNT_CHANGED", "投稿先アカウントが変更されています");
						// 公開要求の前に必ず永続化する。ここから先の不明な結果は再送しない。
						await update({ state: "publishing" });
						check();
						const mediaId = feedPost
							? await publisher.publish(account, record.job.audience, caption, feedPost)
							: await publisher.publish(account, record.job.audience, caption);
						if (!/^\d+$/.test(mediaId)) throw new StoryError("PUBLICATION_UNKNOWN", "公開結果を確認できません");
						await update({ state: "published", mediaId });
					} finally {
						clearTimeout(timer);
						controller.abort();
						await publisher?.close().catch(() => undefined);
						this.#controllers.delete(controller);
					}
				},
				{ publisher: this.#options.publisher },
			);
		} catch (error) {
			const uncertain = record.job.state === "publishing";
			const code = uncertain ? "PUBLICATION_UNKNOWN" : error instanceof StoryError ? error.code : "UPLOAD_FAILED";
			try {
				await update({
					state: uncertain ? "unknown" : "failed",
					errorCode: code,
					...(uncertain && error instanceof StoryError && error.mediaId && /^[0-9]+$/.test(error.mediaId)
						? { mediaId: error.mediaId }
						: {}),
				});
			} catch {
				this.#options.onStorageError?.(record.job.id);
			}
		} finally {
			await fs.unlink(media.assetPath).catch(() => undefined);
		}
	}

	async close(): Promise<void> {
		this.#closing = true;
		for (const controller of this.#controllers) controller.abort();
		await this.#intake.run(async () => undefined);
		await Promise.all(this.#tasks);
		for (const id of this.#previews.keys()) await this.#discard(id);
		await this.#options.store.close();
	}
}
