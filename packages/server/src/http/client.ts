import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Highlight, StoryAccount } from "instagram-api-safe-contracts";
import { z } from "zod";
import { StoryError } from "../stories/errors.js";

const cookieNames = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "rur"]);
const safeValue = z
	.string()
	.min(1)
	.max(8192)
	.regex(/^[^;\r\n\0]+$/);
const sessionSchema = z.object({
	version: z.literal(1),
	account: z.object({ id: z.string().regex(/^\d+$/), username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/) }),
	userAgent: z
		.string()
		.min(1)
		.max(512)
		.regex(/^[^\r\n]+$/),
	cookies: z
		.array(
			z.object({
				name: z.string().refine((name) => cookieNames.has(name)),
				value: safeValue,
				domain: z.string().refine((domain) => domain.replace(/^\./, "") === "instagram.com"),
				path: z.literal("/"),
				secure: z.boolean(),
				expires: z.number().nullable(),
			}),
		)
		.max(20),
});
type Session = z.infer<typeof sessionSchema>;
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const numericId = (value: unknown): string | null => {
	if (typeof value === "string" && /^\d+$/.test(value)) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	return null;
};
// Node.js 24のreviver contextで大きなIDを丸めずに読む。文字列の内容には手を加えない。
const parseJson = (text: string): unknown =>
	JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
		typeof value === "number" && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? "")
			? context?.source
			: value,
	);
const validateId = (value: string) => {
	if (!/^\d+$/.test(value)) throw new StoryError("INVALID_INPUT", "数値IDが必要です");
};

type ClientOptions = {
	fetch?: typeof fetch;
	onSessionError?: (state: "login_required" | "challenge_required" | "session_not_ready") => void;
};

/** 認証を保持するローカル専用クライアント。外部へ任意path・raw応答を公開しない。 */
export class InstagramHttpClient {
	readonly #session: Session;
	readonly #file: string;
	readonly #options: ClientOptions;
	#closed = false;
	private constructor(session: Session, file: string, options: ClientOptions) {
		this.#session = session;
		this.#file = file;
		this.#options = options;
	}
	static async open(file: string, options: ClientOptions = {}) {
		try {
			const stat = await fs.lstat(file);
			if (
				!stat.isFile() ||
				stat.size > 65536 ||
				(process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
			)
				throw new Error("SESSION_PERMISSIONS");
			const session = sessionSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
			const names = session.cookies.map((cookie) => cookie.name);
			if (
				new Set(names).size !== names.length ||
				!["sessionid", "csrftoken", "ds_user_id"].every((name) => names.includes(name))
			)
				throw new Error("SESSION_COOKIES");
			if (session.cookies.find((cookie) => cookie.name === "ds_user_id")?.value !== session.account.id)
				throw new Error("SESSION_ACCOUNT");
			return new InstagramHttpClient(session, file, options);
		} catch {
			throw new StoryError("SESSION_NOT_READY", "HTTP用セッションがないか、内容・所有者・アクセス権が不正です");
		}
	}
	#cookie(name: string) {
		return this.#session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
	}
	async #json(
		host: "www.instagram.com" | "i.instagram.com",
		endpoint: string,
		signal: AbortSignal,
		body?: URLSearchParams | Uint8Array,
		extraHeaders: Record<string, string> = {},
	): Promise<Json> {
		if (this.#closed || signal.aborted) throw new StoryError("INTERRUPTED", "HTTP操作が中断されました");
		const now = Date.now() / 1000;
		if (
			this.#session.cookies.some(
				(cookie) =>
					cookie.name === "sessionid" && cookie.expires !== null && cookie.expires > 0 && cookie.expires <= now,
			)
		) {
			this.#options.onSessionError?.("login_required");
			throw new StoryError("SESSION_NOT_READY", "保存済みログインの有効期限が切れています");
		}
		const headers = {
			"User-Agent": this.#session.userAgent,
			Cookie: this.#session.cookies
				.filter((cookie) => cookie.expires === null || cookie.expires <= 0 || cookie.expires > now)
				.map((cookie) => `${cookie.name}=${cookie.value}`)
				.join("; "),
			"X-CSRFToken": this.#cookie("csrftoken"),
			"X-IG-App-ID": "936619743392459",
			"X-Requested-With": "XMLHttpRequest",
			Origin: "https://www.instagram.com",
			Referer: "https://www.instagram.com/",
			...extraHeaders,
		};
		try {
			// fetchには再試行を実装しない。認証付きリダイレクトも追跡しない。
			const response = await (this.#options.fetch ?? fetch)(`https://${host}${endpoint}`, {
				method: body === undefined ? "GET" : "POST",
				headers,
				redirect: "manual",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				...(body === undefined ? {} : { body: body instanceof URLSearchParams ? body : Buffer.from(body) }),
			});
			if (response.status >= 300 && response.status < 400) {
				this.#options.onSessionError?.("login_required");
				throw new StoryError(
					"SESSION_NOT_READY",
					"Instagramのリダイレクトを拒否しました。手動でログインを確認してください",
				);
			}
			if (response.status === 429) {
				this.#options.onSessionError?.("session_not_ready");
				throw new StoryError("SESSION_NOT_READY", "Instagramの利用制限により停止しました。自動再試行しません");
			}
			let data: Json;
			try {
				data = object(parseJson(await response.text()));
			} catch {
				throw new StoryError("CATALOG_STALE", "Instagramの応答形式を確認できません");
			}
			if (data.challenge || data.message === "challenge_required" || data.message === "checkpoint_required") {
				this.#options.onSessionError?.("challenge_required");
				throw new StoryError("SESSION_NOT_READY", "Instagramで手動の追加認証が必要です");
			}
			if ([401, 403].includes(response.status) || data.message === "login_required") {
				this.#options.onSessionError?.("login_required");
				throw new StoryError("SESSION_NOT_READY", "Instagramへ手動で再ログインしてください");
			}
			if (!response.ok || data.status !== "ok")
				throw new StoryError("CATALOG_STALE", "Instagramによる受付を確認できません");
			await this.#refreshCookies(response.headers);
			return data;
		} catch (error) {
			if (error instanceof StoryError) throw error;
			throw new StoryError(
				signal.aborted ? "INTERRUPTED" : "CATALOG_STALE",
				"InstagramとのHTTP通信を確認できません。自動再試行しません",
			);
		}
	}
	async #refreshCookies(headers: Headers) {
		let changed = false;
		for (const value of headers.getSetCookie()) {
			const parts = value.split(";");
			const first = parts[0] ?? "";
			const separator = first.indexOf("=");
			const name = first.slice(0, separator);
			const raw = first.slice(separator + 1);
			if (!cookieNames.has(name)) continue;
			if (!safeValue.safeParse(raw).success) {
				this.#options.onSessionError?.("login_required");
				throw new StoryError("SESSION_NOT_READY", "認証Cookieが無効化されました");
			}
			if (name === "ds_user_id" && raw !== this.#session.account.id)
				throw new StoryError("ACCOUNT_CHANGED", "認証アカウントが変わりました");
			const old = this.#session.cookies.find((cookie) => cookie.name === name);
			const expiresText = parts
				.find((part) => /^\s*expires=/i.test(part))
				?.trim()
				.slice(8);
			const expires = expiresText ? Date.parse(expiresText) / 1000 : (old?.expires ?? null);
			if (expires !== null && !Number.isFinite(expires)) continue;
			if (old) {
				changed ||= old.value !== raw || old.expires !== expires;
				old.value = raw;
				old.expires = expires;
			} else {
				this.#session.cookies.push({ name, value: raw, domain: ".instagram.com", path: "/", secure: true, expires });
				changed = true;
			}
		}
		if (changed) {
			const temporary = path.join(path.dirname(this.#file), `.${randomUUID()}.tmp`);
			try {
				await fs.writeFile(temporary, `${JSON.stringify(this.#session)}\n`, { mode: 0o600, flag: "wx" });
				await fs.rename(temporary, this.#file);
			} finally {
				await fs.unlink(temporary).catch(() => undefined);
			}
		}
	}
	async getAccount(signal: AbortSignal): Promise<StoryAccount> {
		// Web用の固定読み取りAPI。編集・保存の要求は送らない。
		const data = await this.#json("www.instagram.com", "/api/v1/accounts/edit/web_form_data/", signal);
		const username = object(data.form_data).username;
		if (username !== this.#session.account.username)
			throw new StoryError("ACCOUNT_CHANGED", "保存した投稿先と実ログインアカウントが一致しません");
		return { ...this.#session.account };
	}
	async listHighlights(signal: AbortSignal): Promise<{ account: StoryAccount; highlights: Highlight[] }> {
		const account = await this.getAccount(signal);
		const data = await this.#json("www.instagram.com", `/api/v1/highlights/${account.id}/highlights_tray/`, signal);
		if (!Array.isArray(data.tray)) throw new StoryError("CATALOG_STALE", "ハイライト一覧を確認できません");
		const highlights = data.tray.map((item: unknown) => {
			const reel = object(item);
			const id = typeof reel.id === "string" ? /^highlight:(\d+)$/.exec(reel.id)?.[1] : undefined;
			if (!id || typeof reel.title !== "string" || numericId(object(reel.user).pk) !== account.id)
				throw new StoryError("CATALOG_STALE", "自分のハイライトを照合できません");
			return { id, title: reel.title };
		});
		return { account, highlights };
	}
	async highlightItems(id: string, signal: AbortSignal): Promise<string[]> {
		validateId(id);
		const data = await this.#json("www.instagram.com", `/api/v1/feed/reels_media/?reel_ids=highlight%3A${id}`, signal);
		const reel = object(object(data.reels)[`highlight:${id}`]);
		if (
			reel.id !== `highlight:${id}` ||
			numericId(object(reel.user).pk) !== this.#session.account.id ||
			!Array.isArray(reel.items)
		)
			throw new StoryError("CATALOG_STALE", "ハイライトの登録済みストーリーを照合できません");
		return reel.items.map((item: unknown) => {
			const media = object(item);
			const pk = numericId(media.pk);
			if (!pk || (media.user && numericId(object(media.user).pk) !== this.#session.account.id))
				throw new StoryError("CATALOG_STALE", "登録済みメディアのIDを確認できません");
			return pk;
		});
	}
	async addHighlightStory(id: string, mediaId: string, signal: AbortSignal): Promise<void> {
		validateId(id);
		validateId(mediaId);
		await this.#json(
			"www.instagram.com",
			`/api/v1/highlights/highlight:${id}/edit_reel/`,
			signal,
			new URLSearchParams({
				source: "self_profile",
				added_media_ids: JSON.stringify([`${mediaId}_${this.#session.account.id}`]),
				removed_media_ids: "[]",
			}),
		);
	}
	async uploadPhoto(id: string, bytes: Uint8Array, width: number, height: number, mime: string, signal: AbortSignal) {
		validateId(id);
		const entity = `story_${id}`;
		await this.#json("i.instagram.com", `/rupload_igphoto/${entity}`, signal, bytes, {
			"Content-Type": "application/octet-stream",
			"X-Entity-Type": mime,
			"X-Entity-Name": entity,
			"X-Entity-Length": String(bytes.length),
			Offset: "0",
			"X-Instagram-Rupload-Params": JSON.stringify({
				upload_id: id,
				media_type: "1",
				upload_media_width: String(width),
				upload_media_height: String(height),
			}),
		});
	}
	async uploadVideo(
		id: string,
		bytes: Uint8Array,
		width: number,
		height: number,
		seconds: number,
		signal: AbortSignal,
	) {
		validateId(id);
		const entity = `story_${id}`;
		const headers = {
			"X-Instagram-Rupload-Params": JSON.stringify({
				upload_id: id,
				media_type: "2",
				upload_media_width: String(width),
				upload_media_height: String(height),
				upload_media_duration_ms: String(Math.round(seconds * 1000)),
				extract_cover_frame: "1",
				for_album: "1",
				content_tags: "has-overlay",
				retry_context: JSON.stringify({ num_step_auto_retry: 0, num_reupload: 0, num_step_manual_retry: 0 }),
			}),
		};
		const initialized = await this.#json("i.instagram.com", `/rupload_igvideo/${entity}`, signal, undefined, headers);
		if (initialized.offset !== 0) throw new StoryError("UPLOAD_FAILED", "アップロード開始位置が不正です。再送しません");
		await this.#json("i.instagram.com", `/rupload_igvideo/${entity}`, signal, bytes, {
			...headers,
			"Content-Type": "application/octet-stream",
			"X-Entity-Type": "video/mp4",
			"X-Entity-Name": entity,
			"X-Entity-Length": String(bytes.length),
			Offset: "0",
		});
	}
	async publish(
		id: string,
		account: StoryAccount,
		audience: "all" | "close_friends",
		caption: string,
		signal: AbortSignal,
	): Promise<string> {
		validateId(id);
		const data = await this.#json(
			"www.instagram.com",
			"/api/v1/media/configure_to_story/",
			signal,
			new URLSearchParams({
				upload_id: id,
				configure_mode: "1",
				caption,
				share_to_facebook: "",
				share_to_fb_destination_id: "",
				share_to_fb_destination_type: "USER",
				...(audience === "close_friends" ? { audience: "besties" } : {}),
			}),
		);
		const media = object(data.media);
		const exactId = typeof media.id === "string" ? /^(\d+)_(\d+)$/.exec(media.id) : null;
		const pk = numericId(media.pk) ?? (exactId?.[2] === account.id ? exactId[1] : null);
		if (
			!pk ||
			numericId(object(media.user).pk) !== account.id ||
			(audience === "close_friends" && media.audience !== "besties") ||
			(audience === "all" && media.audience === "besties") ||
			(caption !== "" && object(media.caption).text !== caption)
		)
			throw new StoryError(
				"PUBLICATION_UNKNOWN",
				"投稿ID・アカウント・公開範囲・文面の公開結果を確認できません。再送しません",
			);
		return pk;
	}
	close() {
		this.#closed = true;
	}
}
