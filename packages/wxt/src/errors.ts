import type { ApiErrorCode } from "instagram-api-safe-contracts";

export type InstagramWxtErrorCode =
	| ApiErrorCode
	| "BRIDGE_UNAVAILABLE"
	| "OPERATION_NOT_ALLOWED"
	| "REQUEST_FAILED"
	| "TIMEOUT"
	;

export class InstagramWxtError extends Error {
	readonly code: InstagramWxtErrorCode;

	constructor(code: InstagramWxtErrorCode, message: string) {
		super(message);
		this.name = "InstagramWxtError";
		this.code = code;
	}
}
