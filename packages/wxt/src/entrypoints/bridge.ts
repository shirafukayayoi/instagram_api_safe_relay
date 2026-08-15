import type { InstagramApiSafe } from "instagram-api-safe-inject/types";
import type { UnlistedScriptDefinition } from "wxt";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { installRpcHandler } from "../protocol.js";
import { parseResult } from "../validation.js";

const bridge: UnlistedScriptDefinition = defineUnlistedScript(() => {
	const target = document.currentScript;
	if (!target) return;

	installRpcHandler(target, async (command) => {
		const api = globalThis.instagramApiSafe as InstagramApiSafe | undefined;
		if (!api) throw new Error("instagramApiSafe is unavailable");
		switch (command.command) {
			case "waitStartup":
				await api.waitStartup();
				return undefined;
			case "initHook":
				api.setHook(null);
				return undefined;
			case "getCatalogStatus":
				return api.getCatalogStatus();
			case "execute": {
				const raw = await api.execute({ operationName: command.operation, input: command.input } as never);
				// MAIN world で一度、content world で再度契約 DTO を検証する。
				return parseResult(command.operation, raw);
			}
		}
	});
});

export default bridge;
