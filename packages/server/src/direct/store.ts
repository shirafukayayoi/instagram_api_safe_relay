import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dmJobSchema } from "instagram-api-safe-contracts";
import { z } from "zod";
import { SerialQueue } from "../utils/queue.js";
import { DmError } from "./errors.js";

const recordSchema = z.strictObject({
	version: z.literal(1),
	keyHash: z.string().regex(/^[a-f0-9]{64}$/),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	job: dmJobSchema,
});
export type DmRecord = z.infer<typeof recordSchema>;

export class DmStore {
	readonly #records = new Map<string, DmRecord>();
	readonly #writes = new SerialQueue();
	readonly directory: string;
	#lock: fs.FileHandle | undefined;
	#healthy = true;
	constructor(directory: string) {
		this.directory = path.resolve(directory);
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
			for (const name of await fs.readdir(path.join(this.directory, "jobs"))) {
				if (!name.endsWith(".json")) continue;
				const record = recordSchema.parse(
					JSON.parse(await fs.readFile(path.join(this.directory, "jobs", name), "utf8")),
				);
				if (name !== `${record.job.id}.json` || this.#records.has(record.keyHash)) throw new Error("INVALID_STORE");
				this.#records.set(record.keyHash, record);
				if (["queued", "validating", "sending"].includes(record.job.state)) {
					const sending = record.job.state === "sending";
					await this.save({
						...record,
						job: {
							...record.job,
							state: sending ? "unknown" : "failed",
							errorCode: sending ? "DELIVERY_UNKNOWN" : "INTERRUPTED",
							updatedAt: new Date().toISOString(),
						},
					});
				}
			}
		} catch {
			await this.close();
			throw new DmError("STORAGE_UNAVAILABLE", "DM台帳を開けません。同時起動や破損を確認してください");
		}
	}

	find(keyHash: string): DmRecord | undefined {
		this.assertHealthy();
		const record = this.#records.get(keyHash);
		return record ? structuredClone(record) : undefined;
	}

	get(id: string): DmRecord | undefined {
		this.assertHealthy();
		const record = [...this.#records.values()].find((entry) => entry.job.id === id);
		return record ? structuredClone(record) : undefined;
	}

	assertHealthy(): void {
		if (!this.#healthy || !this.#lock) throw new DmError("STORAGE_UNAVAILABLE", "DM台帳が利用できません");
	}

	async save(record: DmRecord): Promise<void> {
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
				throw new DmError("STORAGE_UNAVAILABLE", "DM台帳の保存に失敗しました");
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
