import type { StoryErrorCode } from "instagram-api-safe-contracts";

export class StoryError extends Error {
	constructor(
		readonly code: StoryErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StoryError";
	}
}

export const storyStatus = (code: StoryErrorCode): 400 | 403 | 404 | 409 | 413 | 503 => {
	switch (code) {
		case "STORIES_DISABLED":
		case "MEDIA_NOT_ALLOWED":
			return 403;
		case "NOT_FOUND":
			return 404;
		case "IDEMPOTENCY_CONFLICT":
		case "CONFIRMATION_REQUIRED":
		case "PREVIEW_EXPIRED":
		case "PREVIEW_CHANGED":
			return 409;
		case "MEDIA_TOO_LARGE":
			return 413;
		case "INVALID_INPUT":
		case "MEDIA_INVALID":
		case "UNKNOWN_PROFILE":
			return 400;
		default:
			return 503;
	}
};
