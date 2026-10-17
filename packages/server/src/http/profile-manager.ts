import type { MediaSession } from "../media-session.js";
import { StoryError } from "../stories/errors.js";
import type { RelayProfile } from "../types.js";
import { SerialQueue } from "../utils/queue.js";
import { createHttpHighlights, createHttpStoryPublisher } from "./adapters.js";
import { InstagramHttpClient } from "./client.js";

/** ブラウザーも常時ポーリングも起動しない。認証は開始時・各操作前に確認する。 */
export class HttpProfileManager {
	readonly #profile: RelayProfile;
	readonly #file: string;
	readonly #ffmpegPath: string;
	readonly #queue = new SerialQueue();
	#client?: InstagramHttpClient;
	#stopped = false;
	#controller = new AbortController();
	constructor(profile: RelayProfile, sessionFile: string, ffmpegPath = "ffmpeg") {
		this.#profile = profile;
		this.#file = sessionFile;
		this.#ffmpegPath = ffmpegPath;
		profile.runMediaExclusive = (task) =>
			this.#queue.run(async () => {
				const client = this.#client;
				if (this.#stopped || !client || profile.state !== "ready")
					throw new StoryError("SESSION_NOT_READY", "HTTPセッションの準備ができていません");
				const session: MediaSession = {
					getSessionStatus: async () => ({ state: profile.state === "ready" ? "ready" : "unknown" }),
					createPublisher: (signal) =>
						createHttpStoryPublisher(client, AbortSignal.any([signal, this.#controller.signal]), this.#ffmpegPath),
					createHighlights: (signal) =>
						createHttpHighlights(client, AbortSignal.any([signal, this.#controller.signal])),
				};
				return task(session);
			});
	}
	async start() {
		try {
			this.#client = await InstagramHttpClient.open(this.#file, {
				onSessionError: (state) => {
					this.#profile.state = state;
				},
			});
			this.#profile.account = await this.#client.getAccount(this.#controller.signal);
			this.#profile.state = "ready";
		} catch (error) {
			this.#profile.lastError = error instanceof StoryError ? error.code : "SESSION_NOT_READY";
			if (this.#profile.state === "starting") this.#profile.state = "login_required";
		}
	}
	async stop() {
		this.#stopped = true;
		this.#controller.abort();
		await this.#queue.run(async () => {
			this.#client?.close();
		});
		this.#profile.state = "session_not_ready";
	}
}
