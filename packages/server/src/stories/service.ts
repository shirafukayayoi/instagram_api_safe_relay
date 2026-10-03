import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StoryJob } from "instagram-api-safe-contracts";
import { createStoryInputSchema } from "instagram-api-safe-contracts";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";
import type { Settings } from "../utils/settings.js";
import { createBrowserStoryPublisher } from "./browser.js";
import { StoryError } from "./errors.js";
import { prepareMedia } from "./media.js";
import type { StoryRecord, StoryStore } from "./store.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

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
	#closing = false;
	constructor(options: ServiceOptions) {
		this.#options = options;
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
				}),
			);
			const previous = this.#options.store.find(keyHash);
			if (previous) {
				if (previous.requestHash !== requestHash)
					throw new StoryError("IDEMPOTENCY_CONFLICT", "同じキーを異なる要求に再利用できません");
				return previous.job;
			}
			if (profile.state !== "ready" || !profile.client || !profile.runExclusive)
				throw new StoryError("SESSION_NOT_READY", "ブラウザセッションの準備ができていません");
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
				},
			};
			try {
				await this.#options.store.save(record);
			} catch (error) {
				await fs.unlink(media.assetPath).catch(() => undefined);
				throw error;
			}
			const task = this.#execute(profile, record, media, parsed.data.caption);
			this.#tasks.add(task);
			void task.then(
				() => this.#tasks.delete(task),
				() => this.#tasks.delete(task),
			);
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
	): Promise<void> {
		let record = initial;
		const update = async (patch: Partial<StoryJob>) => {
			const next = { ...record, job: { ...record.job, ...patch, updatedAt: new Date().toISOString() } };
			await this.#options.store.save(next);
			record = next;
		};
		try {
			if (!profile.runExclusive) throw new StoryError("SESSION_NOT_READY", "プロファイルの実行キューがありません");
			await profile.runExclusive(async (client) => {
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
					const session = await client.getSessionStatus();
					if (session.state !== "ready") throw new StoryError("SESSION_NOT_READY", "Instagramへのログインが必要です");
					publisher = await (this.#options.publisher ?? createBrowserStoryPublisher)(client.page, controller.signal);
					check();
					const account = await publisher.getAccount();
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
					const mediaId = await publisher.publish(account, record.job.audience, caption);
					if (!/^\d+$/.test(mediaId)) throw new StoryError("PUBLICATION_UNKNOWN", "公開結果を確認できません");
					await update({ state: "published", mediaId });
				} finally {
					clearTimeout(timer);
					controller.abort();
					await publisher?.close().catch(() => undefined);
					this.#controllers.delete(controller);
				}
			});
		} catch (error) {
			const uncertain = record.job.state === "publishing";
			const code = uncertain ? "PUBLICATION_UNKNOWN" : error instanceof StoryError ? error.code : "UPLOAD_FAILED";
			try {
				await update({ state: uncertain ? "unknown" : "failed", errorCode: code });
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
		await this.#options.store.close();
	}
}
