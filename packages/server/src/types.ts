import type { InstagramApiProfileClient } from "instagram-api-safe-request";

export type ProfileState =
	| "starting"
	| "recovering"
	| "ready"
	| "login_required"
	| "two_factor_required"
	| "challenge_required"
	| "unknown"
	| "session_not_ready"
	| "browser_disconnected";

export type RelayProfile = {
	account?: import("instagram-api-safe-contracts").StoryAccount;
	runMediaExclusive?: <T>(task: (session: import("./media-session.js").MediaSession) => Promise<T>) => Promise<T>;
	name: string;
	client?: InstagramApiProfileClient;
	state: ProfileState;
	lastError?: string;
	runExclusive?: <T>(task: (client: InstagramApiProfileClient) => Promise<T>) => Promise<T>;
};

export type SafeTrace = {
	id: string;
	profile: string;
	operation: string;
	phase: "started" | "completed" | "failed";
	status?: number;
	durationMs?: number;
	errorCode?: string;
	at: string;
};
