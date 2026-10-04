import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { MentionService } from "./service.js";
import { MentionError } from "./store.js";

export const mountMentionRoutes = (
	app: Hono,
	service: MentionService | undefined,
	resolve: (name?: string) => string | undefined,
) => {
	const selected = (c: Context) => {
		if (!service) throw new MentionError("MENTIONS_DISABLED", "メンション受付は無効です");
		const profile = resolve(c.req.header("x-profile-name"));
		if (!profile) throw new MentionError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
		return profile;
	};
	const failure = (c: Context, error: unknown) => {
		const safe =
			error instanceof MentionError
				? error
				: new MentionError("UPSTREAM_CHANGED", "メンション操作の結果を確認できません");
		const status =
			safe.code === "INVALID_INPUT" || safe.code === "UNKNOWN_PROFILE"
				? 400
				: safe.code === "NOT_FOUND"
					? 404
					: safe.code === "IDEMPOTENCY_CONFLICT" || safe.code === "MENTION_UNAVAILABLE"
						? 409
						: 503;
		return c.json({ error: { code: safe.code, message: safe.message } }, status);
	};
	const emptyBody = async (c: Context) => {
		const body = await c.req.text();
		if (!body) return;
		try {
			const parsed = JSON.parse(body);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return;
		} catch {}
		throw new MentionError("INVALID_INPUT", "要求本文は空または空のJSONオブジェクトにしてください");
	};
	app.use(
		"/v1/story-mentions/*",
		bodyLimit({
			maxSize: 8192,
			onError: (c) => c.json({ error: { code: "INVALID_INPUT", message: "要求は8KiB以下にしてください" } }, 413),
		}),
	);
	app.post("/v1/story-mentions/refresh", async (c) => {
		try {
			const name = selected(c);
			await emptyBody(c);
			return c.json({ data: await service?.refresh(name) }, 202);
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get("/v1/story-mentions", async (c) => {
		try {
			const name = selected(c);
			return c.json({
				data: await service?.list(
					name,
					c.req.query("limit") ? Number(c.req.query("limit")) : 20,
					c.req.query("cursor"),
				),
			});
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get("/v1/story-mention-refresh-jobs/:id", (c) => {
		try {
			const name = selected(c);
			return c.json({ data: service?.get(name, c.req.param("id"), "refresh") });
		} catch (error) {
			return failure(c, error);
		}
	});
	app.post("/v1/story-mentions/:id/repost", async (c) => {
		try {
			const name = selected(c);
			await emptyBody(c);
			return c.json({ data: await service?.repost(name, c.req.param("id"), c.req.header("idempotency-key")) }, 202);
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get("/v1/story-repost-jobs/:id", (c) => {
		try {
			const name = selected(c);
			return c.json({ data: service?.get(name, c.req.param("id"), "repost") });
		} catch (error) {
			return failure(c, error);
		}
	});
};
