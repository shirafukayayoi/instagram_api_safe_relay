import type { InstagramSessionStatus } from "instagram-api-safe-request";
import { createHighlightBrowser, type HighlightBrowser } from "./highlights/browser.js";
import { createBrowserStoryPublisher, type StoryPublisher } from "./stories/browser.js";
import { StoryError } from "./stories/errors.js";
import type { RelayProfile } from "./types.js";

export type MediaSession = {
	getSessionStatus: () => Promise<Pick<InstagramSessionStatus, "state">>;
	createPublisher: (signal: AbortSignal) => Promise<StoryPublisher>;
	createHighlights: (signal: AbortSignal) => Promise<HighlightBrowser>;
};
export const mediaReady = (profile: RelayProfile): boolean =>
	profile.state === "ready" && Boolean(profile.runMediaExclusive || (profile.client && profile.runExclusive));

export const withMediaSession = <T>(
	profile: RelayProfile,
	task: (session: MediaSession) => Promise<T>,
	overrides: {
		publisher?: typeof createBrowserStoryPublisher | undefined;
		highlights?: typeof createHighlightBrowser | undefined;
	} = {},
): Promise<T> => {
	if (profile.runMediaExclusive) return profile.runMediaExclusive(task);
	if (!profile.runExclusive) throw new StoryError("SESSION_NOT_READY", "プロファイルの実行キューがありません");
	return profile.runExclusive((client) =>
		task({
			getSessionStatus: client.getSessionStatus,
			createPublisher: (signal) => (overrides.publisher ?? createBrowserStoryPublisher)(client.page, signal),
			createHighlights: (signal) => (overrides.highlights ?? createHighlightBrowser)(client.page, signal),
		}),
	);
};
