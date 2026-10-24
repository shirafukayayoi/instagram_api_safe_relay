import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { storyJobSchema } from "instagram-api-safe-contracts";
import { z } from "zod";
import { SerialQueue } from "../utils/queue.js";
import { StoryError } from "./errors.js";

const recordSchema = z.strictObject({
	version: z.literal(1),
	keyHash: z.string().regex(/^[a-f0-9]{64}$/),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	job: storyJobSchema,
});
export type StoryRecord = z.infer<typeof recordSchema>;

export class StoryStore {
	readonly #records = new Map<string, StoryRecord>();
	readonly #writes = new SerialQueue();
	readonly directory: string;
	readonly assetDirectory: string;
	#lock: fs.FileHandle | undefined;
	#healthy = true;
	constructor(directory: string) {
		this.directory = path.resolve(directory);
		this.assetDirectory = path.join(this.directory, "assets");
	}

	async open(): Promise<void> {
		try {
			await fs.mkdir(this.directory, { recursive: true });
			const lockPath = path.join(this.directory, ".lock");
			try {
				this.#lock = await fs.open(lockPath, "wx");
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
				const pid = Number(await fs.readFile(lockPath, "utf8"));
				if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_LOCK");
				try {
					process.kill(pid, 0);
					throw new Error("STORE_IN_USE");
				} catch (probeError) {
					if (
						!(
							typeof probeError === "object" &&
							probeError !== null &&
							"code" in probeError &&
							probeError.code === "ESRCH"
						)
					)
						throw probeError;
				}
				await fs.unlink(lockPath);
				this.#lock = await fs.open(lockPath, "wx");
			}
			await this.#lock.writeFile(String(process.pid));
			await this.#lock.sync();
			await fs.mkdir(path.join(this.directory, "jobs"), { recursive: true });
			await fs.mkdir(this.assetDirectory, { recursive: true });
			for (const name of await fs.readdir(path.join(this.directory, "jobs"))) {
				if (!name.endsWith(".json")) continue;
				const record = recordSchema.parse(
					JSON.parse(await fs.readFile(path.join(this.directory, "jobs", name), "utf8")),
				);
				if (name !== `${record.job.id}.json` || this.#records.has(record.keyHash)) throw new Error("INVALID_STORE");
				this.#records.set(record.keyHash, record);
				if (record.job.comment?.state === "sending")
					await this.save({
						...record,
						job: {
							...record.job,
							comment: { ...record.job.comment, state: "unknown", updatedAt: new Date().toISOString() },
						},
					});
				if (["queued", "uploading", "publishing"].includes(record.job.state)) {
					const publishing = record.job.state === "publishing";
					await this.save({
						...record,
						job: {
							...record.job,
							state: publishing ? "unknown" : "failed",
							errorCode: publishing ? "PUBLICATION_UNKNOWN" : "INTERRUPTED",
							updatedAt: new Date().toISOString(),
						},
					});
				}
			}
			// 前回終了時の検証済みコピーは再送しない。台帳は保持する。
			for (const name of await fs.readdir(this.assetDirectory)) {
				if (/^[a-f0-9-]{36}\.(jpg|png|mp4)$/.test(name)) await fs.unlink(path.join(this.assetDirectory, name));
			}
		} catch {
			await this.close();
			throw new StoryError("STORAGE_UNAVAILABLE", "ストーリー台帳を開けません。同時起動や破損を確認してください");
		}
	}

	find(keyHash: string): StoryRecord | undefined {
		this.assertHealthy();
		const record = this.#records.get(keyHash);
		return record ? structuredClone(record) : undefined;
	}

	get(id: string): StoryRecord | undefined {
		this.assertHealthy();
		const record = [...this.#records.values()].find((entry) => entry.job.id === id);
		return record ? structuredClone(record) : undefined;
	}

	findFeedPost(profile: string, mediaId: string): StoryRecord | undefined {
		this.assertHealthy();
		const found = [...this.#records.values()].find(
			(entry) =>
				entry.job.profile === profile &&
				entry.job.feedPost?.mediaId === mediaId &&
				!entry.job.removal &&
				!(entry.job.state === "unknown" && entry.job.retryRelease) &&
				entry.job.state !== "failed",
		);
		return found ? structuredClone(found) : undefined;
	}

	assertHealthy(): void {
		if (!this.#healthy || !this.#lock) throw new StoryError("STORAGE_UNAVAILABLE", "ストーリー台帳が利用できません");
	}

	async save(record: StoryRecord): Promise<void> {
		return this.#writes.run(async () => {
			this.assertHealthy();
			const validated = recordSchema.parse(record);
			const temporary = path.join(this.directory, "jobs", `${validated.job.id}.${randomUUID()}.tmp`);
			try {
				const handle = await fs.open(temporary, "wx");
				try {
					await handle.writeFile(JSON.stringify(validated));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await fs.rename(temporary, path.join(this.directory, "jobs", `${validated.job.id}.json`));
				if (process.platform !== "win32") {
					const directory = await fs.open(path.join(this.directory, "jobs"), "r");
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				}
				this.#records.set(validated.keyHash, structuredClone(validated));
			} catch {
				this.#healthy = false;
				await fs.unlink(temporary).catch(() => undefined);
				throw new StoryError("STORAGE_UNAVAILABLE", "ストーリー台帳の保存に失敗しました");
			}
		});
	}

	async close(): Promise<void> {
		if (!this.#lock) return;
		await this.#lock.close();
		this.#lock = undefined;
		await fs.unlink(path.join(this.directory, ".lock")).catch(() => undefined);
	}
}
