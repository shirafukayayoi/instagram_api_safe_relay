import type { ApiErrorCode } from "instagram-api-safe-contracts";

export type InstagramBrowserErrorCode =
	| ApiErrorCode
	| "BRIDGE_UNAVAILABLE"
	| "OPERATION_NOT_ALLOWED"
	| "REQUEST_FAILED"
	| "TIMEOUT"
	;

/** ブラウザ固有の詳細を外部へ漏らさない、安定したクライアントエラー。 */
export class InstagramBrowserError extends Error {
	readonly code: InstagramBrowserErrorCode;

	constructor(code: InstagramBrowserErrorCode, message: string) {
		super(message);
		this.name = "InstagramBrowserError";
		this.code = code;
	}
}

export const isPageDisconnectError = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error);
	return /target page, context or browser has been closed|browser has been closed|execution context was destroyed/i.test(message);
};
