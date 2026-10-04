import { z } from "zod";

const viewportSchema = z.strictObject({
	width: z.number().int().positive().default(1280),
	height: z.number().int().positive().default(900),
});

const proxySchema = z.strictObject({
	server: z.string().min(1),
	bypass: z.string().optional(),
	username: z.string().optional(),
	password: z.string().optional(),
});

const launchBrowserSchema = z.strictObject({
	type: z.literal("launch"),
	browserType: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
	userDataDir: z.string().min(1),
	headless: z.boolean().default(false),
	executablePath: z.string().optional(),
	args: z.array(z.string()).default([]),
	viewport: viewportSchema.optional(),
	proxy: proxySchema.optional(),
});

const cdpBrowserSchema = z.strictObject({
	type: z.literal("cdp"),
	browserType: z.literal("chromium").default("chromium"),
	cdpEndpoint: z.string().url(),
});

const profileSchema = z.strictObject({
	name: z.string().trim().min(1).max(64),
	home: z
		.string()
		.url()
		.refine((value) => new URL(value).hostname === "www.instagram.com")
		.default("https://www.instagram.com/"),
	pageReloadIntervalMinutes: z.number().int().min(5).max(1440).optional(),
	browser: z.discriminatedUnion("type", [launchBrowserSchema, cdpBrowserSchema]),
});

export const settingsSchema = z
	.strictObject({
		port: z.number().int().min(1).max(65535).default(3000),
		logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
		logPrettyPrint: z.boolean().default(true),
		dashboard: z.boolean().default(true),
		requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
		storyMentions: z.strictObject({
			enabled: z.boolean().default(false),
			stateDir: z.string().min(1).default("./story_mention_data"),
			operationTimeoutMs: z.number().int().min(30000).max(900000).default(300000),
		}).default({ enabled: false, stateDir: "./story_mention_data", operationTimeoutMs: 300000 }),
		direct: z
			.strictObject({
				enabled: z.boolean().default(false),
				stateDir: z.string().min(1).default("./dm_data"),
				operationTimeoutMs: z.number().int().min(30000).max(300000).default(60000),
			})
			.default({ enabled: false, stateDir: "./dm_data", operationTimeoutMs: 60000 }),
		stories: z
			.strictObject({
				enabled: z.boolean().default(false),
				allowedMediaDirectories: z.array(z.string().min(1)).default([]),
				stateDir: z.string().min(1).default("./story_data"),
				ffprobePath: z.string().min(1).default("ffprobe"),
				operationTimeoutMs: z.number().int().min(30_000).max(900_000).default(300_000),
			})
			.default({
				enabled: false,
				allowedMediaDirectories: [],
				stateDir: "./story_data",
				ffprobePath: "ffprobe",
				operationTimeoutMs: 300_000,
			}),
		sessionCheckIntervalSeconds: z.number().int().min(10).max(300).default(30),
		recoveryRetrySeconds: z.number().int().min(1).max(300).default(5),
		profiles: z
			.array(profileSchema)
			.min(1)
			.superRefine((profiles, context) => {
				const names = new Set<string>();
				for (const [index, profile] of profiles.entries()) {
					if (names.has(profile.name))
						context.addIssue({ code: "custom", path: [index, "name"], message: "profile名が重複しています" });
					names.add(profile.name);
				}
			}),
	})
	.superRefine((settings, context) => {
		if (!settings.stories.enabled) return;
		if (settings.stories.allowedMediaDirectories.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["stories", "allowedMediaDirectories"],
				message: "投稿用の許可ディレクトリが必要です",
			});
		}
		for (const [index, profile] of settings.profiles.entries()) {
			if (profile.browser.browserType !== "chromium") {
				context.addIssue({
					code: "custom",
					path: ["profiles", index, "browser", "browserType"],
					message: "ストーリーズ投稿にはChromiumが必要です",
				});
			}
		}
	});

export type Settings = z.infer<typeof settingsSchema>;
export const loadSettings = (input: unknown) => settingsSchema.parse(input);
