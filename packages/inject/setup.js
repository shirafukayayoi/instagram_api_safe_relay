/* document_start でページの MAIN world に注入するため import は持たない。公開面は globalThis.instagramApiSafe のみ。 */
(() => {
	const STATE_KEY = "__instagramApiSafeState_v1__";
	const PUBLIC_KEY = "instagramApiSafe";
	const INSTAGRAM_ORIGIN = "https://www.instagram.com";
	const OPERATION_NAMES = Object.freeze([
		"getPublicProfile",
		"listPublicProfileMedia",
		"getPublicMedia",
		"listPublicMediaComments",
	]);

	// 拡張機能が同じ document_start スクリプトを複数登録しても、ネイティブ関数を重ねて包まない。
	if (globalThis[STATE_KEY]) {
		return;
	}

	let resolveStartup;
	const state = {
		hook: undefined,
		nativeFetch: typeof globalThis.fetch === "function" ? globalThis.fetch : undefined,
		publicHeaders: Object.create(null),
		startup: new Promise((resolve) => {
			resolveStartup = resolve;
		}),
		xhrMetadata: new WeakMap(),
	};
	Object.defineProperty(globalThis, STATE_KEY, {
		configurable: false,
		enumerable: false,
		writable: false,
		value: state,
	});

	const makeUrl = (value) => {
		try {
			return new URL(value, globalThis.location?.origin ?? INSTAGRAM_ORIGIN);
		} catch {
			return undefined;
		}
	};

	const safeRequest = (method, value, operationName) => {
		const url = makeUrl(value);
		if (!url || url.origin !== INSTAGRAM_ORIGIN) {
			return undefined;
		}
		// query・fragment・header・cookie・body は意図的に除外する。query にも識別子や実験用トークンが入り得る。
		return Object.freeze({
			operationName,
			method: String(method ?? "GET").toUpperCase(),
			origin: INSTAGRAM_ORIGIN,
			path: url.pathname,
		});
	};

	const getContentType = (response) => {
		try {
			return response.headers?.get?.("content-type")?.split(";", 1)[0] ?? undefined;
		} catch {
			return undefined;
		}
	};

	const safeResponse = (response) => {
		try {
			return Object.freeze({
				status: Number(response.status),
				ok: Boolean(response.ok),
				contentType: getContentType(response),
			});
		} catch {
			return Object.freeze({ status: 0, ok: false });
		}
	};

	const notifyHook = (request, response, requestAt) => {
		const hook = state.hook;
		if (typeof hook !== "function" || !request) {
			return;
		}
		const entry = Object.freeze({
			request,
			response,
			requestAt,
			receivedAt: Date.now(),
		});
		// 観測処理はページのリクエストを変更・遅延・失敗させてはならない。
		Promise.resolve()
			.then(() => hook(entry))
			.catch(() => undefined);
	};

	const rememberPublicHeaders = (headers) => {
		if (!headers || typeof globalThis.Headers !== "function") return;
		try {
			const normalized = new globalThis.Headers(headers);
			for (const name of ["x-ig-app-id", "x-asbd-id"]) {
				const value = normalized.get(name);
				if (value && /^\d{1,32}$/.test(value)) state.publicHeaders[name] = value;
			}
		} catch {
			// 不正なheader表現は観測対象にせず、ページ本来の処理だけを継続する。
		}
	};

	const observeFetch = (input, init, response, requestAt) => {
		const inputUrl = typeof input === "string" || input instanceof URL ? input : input?.url;
		const method = init?.method ?? (typeof input === "object" ? input?.method : undefined) ?? "GET";
		if (typeof input === "object") rememberPublicHeaders(input?.headers);
		rememberPublicHeaders(init?.headers);
		notifyHook(safeRequest(method, inputUrl), safeResponse(response), requestAt);
	};

	if (state.nativeFetch) {
		const wrappedFetch = function (...args) {
			const requestAt = Date.now();
			const result = state.nativeFetch.apply(this, args);
			// async に置換せず元の Promise を返し、AbortError と Response 本文を変えない。
			Promise.resolve(result)
				.then((response) => observeFetch(args[0], args[1], response, requestAt))
				.catch(() => undefined);
			return result;
		};
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			writable: true,
			value: wrappedFetch,
		});
	}

	const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
	if (xhrPrototype && typeof xhrPrototype.open === "function" && typeof xhrPrototype.send === "function") {
		const nativeOpen = xhrPrototype.open;
		const nativeSend = xhrPrototype.send;
		const nativeSetRequestHeader = xhrPrototype.setRequestHeader;
		xhrPrototype.open = function (...args) {
			state.xhrMetadata.set(this, {
				request: safeRequest(args[0], args[1]),
				requestAt: Date.now(),
			});
			return nativeOpen.apply(this, args);
		};
		if (typeof nativeSetRequestHeader === "function") {
			xhrPrototype.setRequestHeader = function (name, value) {
				if (["x-ig-app-id", "x-asbd-id"].includes(String(name).toLowerCase()) && /^\d{1,32}$/.test(String(value))) {
					state.publicHeaders[String(name).toLowerCase()] = String(value);
				}
				return nativeSetRequestHeader.call(this, name, value);
			};
		}
		xhrPrototype.send = function (...args) {
			const metadata = state.xhrMetadata.get(this);
			if (metadata?.request) {
				const onLoadEnd = () => {
					this.removeEventListener?.("loadend", onLoadEnd);
					notifyHook(metadata.request, safeResponse(this), metadata.requestAt);
				};
				this.addEventListener?.("loadend", onLoadEnd, { once: true });
			}
			return nativeSend.apply(this, args);
		};
	}

	const failure = (code, message) => ({
		ok: false,
		error: { code, message, retryAfterSeconds: null },
	});

	const nullableText = (value) => (typeof value === "string" ? value : null);
	const nullableCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
	const nullableUrl = (value) => {
		if (typeof value !== "string") {
			return null;
		}
		try {
			const url = new URL(value);
			return url.protocol === "https:" ? url.toString() : null;
		} catch {
			return null;
		}
	};

	const profileProjector = (payload) => {
		const user = payload?.data?.user;
		if (!user || typeof user !== "object") {
			return undefined;
		}
		if (user.is_private === true) {
			return { visibility: "private" };
		}
		if (user.is_private !== false) return undefined;
		const id = typeof user.id === "string" ? user.id : typeof user.pk === "string" ? user.pk : undefined;
		const username = typeof user.username === "string" ? user.username : undefined;
		if (!id || !username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
			return undefined;
		}
		return {
			visibility: "public",
			data: {
				id,
				username,
				fullName: nullableText(user.full_name),
				biography: nullableText(user.biography),
				avatarUrl: nullableUrl(user.profile_pic_url),
				isVerified: user.is_verified === true,
				followerCount: nullableCount(user.edge_followed_by?.count),
				followingCount: nullableCount(user.edge_follow?.count),
				mediaCount: nullableCount(user.edge_owner_to_timeline_media?.count),
			},
		};
	};

	const shortcodeToMediaId = (shortcode) => {
		if (typeof shortcode !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(shortcode)) {
			return undefined;
		}
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		let value = 0n;
		for (const character of shortcode) {
			const index = alphabet.indexOf(character);
			if (index < 0) return undefined;
			value = value * 64n + BigInt(index);
		}
		return value > 0n ? value.toString() : undefined;
	};

	const isoTime = (value) => {
		if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
		if (Number.isSafeInteger(value) && value >= 0) {
			const date = new Date(value * 1000);
			return Number.isNaN(date.getTime()) ? null : date.toISOString();
		}
		return null;
	};

	const projectMedia = (item, expectedShortcode, verifiedPublicOwnerId) => {
		if (!item || typeof item !== "object" || item.user?.is_private === true) return undefined;
		const idValue = item.id ?? item.pk;
		const ownerId = item.user?.id ?? item.user?.pk;
		const shortcode = typeof item.code === "string" ? item.code : expectedShortcode;
		if (
			(typeof idValue !== "string" && typeof idValue !== "number") ||
			(typeof ownerId !== "string" && typeof ownerId !== "number") ||
			typeof item.user?.username !== "string" ||
			!shortcodeToMediaId(shortcode)
		) return undefined;
		if (verifiedPublicOwnerId !== undefined) {
			if (String(ownerId) !== String(verifiedPublicOwnerId)) return undefined;
		} else if (item.user?.is_private !== false) {
			return undefined;
		}
		const kind = item.product_type === "clips" ? "reel" : "post";
		const imageUrl = nullableUrl(item.image_versions2?.candidates?.[0]?.url);
		const videoUrl = nullableUrl(item.video_versions?.[0]?.url);
		return {
			id: String(idValue),
			shortcode,
			kind,
			caption: nullableText(item.caption?.text),
			permalink: `${INSTAGRAM_ORIGIN}/${kind === "reel" ? "reel" : "p"}/${encodeURIComponent(shortcode)}/`,
			displayUrl: imageUrl,
			thumbnailUrl: imageUrl,
			videoUrl,
			takenAt: isoTime(item.taken_at),
			likeCount: nullableCount(item.like_count),
			commentCount: nullableCount(item.comment_count),
			owner: { id: String(ownerId), username: item.user.username },
		};
	};

	const projectComment = (comment) => {
		if (!comment || typeof comment !== "object" || comment.user?.is_private !== false) return undefined;
		const idValue = comment.pk ?? comment.id;
		const authorId = comment.user?.pk ?? comment.user?.id;
		if (
			(typeof idValue !== "string" && typeof idValue !== "number") ||
			(typeof authorId !== "string" && typeof authorId !== "number") ||
			typeof comment.text !== "string" ||
			typeof comment.user?.username !== "string"
		) return undefined;
		return {
			id: String(idValue), text: comment.text, createdAt: isoTime(comment.created_at), likeCount: nullableCount(comment.comment_like_count),
			author: { id: String(authorId), username: comment.user.username, fullName: nullableText(comment.user.full_name), avatarUrl: nullableUrl(comment.user.profile_pic_url) },
		};
	};

	const upstreamCode = (status) => status === 401 || status === 403 ? "AUTH_REQUIRED" : status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "UPSTREAM_CHANGED";
	const fetchJson = async (url, operationName) => {
		const requestAt = Date.now();
		try {
			const response = await Reflect.apply(state.nativeFetch, globalThis, [
				url,
				{
					method: "GET",
					credentials: "include",
					redirect: "error",
					headers: { ...state.publicHeaders },
				},
			]);
			const responseInfo = safeResponse(response);
			notifyHook(safeRequest("GET", url, operationName), responseInfo, requestAt);
			if (!responseInfo.ok) return { error: failure(upstreamCode(responseInfo.status), "Instagramから公開データを取得できませんでした") };
			try {
				return { payload: await response.clone().json() };
			} catch {
				return { error: failure("UPSTREAM_CHANGED", "Instagram応答をJSONとして安全に読めませんでした") };
			}
		} catch {
			return { error: failure("BROWSER_DISCONNECTED", "Instagramへのリクエストを完了できませんでした") };
		}
	};

	const descriptor = Object.freeze({
		getPublicProfile: Object.freeze({
			status: "ready",
			build(input) {
				if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || typeof input.username !== "string") {
					return undefined;
				}
				const username = input.username.trim();
				if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
					return undefined;
				}
				return `${INSTAGRAM_ORIGIN}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
			},
			project: profileProjector,
		}),
		listPublicProfileMedia: Object.freeze({ status: "ready" }),
		getPublicMedia: Object.freeze({ status: "ready" }),
		listPublicMediaComments: Object.freeze({ status: "ready" }),
	});

	const validRequestShape = (request) => {
		if (!request || typeof request !== "object") {
			return false;
		}
		return Object.keys(request).every((key) => key === "operationName" || key === "input");
	};

	const execute = async (request) => {
		if (!validRequestShape(request) || !OPERATION_NAMES.includes(request.operationName)) {
			return failure("INVALID_INPUT", "許可されていない操作またはリクエスト形式です");
		}
		if (descriptor[request.operationName].status !== "ready") {
			return failure("CATALOG_STALE", "この操作のInstagramカタログは現在検証待ちです");
		}
		if (!state.nativeFetch) {
			return failure("BROWSER_DISCONNECTED", "ブラウザーのfetch APIを利用できません");
		}
		const input = request.input;
		if (
			request.operationName === "getPublicProfile" &&
			(!input || typeof input !== "object" || Object.keys(input).length !== 1 || Object.keys(input)[0] !== "username")
		) {
			return failure("INVALID_INPUT", "入力が操作カタログに一致しません");
		}
		const profileUrl = request.operationName === "getPublicProfile" || request.operationName === "listPublicProfileMedia"
			? descriptor.getPublicProfile.build({ username: input?.username })
			: undefined;
		if ((request.operationName === "getPublicProfile" || request.operationName === "listPublicProfileMedia") && !profileUrl) {
			return failure("INVALID_INPUT", "入力が操作カタログに一致しません");
		}
		if (request.operationName === "getPublicProfile") {
			const loaded = await fetchJson(profileUrl, request.operationName); if (loaded.error) return loaded.error;
			const projected = profileProjector(loaded.payload);
			return !projected ? failure("UPSTREAM_CHANGED", "Instagram応答を公開プロフィールへ安全に変換できませんでした") : projected.visibility === "private" ? failure("NOT_PUBLIC", "非公開プロフィールは取得できません") : { ok: true, data: projected.data };
		}
		if (request.operationName === "listPublicProfileMedia") {
			if (!input || typeof input !== "object" || !Object.keys(input).every((key) => ["username", "cursor", "limit", "kind"].includes(key)) || (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.trim().length === 0 || input.cursor.length > 512)) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) || (input.kind !== undefined && !["all", "post", "reel"].includes(input.kind))) return failure("INVALID_INPUT", "入力が操作カタログに一致しません");
			const loadedProfile = await fetchJson(profileUrl, request.operationName); if (loadedProfile.error) return loadedProfile.error;
			const profile = profileProjector(loadedProfile.payload); if (!profile) return failure("UPSTREAM_CHANGED", "Instagram応答を公開プロフィールへ安全に変換できませんでした"); if (profile.visibility === "private") return failure("NOT_PUBLIC", "非公開プロフィールは取得できません");
			const userId = profile.data.id; const count = input.limit ?? 12; const cursor = input.cursor ? `&max_id=${encodeURIComponent(input.cursor)}` : "";
			const loaded = await fetchJson(`${INSTAGRAM_ORIGIN}/api/v1/feed/user/${encodeURIComponent(userId)}/?count=${count}${cursor}`, request.operationName); if (loaded.error) return loaded.error;
			if (!Array.isArray(loaded.payload?.items)) return failure("UPSTREAM_CHANGED", "Instagram応答を公開メディア一覧へ安全に変換できませんでした");
			const items = loaded.payload.items.map((item) => projectMedia(item, undefined, userId)); if (items.some((item) => !item)) return failure("UPSTREAM_CHANGED", "Instagram応答を公開メディア一覧へ安全に変換できませんでした");
			return { ok: true, data: { items: (input.kind && input.kind !== "all" ? items.filter((item) => item.kind === input.kind) : items), nextCursor: typeof loaded.payload.next_max_id === "string" ? loaded.payload.next_max_id : null } };
		}
		const shortcode = typeof input?.shortcode === "string" ? input.shortcode.trim() : undefined; const mediaId = shortcodeToMediaId(shortcode);
		if (!mediaId || !input || typeof input !== "object" || !Object.keys(input).every((key) => request.operationName === "getPublicMedia" ? key === "shortcode" : ["shortcode", "cursor", "limit"].includes(key))) return failure("INVALID_INPUT", "入力が操作カタログに一致しません");
		if (request.operationName === "getPublicMedia") {
			const loaded = await fetchJson(`${INSTAGRAM_ORIGIN}/api/v1/media/${mediaId}/info/`, request.operationName); if (loaded.error) return loaded.error;
			const vendorItem = loaded.payload?.items?.[0];
			if (vendorItem?.user?.is_private === true) return failure("NOT_PUBLIC", "非公開メディアは取得できません");
			const item = projectMedia(vendorItem, shortcode); return !item ? failure("UPSTREAM_CHANGED", "Instagram応答を公開メディアへ安全に変換できませんでした") : { ok: true, data: item };
		}
		if ((input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.trim().length === 0 || input.cursor.length > 512)) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))) return failure("INVALID_INPUT", "入力が操作カタログに一致しません");
		const mediaCheck = await fetchJson(`${INSTAGRAM_ORIGIN}/api/v1/media/${mediaId}/info/`, request.operationName); if (mediaCheck.error) return mediaCheck.error;
		const mediaOwner = mediaCheck.payload?.items?.[0]?.user;
		if (mediaOwner?.is_private === true) return failure("NOT_PUBLIC", "非公開メディアのコメントは取得できません");
		if (mediaOwner?.is_private !== false) return failure("UPSTREAM_CHANGED", "メディアの公開性を確認できませんでした");
		const count = input.limit ?? 12; const cursor = input.cursor ? `&max_id=${encodeURIComponent(input.cursor)}` : "";
		const loaded = await fetchJson(`${INSTAGRAM_ORIGIN}/api/v1/media/${mediaId}/comments/?count=${count}${cursor}`, request.operationName); if (loaded.error) return loaded.error;
		if (!Array.isArray(loaded.payload?.comments)) return failure("UPSTREAM_CHANGED", "Instagram応答を公開コメント一覧へ安全に変換できませんでした");
		const publicComments = loaded.payload.comments.filter((comment) => comment?.user?.is_private === false);
		const items = publicComments.map(projectComment); if (items.some((item) => !item)) return failure("UPSTREAM_CHANGED", "Instagram応答を公開コメント一覧へ安全に変換できませんでした");
		return { ok: true, data: { items, nextCursor: typeof loaded.payload.next_max_id === "string" ? loaded.payload.next_max_id : null } };
	};

	const api = Object.freeze({
		waitStartup: () => state.startup,
		execute,
		setHook: (hook) => {
			if (hook !== undefined && hook !== null && typeof hook !== "function") {
				throw new TypeError("instagramApiSafe.setHook には関数、null、またはundefinedを指定してください");
			}
			state.hook = hook ?? undefined;
		},
		getCatalogStatus: () => Object.freeze(Object.fromEntries(OPERATION_NAMES.map((name) => [name, descriptor[name].status]))),
	});
	Object.defineProperty(globalThis, PUBLIC_KEY, {
		configurable: false,
		enumerable: true,
		writable: false,
		value: api,
	});

	resolveStartup();
})();
