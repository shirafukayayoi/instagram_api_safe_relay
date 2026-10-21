import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Highlight, StoryAccount, StoryFeedPostReference, StoryFeedPost } from "instagram-api-safe-contracts";
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
	#wwwClaim = "0";
	#tokens: { lsd: string; dtsg: string; av: string } | undefined;
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
		kind: "json" | "html" | "rupload-init" = "json",
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
			"X-IG-WWW-Claim": this.#wwwClaim,
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
			if ([401, 403].includes(response.status)) {
				this.#options.onSessionError?.("login_required");
				throw new StoryError("SESSION_NOT_READY", "Instagramへ手動で再ログインしてください");
			}
			if (kind === "html") {
				if (!response.ok) throw new StoryError("CATALOG_STALE", "Webの認証情報を確認できません");
				await this.#refreshCookies(response.headers);
				return { html: await response.text() };
			}
			let data: Json;
			try {
				data = object(parseJson((await response.text()).replace(/^for \(;;\);/, "")));
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
			if (
				!response.ok ||
				(kind === "rupload-init"
					? !Number.isSafeInteger(data.offset) ||
						Number(data.offset) < 0 ||
						data.error ||
						(data.status !== undefined && data.status !== "ok")
					: endpoint === "/graphql/query"
						? !data.data || data.errors || data.error
						: data.status !== "ok")
			)
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
		const claim = headers.get("x-ig-set-www-claim");
		if (claim && safeValue.safeParse(claim).success) this.#wwwClaim = claim;
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
		if (username !== this.#session.account.username) {
			this.#options.onSessionError?.("session_not_ready");
			throw new StoryError("ACCOUNT_CHANGED", "保存した投稿先と実ログインアカウントが一致しません");
		}
		return { ...this.#session.account };
	}
	async #feedPost(shortcode: string, signal: AbortSignal): Promise<{ post: StoryFeedPost; image: string }> {
		if (!/^[A-Za-z0-9_-]{1,16}$/.test(shortcode)) throw new StoryError("INVALID_INPUT", "投稿コードが不正です");
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const id = [...shortcode].reduce((n, c) => n * 64n + BigInt(alphabet.indexOf(c)), 0n).toString();
		const data = await this.#json("www.instagram.com", `/api/v1/media/${id}/info/`, signal);
		const items = Array.isArray(data.items) ? data.items : [];
		const media = object(items[0]);
		const user = object(media.user);
		const owner = numericId(user.pk ?? user.id);
		if (items.length !== 1 || numericId(media.pk) !== id || media.code !== shortcode || !owner)
			throw new StoryError("CATALOG_STALE", "元投稿のIDと所有者を照合できません");
		if (user.is_private !== false || media.can_viewer_reshare !== true || media.ig_media_sharing_disabled !== false)
			throw new StoryError("MEDIA_NOT_ALLOWED", "公開・ストーリー共有の許可を確認できません");
		const candidates = object(media.image_versions2).candidates;
		const image = object(Array.isArray(candidates) ? candidates[0] : undefined);
		if (
			typeof user.username !== "string" ||
			!/^[A-Za-z0-9._]{1,30}$/.test(user.username) ||
			typeof image.url !== "string" ||
			!Number.isSafeInteger(image.width) ||
			!Number.isSafeInteger(image.height) ||
			Number(image.width) <= 0 ||
			Number(image.height) <= 0 ||
			![1, 2, 8].includes(Number(media.media_type))
		)
			throw new StoryError("CATALOG_STALE", "元投稿の画像情報を確認できません");
		return {
			post: {
				shortcode,
				mediaId: id,
				ownerId: owner,
				username: user.username,
				width: Number(image.width),
				height: Number(image.height),
				carouselCount: Array.isArray(media.carousel_media) ? media.carousel_media.length : 1,
				...(Array.isArray(media.coauthor_producers)
					? {
							collaborators: media.coauthor_producers
								.map((item) => object(item).username)
								.filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9._]{1,30}$/.test(name)),
						}
					: {}),
			},
			image: image.url,
		};
	}
	async getFeedPost(shortcode: string, signal: AbortSignal): Promise<StoryFeedPost> {
		return (await this.#feedPost(shortcode, signal)).post;
	}
	async getFeedImage(shortcode: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
		const { image } = await this.#feedPost(shortcode, signal);
		const url = new URL(image);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			![".cdninstagram.com", ".fbcdn.net"].some((domain) => url.hostname.endsWith(domain))
		)
			throw new StoryError("MEDIA_NOT_ALLOWED", "Instagram画像CDN以外へアクセスしません");
		try {
			// 署名付きURLはローカル応答・ログへ返さず、CDNへ認証Cookieを送らない。
			const response = await (this.#options.fetch ?? fetch)(url.href, {
				redirect: "manual",
				signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
			});
			const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
			if (!response.ok || !["image/jpeg", "image/png"].includes(mimeType) || !response.body)
				throw new StoryError("MEDIA_INVALID", "元投稿の画像を取得できません");
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 8 * 1024 * 1024) throw new StoryError("MEDIA_TOO_LARGE", "元投稿の画像は8MiB以下が必要です");
				chunks.push(chunk);
			}
			return { bytes: Buffer.concat(chunks), mimeType };
		} catch (error) {
			if (error instanceof StoryError) throw error;
			throw new StoryError("MEDIA_INVALID", "元投稿の画像通信を確認できません");
		}
	}
	async #webTokens(signal: AbortSignal) {
		if (this.#tokens) return this.#tokens;
		const { html } = await this.#json(
			"www.instagram.com",
			`/${this.#session.account.username}/`,
			signal,
			undefined,
			{ "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
			"html",
		);
		if (typeof html !== "string") throw new StoryError("CATALOG_STALE", "Webの認証情報を取得できません");
		const lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? /"lsd":"([^"]+)"/.exec(html)?.[1];
		const dtsg =
			/"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? /"dtsg":\{"token":"([^"]+)"/.exec(html)?.[1];
		const av = /"IG_USER_EIMU":"(\d+)"/.exec(html)?.[1];
		if (!lsd || !dtsg || !av || lsd.length > 1024 || dtsg.length > 2048)
			throw new StoryError("CATALOG_STALE", "Webの認証形式が変わりました");
		this.#tokens = { lsd, dtsg, av };
		return this.#tokens;
	}
	async #highlightConnection(
		kind: "tray" | "items",
		variables: Json,
		signal: AbortSignal,
	): Promise<{ nodes: Json[]; next: string | null }> {
		// gallery-dl 8770e6e9c0で更新された固定の読み取りクエリ2件だけを使用する。
		const operation =
			kind === "tray" ? "PolarisProfileStoryHighlightsTrayContentQuery" : "PolarisStoriesV3HighlightsPageQuery";
		const field = kind === "tray" ? "highlights" : "xdt_api__v1__feed__reels_media__connection";
		const docId = kind === "tray" ? "26970053832668570" : "28325328583775973";
		const { lsd, dtsg, av } = await this.#webTokens(signal);
		const data = await this.#json(
			"www.instagram.com",
			"/graphql/query",
			signal,
			new URLSearchParams({
				av,
				__d: "www",
				__user: "0",
				__a: "1",
				__comet_req: "7",
				__crn: "comet.igweb.PolarisProfilePostsTabRoute",
				fb_dtsg: dtsg,
				lsd,
				jazoest: `2${Array.from(dtsg).reduce((sum, char) => sum + char.charCodeAt(0), 0)}`,
				fb_api_caller_class: "RelayModern",
				fb_api_req_friendly_name: operation,
				server_timestamps: "true",
				doc_id: docId,
				variables: JSON.stringify(variables),
			}),
			{
				"X-FB-Friendly-Name": operation,
				"X-FB-LSD": lsd,
				"X-Root-Field-Name": field,
				"X-ASBD-ID": "359341",
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Dest": "empty",
			},
		);
		const connection = object(object(data.data)[field]);
		if (!Array.isArray(connection.edges)) throw new StoryError("CATALOG_STALE", "ハイライトの応答形式を確認できません");
		const info = object(connection.page_info);
		if (
			typeof info.has_next_page !== "boolean" ||
			(info.has_next_page && (typeof info.end_cursor !== "string" || !info.end_cursor))
		)
			throw new StoryError("CATALOG_STALE", "ハイライトの全件取得を確認できません");
		return {
			nodes: connection.edges.map((edge: unknown) => object(object(edge).node)),
			next: info.has_next_page ? String(info.end_cursor) : null,
		};
	}
	async #allHighlights(kind: "tray" | "items", variables: Json, signal: AbortSignal): Promise<Json[]> {
		const nodes: Json[] = [];
		const cursors = new Set<string>();
		let after: string | null = null;
		for (let page = 0; page < 100; page++) {
			const result = await this.#highlightConnection(kind, { ...variables, after }, signal);
			nodes.push(...result.nodes);
			if (!result.next) return nodes;
			if (cursors.has(result.next)) break;
			cursors.add(result.next);
			after = result.next;
		}
		throw new StoryError("CATALOG_STALE", "ハイライトのページングが完了しません。途中結果は返しません");
	}
	async listHighlights(signal: AbortSignal): Promise<{ account: StoryAccount; highlights: Highlight[] }> {
		const account = await this.getAccount(signal);
		const nodes = await this.#allHighlights("tray", { user_id: account.id }, signal);
		const highlights = nodes.map((reel) => {
			const id = typeof reel.id === "string" ? /^highlight:(\d+)$/.exec(reel.id)?.[1] : undefined;
			if (
				!id ||
				typeof reel.title !== "string" ||
				numericId(object(reel.user).pk ?? object(reel.user).id) !== account.id
			)
				throw new StoryError("CATALOG_STALE", "自分のハイライトを照合できません");
			return { id, title: reel.title };
		});
		return { account, highlights };
	}
	async highlightItems(id: string, signal: AbortSignal): Promise<string[]> {
		validateId(id);
		const reels = await this.#allHighlights(
			"items",
			{
				initial_reel_id: `highlight:${id}`,
				reel_ids: [`highlight:${id}`],
				first: 3,
				last: 2,
				__relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
			},
			signal,
		);
		if (reels.length !== 1) throw new StoryError("CATALOG_STALE", "対象ハイライトを一意に照合できません");
		const reel = reels[0] ?? {};
		if (
			reel.id !== `highlight:${id}` ||
			numericId(object(reel.user).pk ?? object(reel.user).id) !== this.#session.account.id ||
			!Array.isArray(reel.items)
		)
			throw new StoryError("CATALOG_STALE", "登録済みストーリーを照合できません");
		return reel.items.map((item: unknown) => {
			const media = object(item);
			const pk = numericId(media.pk);
			if (!pk || (media.user && numericId(object(media.user).pk ?? object(media.user).id) !== this.#session.account.id))
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
				source: "story_viewer_profile",
				added_media_ids: JSON.stringify([`${mediaId}_${this.#session.account.id}`]),
				removed_media_ids: "[]",
			}),
		);
	}
	async uploadPhoto(id: string, bytes: Uint8Array, width: number, height: number, mime: string, signal: AbortSignal) {
		validateId(id);
		const entity = `story_${id}`;
		const response = await this.#json("i.instagram.com", `/rupload_igphoto/${entity}`, signal, bytes, {
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
		if (numericId(response.upload_id) !== id)
			throw new StoryError("UPLOAD_FAILED", "アップロードした画像のIDが一致しません");
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
		const initialized = await this.#json(
			"i.instagram.com",
			`/rupload_igvideo/${entity}`,
			signal,
			undefined,
			headers,
			"rupload-init",
		);
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
		feedPost?: StoryFeedPostReference,
	): Promise<string> {
		validateId(id);
		let attachment: Record<string, string> = {};
		if (feedPost) {
			const source = await this.getFeedPost(feedPost.shortcode, signal);
			if (source.mediaId !== feedPost.mediaId || source.ownerId !== feedPost.ownerId)
				throw new StoryError("MEDIA_NOT_ALLOWED", "元投稿の参照先が変わりました");
			attachment = {
				reshared_media_id: source.mediaId,
				tap_models: JSON.stringify([
					{
						x: 0.5,
						y: 0.5,
						z: 0,
						width: (Math.min(950 / source.width, 1360 / source.height) * source.width) / 1080,
						height: (Math.min(950 / source.width, 1360 / source.height) * source.height + 80) / 1920,
						rotation: 0,
						type: "feed_media",
						media_id: source.mediaId,
						media_owner_id: source.ownerId,
						product_type: "feed",
						is_sticker: true,
						tap_state: 0,
						tap_state_str_id: "feed_post_sticker_square",
					},
				]),
			};
		}
		const body = {
			upload_id: id,
			...attachment,
			configure_mode: "1",
			caption,
			share_to_facebook: "",
			share_to_fb_destination_id: "",
			share_to_fb_destination_type: "USER",
			...(audience === "close_friends" ? { audience: "besties" } : {}),
		};
		// Web向けのフォームはfeed_mediaを反映しない。カードだけモバイルAPIの形式で送る。
		const nativeBody = {
			...body,
			_uid: this.#session.account.id,
			_csrftoken: this.#cookie("csrftoken"),
			source_type: "4",
			creation_surface: "camera",
			capture_type: "normal",
			original_media_type: "photo",
			camera_session_id: randomUUID(),
			client_timestamp: String(Math.floor(Date.now() / 1000)),
			client_shared_at: String(Math.floor(Date.now() / 1000) - 1),
			extra: { source_width: 1080, source_height: 1920 },
		};
		const data = await this.#json(
			feedPost ? "i.instagram.com" : "www.instagram.com",
			"/api/v1/media/configure_to_story/",
			signal,
			feedPost
				? new URLSearchParams({ signed_body: `SIGNATURE.${JSON.stringify(nativeBody)}` })
				: new URLSearchParams(body),
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
		if (feedPost) {
			let proof = media;
			if (!Array.isArray(proof.story_feed_media)) {
				const read = await this.#json("i.instagram.com", `/api/v1/media/${pk}/info/`, signal);
				proof = object(Array.isArray(read.items) && read.items.length === 1 ? read.items[0] : undefined);
			}
			const links = Array.isArray(proof.story_feed_media) ? proof.story_feed_media : [];
			if (
				numericId(proof.pk) !== pk ||
				numericId(object(proof.user).pk) !== account.id ||
				!links.some(
					(link) =>
						numericId(object(link).media_id) === feedPost.mediaId &&
						(object(link).media_owner_id === undefined || numericId(object(link).media_owner_id) === feedPost.ownerId),
				)
			)
				throw new StoryError("PUBLICATION_UNKNOWN", "公開後の元投稿リンクを確認できません。再送しません", pk);
		}
		return pk;
	}
	close() {
		this.#closed = true;
	}
}
