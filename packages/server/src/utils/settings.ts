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
	home: z.string().url().refine((value) => new URL(value).hostname === "www.instagram.com").default("https://www.instagram.com/"),
	pageReloadIntervalMinutes: z.number().int().min(5).max(1440).optional(),
	browser: z.discriminatedUnion("type", [launchBrowserSchema, cdpBrowserSchema]),
});

export const settingsSchema = z.strictObject({
	port: z.number().int().min(1).max(65535).default(3000),
	logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
	logPrettyPrint: z.boolean().default(true),
	dashboard: z.boolean().default(true),
	requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
	sessionCheckIntervalSeconds: z.number().int().min(10).max(300).default(30),
	recoveryRetrySeconds: z.number().int().min(1).max(300).default(5),
	profiles: z.array(profileSchema).min(1).superRefine((profiles, context) => {
		const names = new Set<string>();
		for (const [index, profile] of profiles.entries()) {
			if (names.has(profile.name)) context.addIssue({ code: "custom", path: [index, "name"], message: "profile名が重複しています" });
			names.add(profile.name);
		}
	}),
});

export type Settings = z.infer<typeof settingsSchema>;
export const loadSettings = (input: unknown) => settingsSchema.parse(input);
