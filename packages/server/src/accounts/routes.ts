import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { StoryError, storyStatus } from "../stories/errors.js";
import type { AccountService } from "./service.js";

export const mountAccountRoutes = (app: Hono, accounts?: AccountService) => {
	app.get("/v1/accounts", (c) =>
		accounts
			? c.json({ data: accounts.list() })
			: c.json({ error: { code: "SESSION_NOT_READY", message: "アカウント管理を利用できません" } }, 503),
	);
	app.use(
		"/v1/accounts/select",
		bodyLimit({
			maxSize: 1024,
			onError: (c) =>
				c.json({ error: { code: "INVALID_INPUT", message: "切り替え要求は1KiB以下で指定してください" } }, 413),
		}),
	);
	app.post("/v1/accounts/select", async (c) => {
		try {
			if (!accounts) throw new StoryError("SESSION_NOT_READY", "アカウント管理を利用できません");
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				throw new StoryError("INVALID_INPUT", "有効なJSONが必要です");
			}
			return c.json({ data: await accounts.select(body) });
		} catch (error) {
			const safe =
				error instanceof StoryError
					? error
					: new StoryError("SESSION_NOT_READY", "切り替え先のアカウントを照合できません");
			return c.json({ error: { code: safe.code, message: safe.message } }, storyStatus(safe.code));
		}
	});
};
