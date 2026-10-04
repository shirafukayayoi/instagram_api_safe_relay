import { createHash, randomUUID } from "node:crypto";
import type { StoryMentionJob } from "instagram-api-safe-contracts";
import type { RelayProfile } from "../types.js";
import type { Settings } from "../utils/settings.js";
import { createMentionTransport, type MentionTransport } from "./browser.js";
import { MentionError, type MentionStore } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Options = {
	settings: Settings["storyMentions"];
	profiles: RelayProfile[];
	store: MentionStore;
	transport?: typeof createMentionTransport;
};
export class MentionService {
	readonly #options: Options;
	readonly #tasks = new Set<Promise<void>>();
	readonly #controllers = new Set<AbortController>();
	#closing = false;
	constructor(options: Options) {
		this.#options = options;
	}
	#profile(name: string) {
		if (!this.#options.settings.enabled) throw new MentionError("MENTIONS_DISABLED", "メンション受付は無効です");
		if (this.#closing) throw new MentionError("STORAGE_UNAVAILABLE", "Relayを終了しています");
		const profile = this.#options.profiles.find((p) => p.name === name);
		if (!profile) throw new MentionError("UNKNOWN_PROFILE", "プロファイルが見つかりません");
		return profile;
	}
	async #run<T>(profile: RelayProfile, action: (transport: MentionTransport) => Promise<T>) {
		if (profile.state !== "ready" || !profile.runExclusive)
			throw new MentionError("SESSION_NOT_READY", "ブラウザの準備ができていません");
		return profile.runExclusive(async (client) => {
			if ((await client.getSessionStatus()).state !== "ready" || this.#closing)
				throw new MentionError("SESSION_NOT_READY", "ログインが必要です");
			const controller = new AbortController();
			this.#controllers.add(controller);
			const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
			let transport: MentionTransport | undefined;
			try {
				transport = await (this.#options.transport ?? createMentionTransport)(client.page, controller.signal);
				return await action(transport);
			} finally {
				clearTimeout(timer);
				controller.abort();
				await transport?.close().catch(() => undefined);
				this.#controllers.delete(controller);
			}
		});
	}
	#launch(task: Promise<void>) {
		this.#tasks.add(task);
		void task.then(
			() => this.#tasks.delete(task),
			() => this.#tasks.delete(task),
		);
	}
	#newJob(profile: string, kind: "refresh" | "repost", mentionId: string | null): StoryMentionJob {
		const now = new Date().toISOString();
		return {
			id: randomUUID(),
			profile,
			kind,
			mentionId,
			account: null,
			state: "queued",
			createdAt: now,
			updatedAt: now,
			mediaId: null,
			count: 0,
			errorCode: null,
		};
	}
	async #patch(id: string, patch: Partial<StoryMentionJob>) {
		await this.#options.store.update((data) => {
			const job = data.jobs.find((j) => j.id === id);
			if (!job) throw new Error("MISSING_JOB");
			Object.assign(job, patch, { updatedAt: new Date().toISOString() });
		});
	}
	get(profile: string, id: string, kind: "refresh" | "repost") {
		this.#profile(profile);
		const job = this.#options.store.read().jobs.find((j) => j.id === id && j.profile === profile && j.kind === kind);
		if (!job) throw new MentionError("NOT_FOUND", "ジョブが見つかりません");
		return job;
	}
	async list(profile: string, limit: number, cursor?: string) {
		const selected = this.#profile(profile);
		if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor && !/^[0-9a-f-]{36}$/.test(cursor)))
			throw new MentionError("INVALID_INPUT", "ページ指定が不正です");
		const account = await this.#run(selected, (t) => t.account());
		const mentions = this.#options.store
			.read()
			.mentions.filter((m) => m.profile === profile && m.account.id === account.id)
			.sort((a, b) => a.id.localeCompare(b.id));
		const position = cursor ? mentions.findIndex((m) => m.id === cursor) : -1;
		if (cursor && position === -1) throw new MentionError("INVALID_INPUT", "カーソルが見つかりません");
		const page = mentions.slice(position + 1, position + 1 + limit);
		const hasMore = position + 1 + limit < mentions.length;
		return {
			account,
			mentions: page,
			hasMore,
			nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
			nativeRepostAvailable: false,
		};
	}
	async refresh(name: string) {
		const profile = this.#profile(name);
		const job = this.#newJob(name, "refresh", null);
		const result = await this.#options.store.update((data) => {
			const active = data.jobs.find(
				(j) => j.profile === name && j.kind === "refresh" && ["queued", "validating"].includes(j.state),
			);
			if (active) return active;
			data.jobs.push(job);
			return job;
		});
		if (result.id === job.id) this.#launch(this.#refresh(profile, job));
		return result;
	}
	async #refresh(profile: RelayProfile, job: StoryMentionJob) {
		try {
			await this.#run(profile, async (transport) => {
				const account = await transport.account();
				await this.#patch(job.id, { state: "validating", account });
				const candidates = new Map<string, Awaited<ReturnType<MentionTransport["read"]>>["mentions"][number]>();
				const threads = new Set<string>();
				for (const pending of [false, true]) {
					let cursor: string | undefined;
					const cursors = new Set<string>();
					do {
						const page = await transport.read({ account, pending, ...(cursor ? { cursor } : {}) });
						for (const id of page.threads) threads.add(id);
						cursor = page.cursor ?? undefined;
						if (cursor) {
							if (cursors.has(cursor)) throw new MentionError("UPSTREAM_CHANGED", "一覧カーソルが循環しています");
							cursors.add(cursor);
						}
					} while (cursor);
				}
				for (const threadId of threads) {
					let cursor: string | undefined;
					const cursors = new Set<string>();
					do {
						const page = await transport.read({ account, threadId, ...(cursor ? { cursor } : {}) });
						for (const mention of page.mentions) candidates.set(`${mention.threadId}:${mention.messageId}`, mention);
						cursor = page.cursor ?? undefined;
						if (cursor) {
							if (cursors.has(cursor)) throw new MentionError("UPSTREAM_CHANGED", "会話カーソルが循環しています");
							cursors.add(cursor);
						}
					} while (cursor);
				}
				const current = await transport.account();
				if (current.id !== account.id || current.username !== account.username)
					throw new MentionError("ACCOUNT_CHANGED", "取得中にアカウントが変更されました");
				await this.#options.store.update((data) => {
					const now = new Date().toISOString();
					for (const mention of candidates.values()) {
						const existing = data.mentions.find(
							(m) =>
								m.profile === profile.name &&
								m.account.id === account.id &&
								m.threadId === mention.threadId &&
								m.messageId === mention.messageId,
						);
						if (existing) Object.assign(existing, mention, { updatedAt: now });
						else data.mentions.push({ ...mention, id: randomUUID(), profile: profile.name, updatedAt: now });
					}
					for (const existing of data.mentions)
						if (
							existing.profile === profile.name &&
							existing.account.id === account.id &&
							!candidates.has(`${existing.threadId}:${existing.messageId}`)
						)
							Object.assign(existing, { status: "unknown", reason: "UNVERIFIED", updatedAt: now });
				});
				await this.#patch(job.id, { state: "completed", count: candidates.size });
			});
		} catch (error) {
			await this.#patch(job.id, {
				state: "failed",
				errorCode: error instanceof MentionError ? error.code : "UPSTREAM_CHANGED",
			}).catch(() => undefined);
		}
	}
	async repost(name: string, mentionId: string, key?: string) {
		const profile = this.#profile(name);
		if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
			throw new MentionError("INVALID_INPUT", "Idempotency-Keyが必要です");
		const job = this.#newJob(name, "repost", mentionId);
		const result = await this.#options.store.update((data) => {
			const keyHash = hash(`${name}\0${key}`),
				requestHash = hash(JSON.stringify({ profile: name, mentionId, audience: "all" }));
			const existing = data.keys[keyHash];
			if (existing) {
				if (existing.requestHash !== requestHash)
					throw new MentionError("IDEMPOTENCY_CONFLICT", "キーが別の要求に使われています");
				return data.jobs.find((j) => j.id === existing.jobId) as StoryMentionJob;
			}
			const mention = data.mentions.find((m) => m.id === mentionId && m.profile === name);
			if (!mention) throw new MentionError("NOT_FOUND", "依頼が見つかりません");
			if (!mention.mediaId || mention.status !== "available")
				throw new MentionError("MENTION_UNAVAILABLE", "再投稿可能な依頼ではありません");
			const source = hash(`${name}\0${mention.account.id}\0${mention.mediaId.split("_")[0]}`);
			if (data.sources[source]) {
				const prior = data.jobs.find((j) => j.id === data.sources[source]) as StoryMentionJob;
				data.keys[keyHash] = { requestHash, jobId: prior.id };
				return prior;
			}
			job.account = mention.account;
			data.sources[source] = job.id;
			data.keys[keyHash] = { requestHash, jobId: job.id };
			data.jobs.push(job);
			return job;
		});
		if (result.id === job.id) this.#launch(this.#repost(profile, job));
		return result;
	}
	async #repost(profile: RelayProfile, job: StoryMentionJob) {
		try {
			await this.#run(profile, async (transport) => {
				const mention = this.#options.store.read().mentions.find((m) => m.id === job.mentionId);
				const account = await transport.account();
				if (!mention || mention.account.id !== account.id || mention.account.username !== account.username)
					throw new MentionError("ACCOUNT_CHANGED", "投稿先アカウントが変わりました");
				await this.#patch(job.id, { state: "validating", account });
				let cursor: string | undefined;
				const cursors = new Set<string>();
				let found = false;
				do {
					const page = await transport.read({ account, threadId: mention.threadId, ...(cursor ? { cursor } : {}) });
					const fresh = page.mentions.find((m) => m.messageId === mention.messageId);
					if (fresh) {
						if (
							fresh.mediaId !== mention.mediaId ||
							fresh.status !== "available" ||
							fresh.senderId !== mention.senderId
						)
							throw new MentionError("MENTION_UNAVAILABLE", "元ストーリーの状態が変わりました");
						found = true;
						break;
					}
					cursor = page.cursor ?? undefined;
					if (cursor) {
						if (cursors.has(cursor)) throw new MentionError("UPSTREAM_CHANGED", "会話カーソルが循環しています");
						cursors.add(cursor);
					}
				} while (cursor);
				if (!found) throw new MentionError("MENTION_UNAVAILABLE", "元のメンションがありません");
				if (!(await transport.nativeAvailable()))
					throw new MentionError("NATIVE_REPOST_UNAVAILABLE", "元投稿への参照を維持する公開方式は未検証です");
				const current = await transport.account();
				if (current.id !== account.id || current.username !== account.username || this.#closing)
					throw new MentionError("ACCOUNT_CHANGED", "公開直前にアカウントが変わりました");
				await this.#patch(job.id, { state: "publishing" });
				const mediaId = await transport.publish(mention);
				if (!/^\d{1,80}$/.test(mediaId)) throw new MentionError("PUBLICATION_UNKNOWN", "公開結果を確認できません");
				await this.#patch(job.id, { state: "published", mediaId });
			});
		} catch (error) {
			const publishing = this.#options.store.read().jobs.find((j) => j.id === job.id)?.state === "publishing";
			await this.#patch(job.id, {
				state: publishing ? "unknown" : "failed",
				errorCode: publishing ? "PUBLICATION_UNKNOWN" : error instanceof MentionError ? error.code : "UPSTREAM_CHANGED",
			}).catch(() => undefined);
			if (!publishing)
				await this.#options.store
					.update((data) => {
						for (const [key, id] of Object.entries(data.sources)) if (id === job.id) delete data.sources[key];
					})
					.catch(() => undefined);
		}
	}
	async close() {
		this.#closing = true;
		for (const controller of this.#controllers) controller.abort();
		await Promise.allSettled([...this.#tasks]);
		await this.#options.store.close();
	}
}
