import type { DmErrorCode } from "instagram-api-safe-contracts";

export class DmError extends Error {
	constructor(
		readonly code: DmErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DmError";
	}
}
export const dmStatus = (code: DmErrorCode): 400 | 403 | 404 | 409 | 503 => {
	if (code === "DM_DISABLED") return 403;
	if (code === "NOT_FOUND") return 404;
	if (code === "IDEMPOTENCY_CONFLICT") return 409;
	if (code === "INVALID_INPUT" || code === "UNKNOWN_PROFILE") return 400;
	return 503;
};
