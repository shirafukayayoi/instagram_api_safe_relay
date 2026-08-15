import type { OperationName } from "instagram-api-safe-contracts";
import { InstagramWxtError } from "./errors.js";
import { isOperationName, parseInput } from "./validation.js";

export const RPC_EVENT = "instagram-api-safe:rpc";

export type RpcCommand = "waitStartup" | "execute" | "initHook" | "getCatalogStatus";
export type RpcRequest = Readonly<{ id: string; command: RpcCommand; args: unknown[]; port: MessagePort }>;
type RpcResponse = { id: string; ok: true; value: unknown } | { id: string; ok: false; code: string; message: string };

export type ValidatedCommand =
	| { command: "waitStartup" | "initHook" | "getCatalogStatus" }
	| { command: "execute"; operation: OperationName; input: unknown };

const isCommand = (value: unknown): value is RpcCommand =>
	value === "waitStartup" || value === "execute" || value === "initHook" || value === "getCatalogStatus";

const isPort = (value: unknown): value is MessagePort =>
	typeof value === "object" && value !== null && "postMessage" in value && "close" in value;

export const validateRpcRequest = (value: unknown): { id: string; port: MessagePort; command: ValidatedCommand } | undefined => {
	if (typeof value !== "object" || value === null) return undefined;
	const request = value as Partial<RpcRequest>;
	if (typeof request.id !== "string" || !isCommand(request.command) || !Array.isArray(request.args) || !isPort(request.port)) return undefined;

	if (request.command === "execute") {
		if (request.args.length !== 2 || !isOperationName(request.args[0])) return undefined;
		try {
			return { id: request.id, port: request.port, command: { command: "execute", operation: request.args[0], input: parseInput(request.args[0], request.args[1]) } };
		} catch {
			return undefined;
		}
	}
	if (request.args.length !== 0) return undefined;
	return { id: request.id, port: request.port, command: { command: request.command } };
};

const responseError = (id: string, error: unknown): RpcResponse => {
	if (error instanceof InstagramWxtError) return { id, ok: false, code: error.code, message: error.message };
	return { id, ok: false, code: "BRIDGE_UNAVAILABLE", message: "MAIN-world bridge を実行できませんでした。" };
};

export const installRpcHandler = (
	target: EventTarget,
	handle: (command: ValidatedCommand) => Promise<unknown>,
): (() => void) => {
	const listener = (event: Event) => {
		const request = validateRpcRequest((event as CustomEvent<unknown>).detail);
		if (!request) return;
		void (async () => {
			try {
				const value = await handle(request.command);
				request.port.postMessage({ id: request.id, ok: true, value } satisfies RpcResponse);
			} catch (error) {
				request.port.postMessage(responseError(request.id, error));
			} finally {
				request.port.close();
			}
		})();
	};
	target.addEventListener(RPC_EVENT, listener);
	return () => target.removeEventListener(RPC_EVENT, listener);
};

export type RpcClient = { request: (command: RpcCommand, args?: unknown[]) => Promise<unknown>; dispose: () => void };

export const createRpcClient = (target: EventTarget, timeoutMs = 15_000): RpcClient => {
	let nextId = 1;
	let disposed = false;
	const pending = new Map<string, (error: InstagramWxtError) => void>();

	const request = (command: RpcCommand, args: unknown[] = []): Promise<unknown> => {
		if (disposed) return Promise.reject(new InstagramWxtError("BROWSER_DISCONNECTED", "ページ遷移または拡張機能の終了により RPC が中断されました。"));
		const id = `${Date.now().toString(36)}-${nextId++}`;
		const channel = new MessageChannel();
		return new Promise((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				channel.port1.onmessage = null;
				channel.port1.close();
				pending.delete(id);
			};
			const timer = setTimeout(() => {
				finish();
				reject(new InstagramWxtError("TIMEOUT", "MAIN-world bridge の応答が時間切れになりました。"));
			}, timeoutMs);
			pending.set(id, (error) => {
				finish();
				reject(error);
			});
			channel.port1.onmessage = (event: MessageEvent<RpcResponse>) => {
				const response = event.data;
				if (!response || response.id !== id) return;
				finish();
				if (response.ok) resolve(response.value);
				else reject(new InstagramWxtError(response.code as InstagramWxtError["code"], response.message));
			};
			channel.port1.start();
			target.dispatchEvent(new CustomEvent(RPC_EVENT, { detail: { id, command, args, port: channel.port2 } satisfies RpcRequest }));
		});
	};

	return {
		request,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			for (const reject of pending.values()) reject(new InstagramWxtError("BROWSER_DISCONNECTED", "ページ遷移または拡張機能の終了により RPC が中断されました。"));
		},
	};
};
