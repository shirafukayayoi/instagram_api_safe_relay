import type { Hono, Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { StoryError, storyStatus } from "../stories/errors.js";
import type { HighlightService } from "./service.js";

export const mountHighlightRoutes = (
	app: Hono,
	service: HighlightService | undefined,
	resolve: (name: string | undefined) => string | undefined,
) => {
	const profile = (c: Context) => {
		if (!service) throw new StoryError("STORIES_DISABLED", "ハイライト機能は無効です");
		const name = resolve(c.req.header("x-profile-name"));
		if (!name) throw new StoryError("UNKNOWN_PROFILE", "有効なx-profile-nameを指定してください");
		return name;
	};
	const failure = (c: Context, error: unknown) => {
		const safe =
			error instanceof StoryError ? error : new StoryError("CATALOG_STALE", "ハイライト操作を確認できません");
		return c.json({ error: { code: safe.code, message: safe.message } }, storyStatus(safe.code));
	};
	app.use("/v1/highlights/:id/stories", bodyLimit({ maxSize: 8192 }));
	app.get("/v1/highlights", async (c) => {
		try {
			const name = profile(c);
			return c.json({ data: await service?.list(name) });
		} catch (error) {
			return failure(c, error);
		}
	});
	app.post("/v1/highlights/:id/stories", async (c) => {
		try {
			const name = profile(c);
			let input: unknown;
			try {
				input = await c.req.json();
			} catch {
				throw new StoryError("INVALID_INPUT", "有効なJSONが必要です");
			}
			return c.json(
				{ data: await service?.create(name, c.req.param("id"), c.req.header("idempotency-key"), input) },
				202,
			);
		} catch (error) {
			return failure(c, error);
		}
	});
	app.get("/v1/highlight-jobs/:id", (c) => {
		try {
			const name = profile(c);
			return c.json({ data: service?.get(name, c.req.param("id")) });
		} catch (error) {
			return failure(c, error);
		}
	});
};
