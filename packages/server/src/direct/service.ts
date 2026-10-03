import { createHash, randomUUID } from "node:crypto";
import { dmPageInputSchema, dmSendInputSchema, type DmJob } from "instagram-api-safe-contracts";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";
import type { Settings } from "../utils/settings.js";
import { createDmTransport, type DmTransport } from "./browser.js";
import { DmError } from "./errors.js";
import type { DmRecord, DmStore } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Options = {
	settings: Settings["direct"];
	profiles: RelayProfile[];
	store: DmStore;
	transport?: typeof createDmTransport;
};
export class DmService {
	readonly #options: Options;
	readonly #intake = new SerialQueue();
	readonly #tasks = new Set<Promise<void>>();
	readonly #controllers = new Set<AbortController>();
	#closing = false;
	constructor(options: Options) {
		this.#options = options;
	}
	#profile(name: string) {
		if (!this.#options.settings.enabled) throw new DmError("DM_DISABLED", "DM機能は無効です");
		if (this.#closing) throw new DmError("STORAGE_UNAVAILABLE", "Relayを終了しています");
		const profile = this.#options.profiles.find((entry) => entry.name === name);
		if (!profile) throw new DmError("UNKNOWN_PROFILE", "プロファイルが見つかりません");
		return profile;
	}
	async #run<T>(profile: RelayProfile, action: (transport: DmTransport) => Promise<T>): Promise<T> {
		if (profile.state !== "ready" || !profile.runExclusive)
			throw new DmError("SESSION_NOT_READY", "ブラウザの準備ができていません");
		return profile.runExclusive(async (client) => {
			if (this.#closing || (await client.getSessionStatus()).state !== "ready")
				throw new DmError("SESSION_NOT_READY", "ログインが必要です");
			const controller = new AbortController();
			this.#controllers.add(controller);
			const timer = setTimeout(() => controller.abort(), this.#options.settings.operationTimeoutMs);
			let transport: DmTransport | undefined;
			try {
				transport = await (this.#options.transport ?? createDmTransport)(client.page, controller.signal);
				return await action(transport);
			} finally {
				clearTimeout(timer);
				controller.abort();
				await transport?.close().catch(() => undefined);
				this.#controllers.delete(controller);
			}
		});
	}
	inbox(profile: string, input: unknown) {
		const parsed = dmPageInputSchema.safeParse(input);
		if (!parsed.success) throw new DmError("INVALID_INPUT", "ページ指定が不正です");
		return this.#run(this.#profile(profile), (transport) => transport.inbox(parsed.data));
	}
	messages(profile: string, threadId: string, input: unknown) {
		if (!/^\d{1,80}$/.test(threadId)) throw new DmError("INVALID_INPUT", "threadIdは数字で指定してください");
		const parsed = dmPageInputSchema.safeParse(input);
		if (!parsed.success) throw new DmError("INVALID_INPUT", "ページ指定が不正です");
		return this.#run(this.#profile(profile), (transport) => transport.messages(threadId, parsed.data));
	}
	create(name: string, key: string | undefined, input: unknown): Promise<DmJob> {
		return this.#intake.run(async () => {
			const profile = this.#profile(name);
			if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
				throw new DmError("INVALID_INPUT", "Idempotency-Keyが必要です");
			const parsed = dmSendInputSchema.safeParse(input);
			if (!parsed.success) throw new DmError("INVALID_INPUT", "threadIdと1〜1000文字のtextが必要です");
			const keyHash = hash(`${name}\0${key}`);
			const requestHash = hash(JSON.stringify({ profile: name, ...parsed.data }));
			const existing = this.#options.store.find(keyHash);
			if (existing) {
				if (existing.requestHash !== requestHash)
					throw new DmError("IDEMPOTENCY_CONFLICT", "同じキーを異なる宛先・本文に再利用できません");
				return existing.job;
			}
			if (profile.state !== "ready" || !profile.runExclusive)
				throw new DmError("SESSION_NOT_READY", "ブラウザの準備ができていません");
			const now = new Date().toISOString();
			const record: DmRecord = {
				version: 1,
				keyHash,
				requestHash,
				job: {
					id: randomUUID(),
					profile: name,
					threadId: parsed.data.threadId,
					state: "queued",
					createdAt: now,
					updatedAt: now,
					account: null,
					messageId: null,
					errorCode: null,
				},
			};
			await this.#options.store.save(record);
			const task = this.#execute(profile, record, parsed.data.text);
			this.#tasks.add(task);
			void task.finally(() => this.#tasks.delete(task));
			return record.job;
		});
	}
	get(name: string, id: string) {
		this.#profile(name);
		const record = this.#options.store.get(id);
		if (!record || record.job.profile !== name) throw new DmError("NOT_FOUND", "ジョブが見つかりません");
		return record.job;
	}
	async #execute(profile: RelayProfile, initial: DmRecord, text: string) {
		let record = initial;
		const update = async (patch: Partial<DmJob>) => {
			const next = { ...record, job: { ...record.job, ...patch, updatedAt: new Date().toISOString() } };
			await this.#options.store.save(next);
			record = next;
		};
		try {
			await this.#run(profile, async (transport) => {
				const account = await transport.account();
				await update({ state: "validating", account });
				const conversation = await transport.messages(record.job.threadId, { limit: 1 });
				if (!conversation.thread.canSendText)
					throw new DmError("UPSTREAM_CHANGED", "暗号化・読み取り専用・リクエスト状態の会話には送信できません");
				if (
					conversation.account.id !== account.id ||
					conversation.account.username !== account.username ||
					conversation.thread.id !== record.job.threadId
				)
					throw new DmError("ACCOUNT_CHANGED", "会話またはアカウントが変更されています");
				const current = await transport.account();
				if (current.id !== account.id || current.username !== account.username || this.#closing)
					throw new DmError("ACCOUNT_CHANGED", "送信先確認後にアカウントが変更されています");
				await update({ state: "sending" });
				const messageId = await transport.send(record.job.threadId, text, record.job.id, account);
				if (!/^\d{1,80}$/.test(messageId)) throw new DmError("DELIVERY_UNKNOWN", "送信IDを確認できません");
				await update({ state: "sent", messageId });
			});
		} catch (error) {
			const uncertain = record.job.state === "sending";
			await update({
				state: uncertain ? "unknown" : "failed",
				errorCode: uncertain ? "DELIVERY_UNKNOWN" : error instanceof DmError ? error.code : "UPSTREAM_CHANGED",
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
