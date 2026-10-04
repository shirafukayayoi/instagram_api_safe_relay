import { randomUUID } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import type { OperationInputMap, OperationName, RelayErrorCode } from "instagram-api-safe-contracts";
import { parseOperationInput } from "instagram-api-safe-contracts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { isAllowedHost, isAuthorized } from "./utils/auth.js";
import { SerialQueue } from "./utils/queue.js";
import type { RelayProfile, SafeTrace } from "./types.js";
import { StoryError, storyStatus } from "./stories/errors.js";
import type { StoryService } from "./stories/service.js";
import type { DmService } from "./direct/service.js";
import { DmError, dmStatus } from "./direct/errors.js";
import type { MentionService } from "./story-mentions/service.js";
import { mountMentionRoutes } from "./story-mentions/routes.js";

type CreateAppOptions = {
	profiles: RelayProfile[];
	token: string;
	requestTimeoutMs?: number;
	dashboard?: boolean;
	stories?: StoryService;
	direct?: DmService;
	storyMentions?: MentionService;
};

const statusByCode: Record<RelayErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503> = {
	AUTH_REQUIRED: 401,
	SESSION_NOT_READY: 503,
	CATALOG_STALE: 409,
	UPSTREAM_CHANGED: 502,
	RATE_LIMITED: 429,
	NOT_PUBLIC: 403,
	NOT_FOUND: 404,
	BROWSER_DISCONNECTED: 503,
	INVALID_INPUT: 400,
	UNKNOWN_PROFILE: 400,
};

const errorCode = (error: unknown): RelayErrorCode => {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = String(error.code) as RelayErrorCode;
		if (code in statusByCode) return code;
	}
	return "UPSTREAM_CHANGED";
};

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "Instagram Webから予期しない応答を受け取りました";

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(Object.assign(new Error("操作がタイムアウトしました"), { code: "SESSION_NOT_READY" })),
			timeoutMs,
		);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});

export const createApp = ({
	profiles,
	token,
	requestTimeoutMs = 30_000,
	dashboard = false,
	stories,
	direct,
	storyMentions,
}: CreateAppOptions) => {
	const app = new Hono();
	const queues = new Map(profiles.map((profile) => [profile.name, new SerialQueue()]));
	const listeners = new Set<(trace: SafeTrace) => void>();

	app.use("*", async (c, next) => {
		if (!isAllowedHost(c.req.header("host")))
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Hostが許可されていません" } }, 403);
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cross-Origin-Resource-Policy", "same-origin");
		c.header("Cross-Origin-Opener-Policy", "same-origin");
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		await next();
	});

	app.get("/health", (c) => c.json({ status: "ok" }));
	if (dashboard) {
		app.get("/", serveStatic({ path: "../dashboard/dist/index.html" }));
		app.use("/assets/*", serveStatic({ root: "../dashboard/dist" }));
	}

	app.use("/v1/*", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token)) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		}
		await next();
	});
	app.use("/profiles", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token))
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		await next();
	});
	app.use("/api/*", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token))
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		await next();
	});
	app.use(
		"/v1/stories",
		bodyLimit({
			maxSize: 8192,
			onError: (c) =>
				c.json({ error: { code: "INVALID_INPUT", message: "投稿要求のJSONは8KiB以下で指定してください" } }, 413),
		}),
	);

	app.get("/profiles", async (c) =>
		c.json({
			profiles: await Promise.all(
				profiles.map(async (profile) => ({
					name: profile.name,
					state: profile.state,
					catalog: profile.client ? await profile.client.getCatalogStatus().catch(() => ({})) : {},
				})),
			),
		}),
	);

	app.get("/api/events", (c) =>
		streamSSE(c, async (stream) => {
			const listener = (trace: SafeTrace) => void stream.writeSSE({ event: "trace", data: JSON.stringify(trace) });
			listeners.add(listener);
			try {
				if (!c.req.raw.signal.aborted)
					await new Promise<void>((resolve) =>
						c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
			} finally {
				listeners.delete(listener);
			}
		}),
	);

	const emit = (trace: SafeTrace) => {
		for (const listener of listeners) listener(trace);
	};

	const resolveProfile = (header: string | undefined) => {
		if (header) return profiles.find((profile) => profile.name === header);
		return profiles.length === 1 ? profiles[0] : undefined;
	};

	mountMentionRoutes(app, storyMentions, name => resolveProfile(name)?.name);
	const run = async <TName extends OperationName>(c: Context, operation: TName, rawInput: unknown) => {
		let input: OperationInputMap[TName];
		try {
			input = parseOperationInput(operation, rawInput);
		} catch (error) {
			return c.json({ error: { code: "INVALID_INPUT", message: errorMessage(error) } }, 400);
		}

		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile)
			return c.json({ error: { code: "UNKNOWN_PROFILE", message: "有効なx-profile-nameを指定してください" } }, 400);
		const client = profile.client;
		if (profile.state !== "ready" || !client)
			return c.json({ error: { code: "SESSION_NOT_READY", message: "ブラウザセッションの準備ができていません" } }, 503);

		const id = randomUUID();
		const startedAt = Date.now();
		emit({ id, profile: profile.name, operation, phase: "started", at: new Date(startedAt).toISOString() });
		try {
			const queue = queues.get(profile.name);
			if (!queue) throw Object.assign(new Error("プロファイルの実行キューがありません"), { code: "UNKNOWN_PROFILE" });
			const execution = profile.runExclusive
				? profile.runExclusive((active) => active.execute(operation, input))
				: queue.run(() => client.execute(operation, input));
			const result = await withTimeout(execution, requestTimeoutMs);
			emit({
				id,
				profile: profile.name,
				operation,
				phase: "completed",
				status: 200,
				durationMs: Date.now() - startedAt,
				at: new Date().toISOString(),
			});
			return c.json({ data: result });
		} catch (error) {
			const code = errorCode(error);
			const status = statusByCode[code];
			emit({
				id,
				profile: profile.name,
				operation,
				phase: "failed",
				status,
				durationMs: Date.now() - startedAt,
				errorCode: code,
				at: new Date().toISOString(),
			});
			return c.json({ error: { code, message: errorMessage(error) } }, status);
		}
	};

	app.get("/v1/profiles/:username", (c) => run(c, "getPublicProfile", { username: c.req.param("username") }));
	app.get("/v1/profiles/:username/media", (c) =>
		run(c, "listPublicProfileMedia", {
			username: c.req.param("username"),
			kind: c.req.query("kind") || undefined,
			cursor: c.req.query("cursor") || undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		}),
	);
	app.get("/v1/media/:shortcode", (c) => run(c, "getPublicMedia", { shortcode: c.req.param("shortcode") }));
	app.get("/v1/media/:shortcode/comments", (c) =>
		run(c, "listPublicMediaComments", {
			shortcode: c.req.param("shortcode"),
			cursor: c.req.query("cursor") || undefined,
			limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		}),
	);

	const storyFailure = (c: Context, error: unknown) => {
		const safe =
			error instanceof StoryError ? error : new StoryError("STORAGE_UNAVAILABLE", "投稿要求を処理できません");
		return c.json({ error: { code: safe.code, message: safe.message } }, storyStatus(safe.code));
	};
	app.use("/v1/story-previews", bodyLimit({ maxSize: 8192 }));
	app.use("/v1/story-previews/:id/publish", bodyLimit({ maxSize: 8192 }));
	const previewProfile = (c: Context) => {
		if (!stories) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
		return profile.name;
	};
	const storyJson = async (c: Context): Promise<unknown> => {
		try {
			return await c.req.json();
		} catch {
			throw new StoryError("INVALID_INPUT", "有効なJSONが必要です");
		}
	};
	// 素材表示・状態照会・キャンセルは公開処理を開始しない。
	app.post("/v1/story-previews", async (c) => {
		try {
			const profile = previewProfile(c);
			return c.json({ data: await stories?.preview(profile, await storyJson(c)) });
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	app.get("/v1/story-previews/:id", async (c) => {
		try {
			const profile = previewProfile(c);
			return c.json({ data: await stories?.getPreview(profile, c.req.param("id")) });
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	app.get("/v1/story-previews/:id/media", async (c) => {
		try {
			const profile = previewProfile(c);
			const media = await stories?.previewMedia(profile, c.req.param("id"));
			if (!media) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
			return c.body(new Uint8Array(media.bytes), 200, { "Content-Type": media.mimeType });
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	app.delete("/v1/story-previews/:id", async (c) => {
		try {
			const profile = previewProfile(c);
			await stories?.cancelPreview(profile, c.req.param("id"));
			return c.json({ cancelled: true });
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	// この呼出しだけが確認済みプレビューのアップロード・公開を開始する。
	app.post("/v1/story-previews/:id/publish", async (c) => {
		try {
			const profile = previewProfile(c);
			return c.json({ data: await stories?.publishPreview(profile, c.req.param("id"), await storyJson(c)) }, 202);
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	app.post("/v1/stories", async (c) => {
		try {
			if (!stories) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
			const profile = resolveProfile(c.req.header("x-profile-name"));
			if (!profile) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
			let input: unknown;
			try {
				input = await c.req.json();
			} catch {
				throw new StoryError("INVALID_INPUT", "有効なJSONが必要です");
			}
			return c.json({ data: await stories.create(profile.name, c.req.header("idempotency-key"), input) }, 202);
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	app.get("/v1/story-jobs/:id", (c) => {
		try {
			if (!stories) throw new StoryError("STORIES_DISABLED", "ストーリーズ投稿は無効です");
			const profile = resolveProfile(c.req.header("x-profile-name"));
			if (!profile) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
			return c.json({ data: stories.get(profile.name, c.req.param("id")) });
		} catch (error) {
			return storyFailure(c, error);
		}
	});
	const dmFailure = (c: Context, error: unknown) => {
		const safe = error instanceof DmError ? error : new DmError("UPSTREAM_CHANGED", "DM操作の結果を確認できません");
		return c.json({ error: { code: safe.code, message: safe.message } }, dmStatus(safe.code));
	};
	app.use(
		"/v1/dm/messages",
		bodyLimit({
			maxSize: 8192,
			onError: (c) => c.json({ error: { code: "INVALID_INPUT", message: "DM要求は8KiB以下で指定してください" } }, 413),
		}),
	);
	const dmProfile = (c: Context) => {
		if (!direct) throw new DmError("DM_DISABLED", "DM機能は無効です");
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) throw new DmError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
		return profile.name;
	};
	const dmPage = (c: Context) => ({
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		cursor: c.req.query("cursor") || undefined,
	});
	app.get("/v1/dm/threads", async (c) => {
		try {
			const name = dmProfile(c);
			return c.json({ data: await direct?.inbox(name, dmPage(c)) });
		} catch (error) {
			return dmFailure(c, error);
		}
	});
	app.get("/v1/dm/threads/:id/messages", async (c) => {
		try {
			const name = dmProfile(c);
			return c.json({ data: await direct?.messages(name, c.req.param("id"), dmPage(c)) });
		} catch (error) {
			return dmFailure(c, error);
		}
	});
	app.post("/v1/dm/messages", async (c) => {
		try {
			const name = dmProfile(c);
			let input: unknown;
			try {
				input = await c.req.json();
			} catch {
				throw new DmError("INVALID_INPUT", "有効なJSONが必要です");
			}
			return c.json({ data: await direct?.create(name, c.req.header("idempotency-key"), input) }, 202);
		} catch (error) {
			return dmFailure(c, error);
		}
	});
	app.get("/v1/dm/jobs/:id", (c) => {
		try {
			const name = dmProfile(c);
			return c.json({ data: direct?.get(name, c.req.param("id")) });
		} catch (error) {
			return dmFailure(c, error);
		}
	});
	app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "ルートが存在しません" } }, 404));
	return app;
};
