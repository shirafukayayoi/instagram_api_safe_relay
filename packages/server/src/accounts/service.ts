import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type StoryAccount, storyAccountSchema } from "instagram-api-safe-contracts";
import { z } from "zod";
import { mediaReady, withMediaSession } from "../media-session.js";
import { StoryError } from "../stories/errors.js";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";

export const selectAccountSchema = z.strictObject({
	profile: z.string().min(1).max(64),
	expectedAccountId: z.string().regex(/^\d+$/).optional(),
});
const savedSchema = z.strictObject({ version: z.literal(1), profile: z.string().min(1), account: storyAccountSchema });
export type AccountSelection = { profile: string; account: StoryAccount };

/** 選択は新しい操作の初期値。受理済みジョブやHTTPの暗黙ルーティングを変更しない。 */
export class AccountService {
	readonly #profiles: RelayProfile[];
	readonly #file: string;
	readonly #queue = new SerialQueue();
	#saved: AccountSelection | null = null;
	constructor(profiles: RelayProfile[], file: string) {
		this.#profiles = profiles;
		this.#file = file;
	}
	async open() {
		try {
			const value = savedSchema.parse(JSON.parse(await fs.readFile(this.#file, "utf8")));
			this.#saved = { profile: value.profile, account: value.account };
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
			throw new StoryError("STORAGE_UNAVAILABLE", "保存されたアカウント選択を確認できません");
		}
	}
	#selected(): AccountSelection | null {
		const profile = this.#saved
			? this.#profiles.find((entry) => entry.name === this.#saved?.profile)
			: this.#profiles.length === 1
				? this.#profiles[0]
				: undefined;
		if (!profile || !mediaReady(profile) || !profile.account) return null;
		if (
			this.#saved &&
			(profile.account.id !== this.#saved.account.id || profile.account.username !== this.#saved.account.username)
		)
			return null;
		return { profile: profile.name, account: { ...profile.account } };
	}
	list() {
		return {
			accounts: this.#profiles.map((profile) => ({
				profile: profile.name,
				state: profile.state,
				account: profile.account ? { ...profile.account } : null,
			})),
			selected: this.#selected(),
		};
	}
	select(input: unknown): Promise<AccountSelection> {
		return this.#queue.run(async () => {
			const parsed = selectAccountSchema.safeParse(input);
			if (!parsed.success)
				throw new StoryError("INVALID_INPUT", "切り替え先のprofileと任意のexpectedAccountIdを指定してください");
			const profile = this.#profiles.find((entry) => entry.name === parsed.data.profile);
			if (!profile) throw new StoryError("UNKNOWN_PROFILE", "切り替え先のアカウントが登録されていません");
			if (!mediaReady(profile)) throw new StoryError("SESSION_NOT_READY", "切り替え先へログインしてください");
			const account = await withMediaSession(profile, async (session) => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 30000);
				let publisher: Awaited<ReturnType<typeof session.createPublisher>> | undefined;
				try {
					if ((await session.getSessionStatus()).state !== "ready")
						throw new StoryError("SESSION_NOT_READY", "切り替え先へログインしてください");
					publisher = await session.createPublisher(controller.signal);
					return storyAccountSchema.parse(await publisher.getAccount());
				} finally {
					clearTimeout(timer);
					controller.abort();
					await publisher?.close();
				}
			});
			if (parsed.data.expectedAccountId && parsed.data.expectedAccountId !== account.id)
				throw new StoryError("ACCOUNT_CHANGED", "一覧で選んだアカウントと実ログインアカウントが異なります");
			const selected = { profile: profile.name, account };
			const temporary = path.join(path.dirname(this.#file), `.${randomUUID()}.tmp`);
			try {
				await fs.mkdir(path.dirname(this.#file), { recursive: true });
				await fs.writeFile(temporary, `${JSON.stringify({ version: 1, ...selected })}\n`, { mode: 0o600, flag: "wx" });
				await fs.rename(temporary, this.#file);
			} catch {
				throw new StoryError("STORAGE_UNAVAILABLE", "アカウント選択を保存できません。切り替えは確定していません");
			} finally {
				await fs.unlink(temporary).catch(() => undefined);
			}
			profile.account = { ...account };
			this.#saved = selected;
			return structuredClone(selected);
		});
	}
}
