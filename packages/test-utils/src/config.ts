import { readFile } from "node:fs/promises";
import path from "node:path";

export type SmokeBrowserType = "chromium" | "firefox" | "webkit";

export type SmokeLaunchOptions = {
	args?: string[];
	executablePath?: string;
	headless?: boolean;
	proxy?: {
		server: string;
		bypass?: string;
		username?: string;
		password?: string;
	};
	viewport?: { width: number; height: number };
};

export type SmokeConfig = {
	username: string;
	profileDir: string;
	home: string;
	browserType: SmokeBrowserType;
	launchOptions: SmokeLaunchOptions;
};

type Environment = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const requireUsername = (environment: Environment): string => {
	const username = environment.INSTAGRAM_SMOKE_USERNAME?.trim();
	if (!username) {
		throw new Error("INSTAGRAM_SMOKE_USERNAME を設定してください。");
	}
	if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
		throw new Error("INSTAGRAM_SMOKE_USERNAME が Instagram のユーザー名形式ではありません。");
	}
	return username;
};

const parseLaunchProfile = (settings: unknown) => {
	if (!isRecord(settings) || !Array.isArray(settings.profiles)) return undefined;
	for (const candidate of settings.profiles) {
		if (!isRecord(candidate) || !isRecord(candidate.browser) || candidate.browser.type !== "launch") continue;
		if (typeof candidate.browser.userDataDir !== "string" || candidate.browser.userDataDir.trim() === "") continue;
		const browserType = candidate.browser.browserType ?? "chromium";
		if (browserType !== "chromium" && browserType !== "firefox" && browserType !== "webkit") continue;
		return { profile: candidate, browser: candidate.browser, browserType };
	}
	return undefined;
};

const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

const parseLaunchOptions = (browser: Record<string, unknown>): SmokeLaunchOptions => {
	const options: SmokeLaunchOptions = {};
	if (typeof browser.headless === "boolean") options.headless = browser.headless;
	const executablePath = optionalString(browser.executablePath);
	if (executablePath) options.executablePath = executablePath;
	if (Array.isArray(browser.args) && browser.args.every((value) => typeof value === "string")) {
		options.args = [...browser.args];
	}
	if (
		isRecord(browser.viewport) &&
		Number.isInteger(browser.viewport.width) &&
		Number.isInteger(browser.viewport.height)
	) {
		options.viewport = { width: Number(browser.viewport.width), height: Number(browser.viewport.height) };
	}
	if (isRecord(browser.proxy) && typeof browser.proxy.server === "string" && browser.proxy.server.length > 0) {
		options.proxy = {
			server: browser.proxy.server,
			...(optionalString(browser.proxy.bypass) ? { bypass: String(browser.proxy.bypass) } : {}),
			...(optionalString(browser.proxy.username) ? { username: String(browser.proxy.username) } : {}),
			...(optionalString(browser.proxy.password) ? { password: String(browser.proxy.password) } : {}),
		};
	}
	return options;
};

const validateHome = (value: unknown): string => {
	const home = typeof value === "string" ? value : "https://www.instagram.com/";
	let url: URL;
	try {
		url = new URL(home);
	} catch {
		throw new Error("settings.json の home が有効な URL ではありません。");
	}
	if (url.protocol !== "https:" || url.hostname !== "www.instagram.com") {
		throw new Error("settings.json の home は https://www.instagram.com/ 配下に限定してください。");
	}
	return url.toString();
};

export const resolveSmokeConfig = async (
	environment: Environment = process.env,
	cwd = process.cwd(),
): Promise<SmokeConfig> => {
	const username = requireUsername(environment);
	const profileOverride = environment.INSTAGRAM_SMOKE_PROFILE_DIR?.trim();
	const settingsPath = path.resolve(
		cwd,
		environment.INSTAGRAM_SMOKE_SETTINGS ?? environment.INSTAGRAM_RELAY_SETTINGS ?? "../../settings.json",
	);

	let launchProfile: ReturnType<typeof parseLaunchProfile>;
	try {
		launchProfile = parseLaunchProfile(JSON.parse(await readFile(settingsPath, "utf8")));
	} catch {
		if (!profileOverride) {
			throw new Error(
				"settings.json を読めません。INSTAGRAM_SMOKE_SETTINGS または INSTAGRAM_SMOKE_PROFILE_DIR を指定してください。",
			);
		}
	}

	if (!launchProfile && !profileOverride) {
		throw new Error("settings.json に type=launch の profile がありません。");
	}

	const configuredDir = launchProfile ? String(launchProfile.browser.userDataDir) : undefined;
	// Relayと同じく、userDataDirはsettingsファイルの場所ではなくプロセスのcwd基準で解決する。
	const profileDir = path.resolve(cwd, profileOverride ?? configuredDir ?? "");
	return {
		username,
		profileDir,
		home: validateHome(launchProfile?.profile.home),
		browserType: launchProfile?.browserType ?? "chromium",
		launchOptions: launchProfile ? parseLaunchOptions(launchProfile.browser) : { headless: false },
	};
};
