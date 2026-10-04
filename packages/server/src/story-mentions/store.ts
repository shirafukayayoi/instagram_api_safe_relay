import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { storyMentionJobSchema, storyMentionSchema } from "instagram-api-safe-contracts";
import { z } from "zod";
import { SerialQueue } from "../utils/queue.js";

export class MentionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.strictObject({
	version: z.literal(1),
	mentions: z.array(storyMentionSchema),
	jobs: z.array(storyMentionJobSchema),
	keys: z.record(hash, z.strictObject({ requestHash: hash, jobId: z.string().uuid() })),
	sources: z.record(hash, z.string().uuid()),
});
export type MentionData = z.infer<typeof schema>;
export class MentionStore {
	#data: MentionData = { version: 1, mentions: [], jobs: [], keys: {}, sources: {} };
	#lock: fs.FileHandle | undefined;
	#healthy = true;
	readonly #writes = new SerialQueue();
	readonly directory: string;
	constructor(directory: string) {
		this.directory = path.resolve(directory);
	}
	async open() {
		try {
			await fs.mkdir(this.directory, { recursive: true });
			const lockPath = path.join(this.directory, ".lock");
			try {
				this.#lock = await fs.open(lockPath, "wx");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const pid = Number(await fs.readFile(lockPath, "utf8"));
				if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_LOCK");
				try {
					process.kill(pid, 0);
					throw new Error("STORE_IN_USE");
				} catch (probe) {
					if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
				}
				await fs.unlink(lockPath);
				this.#lock = await fs.open(lockPath, "wx");
			}
			await this.#lock.writeFile(String(process.pid));
			await this.#lock.sync();
			try {
				this.#data = schema.parse(JSON.parse(await fs.readFile(path.join(this.directory, "ledger.json"), "utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const ids = new Set(this.#data.jobs.map((job) => job.id));
			if (
				ids.size !== this.#data.jobs.length ||
				new Set(this.#data.mentions.map((m) => m.id)).size !== this.#data.mentions.length ||
				Object.values(this.#data.keys).some((entry) => !ids.has(entry.jobId)) ||
				Object.values(this.#data.sources).some((id) => !ids.has(id))
			)
				throw new Error("INVALID_STORE");
			await this.update((data) => {
				for (const job of data.jobs)
					if (["queued", "validating", "publishing"].includes(job.state)) {
						job.errorCode = job.state === "publishing" ? "PUBLICATION_UNKNOWN" : "INTERRUPTED";
						job.state = job.state === "publishing" ? "unknown" : "failed";
						job.updatedAt = new Date().toISOString();
					}
				for (const [source, id] of Object.entries(data.sources))
					if (data.jobs.find((j) => j.id === id)?.state === "failed") delete data.sources[source];
			});
		} catch {
			await this.close();
			throw new MentionError("STORAGE_UNAVAILABLE", "メンション台帳を開けません");
		}
	}
	read() {
		if (!this.#lock || !this.#healthy) throw new MentionError("STORAGE_UNAVAILABLE", "メンション台帳が利用できません");
		return structuredClone(this.#data);
	}
	async update<T>(action: (data: MentionData) => T): Promise<T> {
		return this.#writes.run(async () => {
			const next = this.read();
			const result = action(next);
			const validated = schema.parse(next);
			const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
			try {
				const handle = await fs.open(temporary, "wx");
				try {
					await handle.writeFile(JSON.stringify(validated));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await fs.rename(temporary, path.join(this.directory, "ledger.json"));
				if (process.platform !== "win32") {
					const directory = await fs.open(this.directory, "r");
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				}
				this.#data = validated;
				return structuredClone(result);
			} catch {
				this.#healthy = false;
				await fs.unlink(temporary).catch(() => undefined);
				throw new MentionError("STORAGE_UNAVAILABLE", "メンション台帳の保存に失敗しました");
			}
		});
	}
	async close() {
		await this.#writes.run(async () => {
			if (!this.#lock) return;
			await this.#lock.close();
			this.#lock = undefined;
			await fs.unlink(path.join(this.directory, ".lock")).catch(() => undefined);
		});
	}
}
