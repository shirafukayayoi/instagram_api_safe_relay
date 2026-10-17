import { createHash, randomUUID } from "node:crypto";
import { addHighlightStorySchema, type HighlightJob } from "instagram-api-safe-contracts";
import { mediaReady, withMediaSession } from "../media-session.js";
import { StoryError } from "../stories/errors.js";
import type { StoryService } from "../stories/service.js";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";
import type { Settings } from "../utils/settings.js";
import type { createHighlightBrowser } from "./browser.js";
import type { HighlightRecord, HighlightStore } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Options = {
	settings: Settings["stories"];
	profiles: RelayProfile[];
	stories: Pick<StoryService, "get">;
	store: HighlightStore;
	browser?: typeof createHighlightBrowser;
};

export class HighlightService {
	readonly #options: Options;
	readonly #intake = new SerialQueue();
	readonly #tasks = new Set<Promise<void>>();
	readonly #controllers = new Set<AbortController>();
	#closing = false;
	constructor(options: Options) {
		this.#options = options;
	}
	#profile(name: string) {
		if (!this.#options.settings.enabled) throw new StoryError("STORIES_DISABLED", "ハイライト操作は無効です");
		if (this.#closing) throw new StoryError("INTERRUPTED", "Relayを終了しています");
		this.#options.store.assertHealthy();
		const profile = this.#options.profiles.find((item) => item.name === name);
		if (!profile) throw new StoryError("UNKNOWN_PROFILE", "プロファイルが見つかりません");
		if (!mediaReady(profile)) throw new StoryError("SESSION_NOT_READY", "ブラウザの準備ができていません");
		return profile;
	}
	async #browser<T>(
		profile: RelayProfile,
		action: (browser: Awaited<ReturnType<typeof createHighlightBrowser>>) => Promise<T>,
	): Promise<T> {
		return withMediaSession(
			profile,
			async (session) => {
				const controller = new AbortController();
				this.#controllers.add(controller);
				const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
				let browser: Awaited<ReturnType<typeof createHighlightBrowser>> | undefined;
				try {
					if (this.#closing || (await session.getSessionStatus()).state !== "ready")
						throw new StoryError("SESSION_NOT_READY", "Instagramへのログインが必要です");
					browser = await session.createHighlights(controller.signal);
					return await action(browser);
				} finally {
					clearTimeout(timer);
					controller.abort();
					await browser?.close();
					this.#controllers.delete(controller);
				}
			},
			{ highlights: this.#options.browser },
		);
	}
	list(name: string) {
		return this.#browser(this.#profile(name), (browser) => browser.list());
	}
	create(name: string, highlightId: string, key: string | undefined, input: unknown): Promise<HighlightJob> {
		return this.#intake.run(async () => {
			const profile = this.#profile(name);
			const parsed = addHighlightStorySchema.safeParse(input);
			if (!parsed.success || !/^\d+$/.test(highlightId) || !key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
				throw new StoryError("INVALID_INPUT", "ハイライトID、公開済みstoryJobId、Idempotency-Keyが必要です");
			const keyHash = hash(`${name}\0${key}`);
			const requestHash = hash(JSON.stringify({ name, highlightId, ...parsed.data }));
			const previous = this.#options.store.find(keyHash);
			if (previous) {
				if (previous.requestHash !== requestHash)
					throw new StoryError("IDEMPOTENCY_CONFLICT", "同じキーを別の要求に使用できません");
				return previous.job;
			}
			const story = this.#options.stories.get(name, parsed.data.storyJobId);
			if (story.state !== "published" || !story.mediaId || !story.account)
				throw new StoryError("INVALID_INPUT", "公開完了を確認したストーリーだけ追加できます");
			// 別のキーでも、同じ投稿と登録先を二重に処理しない。
			const same = this.#options.store.forTarget(name, highlightId, story.mediaId);
			if (same) {
				await this.#options.store.save({ ...same, aliases: [...same.aliases, { keyHash, requestHash }] });
				return same.job;
			}
			const own = await this.list(name);
			if (own.account.id !== story.account.id || own.account.username !== story.account.username)
				throw new StoryError("ACCOUNT_CHANGED", "投稿時のアカウントと一致しません");
			const highlight = own.highlights.find((item) => item.id === highlightId);
			if (!highlight) throw new StoryError("NOT_FOUND", "自分のハイライトが見つかりません");
			const now = new Date().toISOString();
			const record: HighlightRecord = {
				version: 1,
				keyHash,
				requestHash,
				aliases: [],
				job: {
					id: randomUUID(),
					profile: name,
					highlight,
					storyJobId: story.id,
					mediaId: story.mediaId,
					account: story.account,
					audience: story.audience,
					state: "queued",
					alreadyPresent: null,
					errorCode: null,
					createdAt: now,
					updatedAt: now,
				},
			};
			await this.#options.store.save(record);
			const task = this.#execute(profile, record);
			this.#tasks.add(task);
			void task.finally(() => this.#tasks.delete(task));
			return record.job;
		});
	}
	get(name: string, id: string) {
		const record = this.#options.store.get(id);
		if (!record || record.job.profile !== name) throw new StoryError("NOT_FOUND", "ハイライトジョブが見つかりません");
		return record.job;
	}
	async #execute(profile: RelayProfile, initial: HighlightRecord) {
		let record = initial;
		const update = async (patch: Partial<HighlightJob>) => {
			const next = { ...record, job: { ...record.job, ...patch, updatedAt: new Date().toISOString() } };
			await this.#options.store.save(next);
			record = next;
		};
		try {
			const present = await this.#browser(profile, (browser) =>
				browser.add(record.job.highlight, record.job.mediaId, record.job.account, async () => {
					await update({ state: "applying" });
				}),
			);
			await update({ state: "completed", alreadyPresent: present });
		} catch (error) {
			const uncertain = record.job.state === "applying";
			await update({
				state: uncertain ? "unknown" : "failed",
				errorCode: uncertain ? "PUBLICATION_UNKNOWN" : error instanceof StoryError ? error.code : "CATALOG_STALE",
			}).catch(() => undefined);
		}
	}
	async close() {
		this.#closing = true;
		for (const controller of this.#controllers) controller.abort();
		await this.#intake.run(async () => undefined);
		await Promise.all(this.#tasks);
		await this.#options.store.close();
	}
}
