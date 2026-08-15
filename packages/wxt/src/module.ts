import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { addEntrypoint, defineWxtModule } from "wxt/modules";

const require = createRequire(import.meta.url);
const setupPath = require.resolve("instagram-api-safe-inject/setup.js");
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const bridgePath = fileURLToPath(new URL(`./entrypoints/bridge.${extension}`, import.meta.url));
const matches = ["https://www.instagram.com/*", "https://*.instagram.com/*"];

export default defineWxtModule({
	name: "instagram-api-safe-wxt",
	async setup(wxt) {
		addEntrypoint(wxt, {
			type: "unlisted-script",
			name: "instagram-api-safe/bridge",
			inputPath: bridgePath,
			outputDir: wxt.config.outDir,
			options: await wxt.builder.importEntrypoint(bridgePath),
		});

		wxt.hooks.hook("build:publicAssets", async (_wxt, assets) => {
			assets.push({ relativeDest: "instagram-api-safe/setup.js", contents: await readFile(setupPath, "utf8") });
		});

		wxt.hooks.hook("build:manifestGenerated", (_wxt, manifest) => {
			manifest.web_accessible_resources ??= [];
			manifest.web_accessible_resources.push({
				resources: ["instagram-api-safe/setup.js", "instagram-api-safe/bridge.js"],
				matches,
			});
		});
	},
});
