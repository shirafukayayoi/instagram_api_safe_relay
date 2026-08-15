import { chromium, firefox, webkit, type BrowserContext } from "playwright";
import type { Settings } from "./settings.js";

type BrowserSettings = Settings["profiles"][number]["browser"];

export const openBrowserContext = async (settings: BrowserSettings): Promise<BrowserContext> => {
	if (settings.type === "cdp") {
		const browser = await chromium.connectOverCDP(settings.cdpEndpoint);
		return browser.contexts()[0] ?? (await browser.newContext());
	}

	const browserType = { chromium, firefox, webkit }[settings.browserType];
	const proxy = settings.proxy ? {
		server: settings.proxy.server,
		...(settings.proxy.bypass ? { bypass: settings.proxy.bypass } : {}),
		...(settings.proxy.username ? { username: settings.proxy.username } : {}),
		...(settings.proxy.password ? { password: settings.proxy.password } : {}),
	} : undefined;
	return browserType.launchPersistentContext(settings.userDataDir, {
		headless: settings.headless,
		...(settings.executablePath ? { executablePath: settings.executablePath } : {}),
		args: settings.args,
		...(settings.viewport ? { viewport: settings.viewport } : {}),
		...(proxy ? { proxy } : {}),
	});
};
