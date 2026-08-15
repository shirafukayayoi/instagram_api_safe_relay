import { randomUUID } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import type { OperationInputMap, OperationName, RelayErrorCode } from "instagram-api-safe-contracts";
import { parseOperationInput } from "instagram-api-safe-contracts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { isAllowedHost, isAuthorized } from "./utils/auth.js";
import { SerialQueue } from "./utils/queue.js";
import type { RelayProfile, SafeTrace } from "./types.js";

type CreateAppOptions = {
	profiles: RelayProfile[];
	token: string;
	requestTimeoutMs?: number;
	dashboard?: boolean;
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

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Instagram Webから予期しない応答を受け取りました";

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => new Promise((resolve, reject) => {
	const timer = setTimeout(
		() => reject(Object.assign(new Error("操作がタイムアウトしました"), { code: "SESSION_NOT_READY" })),
		timeoutMs,
	);
	promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

export const createApp = ({ profiles, token, requestTimeoutMs = 30_000, dashboard = false }: CreateAppOptions) => {
	const app = new Hono();
	const queues = new Map(profiles.map((profile) => [profile.name, new SerialQueue()]));
	const listeners = new Set<(trace: SafeTrace) => void>();

	app.use("*", async (c, next) => {
		if (!isAllowedHost(c.req.header("host"))) return c.json({ error: { code: "AUTH_REQUIRED", message: "Hostが許可されていません" } }, 403);
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cross-Origin-Resource-Policy", "same-origin");
		c.header("Cross-Origin-Opener-Policy", "same-origin");
		c.header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
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
		if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		await next();
	});
	app.use("/api/*", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token)) return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		await next();
	});

	app.get("/profiles", async (c) => c.json({
		profiles: await Promise.all(profiles.map(async (profile) => ({
			name: profile.name,
			state: profile.state,
			catalog: profile.client ? await profile.client.getCatalogStatus().catch(() => ({})) : {},
		}))),
	}));

	app.get("/api/events", (c) => streamSSE(c, async (stream) => {
		const listener = (trace: SafeTrace) => void stream.writeSSE({ event: "trace", data: JSON.stringify(trace) });
		listeners.add(listener);
		try {
			if (!c.req.raw.signal.aborted) await new Promise<void>((resolve) => c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true }));
		} finally {
			listeners.delete(listener);
		}
	}));

	const emit = (trace: SafeTrace) => {
		for (const listener of listeners) listener(trace);
	};

	const resolveProfile = (header: string | undefined) => {
		if (header) return profiles.find((profile) => profile.name === header);
		return profiles.length === 1 ? profiles[0] : undefined;
	};

	const run = async <TName extends OperationName>(c: Context, operation: TName, rawInput: unknown) => {
		let input: OperationInputMap[TName];
		try {
			input = parseOperationInput(operation, rawInput);
		} catch (error) {
			return c.json({ error: { code: "INVALID_INPUT", message: errorMessage(error) } }, 400);
		}

		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return c.json({ error: { code: "UNKNOWN_PROFILE", message: "有効なx-profile-nameを指定してください" } }, 400);
		const client = profile.client;
		if (profile.state !== "ready" || !client) return c.json({ error: { code: "SESSION_NOT_READY", message: "ブラウザセッションの準備ができていません" } }, 503);

		const id = randomUUID();
		const startedAt = Date.now();
		emit({ id, profile: profile.name, operation, phase: "started", at: new Date(startedAt).toISOString() });
		try {
			const queue = queues.get(profile.name);
			if (!queue) throw Object.assign(new Error("プロファイルの実行キューがありません"), { code: "UNKNOWN_PROFILE" });
			const result = await withTimeout(queue.run(() => client.execute(operation, input)), requestTimeoutMs);
			emit({ id, profile: profile.name, operation, phase: "completed", status: 200, durationMs: Date.now() - startedAt, at: new Date().toISOString() });
			return c.json({ data: result });
		} catch (error) {
			const code = errorCode(error);
			const status = statusByCode[code];
			emit({ id, profile: profile.name, operation, phase: "failed", status, durationMs: Date.now() - startedAt, errorCode: code, at: new Date().toISOString() });
			return c.json({ error: { code, message: errorMessage(error) } }, status);
		}
	};

	app.get("/v1/profiles/:username", (c) => run(c, "getPublicProfile", { username: c.req.param("username") }));
	app.get("/v1/profiles/:username/media", (c) => run(c, "listPublicProfileMedia", {
		username: c.req.param("username"),
		kind: c.req.query("kind") || undefined,
		cursor: c.req.query("cursor") || undefined,
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
	}));
	app.get("/v1/media/:shortcode", (c) => run(c, "getPublicMedia", { shortcode: c.req.param("shortcode") }));
	app.get("/v1/media/:shortcode/comments", (c) => run(c, "listPublicMediaComments", {
		shortcode: c.req.param("shortcode"),
		cursor: c.req.query("cursor") || undefined,
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
	}));

	app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "ルートが存在しません" } }, 404));
	return app;
};
