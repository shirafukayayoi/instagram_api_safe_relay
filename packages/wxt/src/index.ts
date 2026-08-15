import type { OperationInput, OperationName, OperationResult } from "instagram-api-safe-contracts";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { injectScript, type ScriptPublicPath } from "wxt/utils/inject-script";
import { InstagramWxtError } from "./errors.js";
import { createRpcClient } from "./protocol.js";
import { type CatalogStatus, parseInput, parseResult } from "./validation.js";

export const INSTAGRAM_MATCHES = ["https://www.instagram.com/*", "https://*.instagram.com/*"] as const;

const SETUP_SCRIPT = "/instagram-api-safe/setup.js" as ScriptPublicPath;
const BRIDGE_SCRIPT = "/instagram-api-safe/bridge.js" as ScriptPublicPath;

export type InstagramWxtBrowser = {
	waitStartup: (timeoutMs?: number) => Promise<void>;
	execute: <TName extends OperationName>(operation: TName, input: OperationInput<TName>) => Promise<OperationResult<TName>>;
	initHook: () => Promise<void>;
	getCatalogStatus: () => Promise<CatalogStatus>;
	dispose: () => void;
};

/**
 * isolated content script から MAIN world の固定カタログへ接続する。
 * 注入する script は WXT module が web_accessible_resource として登録する。
 */
export const createInstagramBrowser = async (
	ctx: ContentScriptContext,
	options: { timeoutMs?: number } = {},
): Promise<InstagramWxtBrowser> => {
	await injectScript(SETUP_SCRIPT);
	const { script } = await injectScript(BRIDGE_SCRIPT, { keepInDom: true });
	const defaultTimeoutMs = options.timeoutMs ?? 15_000;
	const rpc = createRpcClient(script, defaultTimeoutMs);

	const waitStartup = async (timeoutMs = defaultTimeoutMs): Promise<void> => {
		if (timeoutMs === defaultTimeoutMs) {
			await rpc.request("waitStartup");
			return;
		}
		const oneShot = createRpcClient(script, timeoutMs);
		try {
			await oneShot.request("waitStartup");
		} finally {
			oneShot.dispose();
		}
	};

	const execute = async <TName extends OperationName>(operation: TName, input: OperationInput<TName>) => {
		const validatedInput = parseInput(operation, input);
		const raw = await rpc.request("execute", [operation, validatedInput]);
		// bridge.ts での検証をすり抜ける値も、content world で公開前に必ず拒否する。
		return parseResult(operation, { ok: true, data: raw });
	};

	const getCatalogStatus = async (): Promise<CatalogStatus> => {
		const status = await rpc.request("getCatalogStatus");
		if (typeof status !== "object" || status === null) {
			throw new InstagramWxtError("UPSTREAM_CHANGED", "カタログ状態の形式が不正です。");
		}
		for (const operation of ["getPublicProfile", "listPublicProfileMedia", "getPublicMedia", "listPublicMediaComments"] as const) {
			const value = (status as Record<string, unknown>)[operation];
			if (value !== "ready" && value !== "CATALOG_STALE") {
				throw new InstagramWxtError("UPSTREAM_CHANGED", "カタログ状態の形式が不正です。");
			}
		}
		return status as CatalogStatus;
	};

	const dispose = () => {
		rpc.dispose();
		script.remove();
	};
	ctx.onInvalidated(dispose);

	return {
		waitStartup,
		execute,
		initHook: async () => {
			await rpc.request("initHook");
		},
		getCatalogStatus,
		dispose,
	};
};

export { InstagramWxtError, type InstagramWxtErrorCode } from "./errors.js";
export type { CatalogStatus } from "./validation.js";
