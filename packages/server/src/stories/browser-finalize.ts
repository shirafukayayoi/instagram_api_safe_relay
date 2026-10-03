import type { StoryAccount } from "instagram-api-safe-contracts";

/** page.evaluateで実行する。認証値・raw response・例外をブラウザから返さない。 */
export const finalizeStoryInBrowser = async ({
	uploadId,
	account,
	audience = "all",
	caption = "",
}: {
	uploadId: string;
	account: StoryAccount;
	audience?: "all" | "close_friends";
	caption?: string;
}): Promise<string | null> => {
	try {
		type Response = {
			media?: {
				pk?: string | number;
				id?: string;
				user?: { pk?: string | number };
				audience?: string;
				caption?: { text?: string } | null;
			};
		};
		type Finalizer = {
			apiPost: (endpoint: string, options: { body: Record<string, string> }) => Promise<{ data: Response }>;
			creationFinalizeStory: (
				id: string,
				caption: string,
				facebook: string,
				destination: string,
				type: string,
				genAI: boolean,
			) => Promise<Response>;
		};
		const loader = (
			window as unknown as {
				require: (
					name: string,
				) => Finalizer & { id?: string; data?: { username?: string }; get?: (name: string) => string };
			}
		).require;
		const viewer = loader("PolarisViewer");
		if (
			String(viewer.id) !== account.id ||
			viewer.data?.username !== account.username ||
			loader("Cookie").get?.("ds_user_id") !== account.id
		)
			return null;
		// PolarisInstapiはstatus/statusCodeを分離し、finalizerはdataだけを返す。
		// instagram-private-apiのMediaConfigureStoryBaseOptionsと同一の固定指定。
		// https://github.com/dilame/instagram-private-api/blob/master/src/types/media.configure-story.options.ts
		// 認証はWeb自身のPolarisInstapiが処理し、Nodeへ渡さない。
		const response =
			audience === "close_friends"
				? (
						await loader("PolarisInstapi").apiPost("/api/v1/media/configure_to_story/", {
							body: {
								caption,
								configure_mode: "1",
								share_to_facebook: "",
								share_to_fb_destination_id: "",
								share_to_fb_destination_type: "USER",
								upload_id: uploadId,
								audience: "besties",
							},
						})
					).data
				: await loader("PolarisAPICreationFinalizeStory").creationFinalizeStory(
						uploadId,
						caption,
						"",
						"",
						"USER",
						false,
					);
		const media = response.media;
		if (audience === "close_friends" && media?.audience !== "besties") return null;
		if (caption !== "" && media?.caption?.text !== caption) return null;
		if (!media?.pk || (media.user?.pk !== undefined && String(media.user.pk) !== account.id)) return null;
		if (typeof media.pk === "string" && /^\d+$/.test(media.pk)) return media.pk;
		if (typeof media.pk === "number" && Number.isSafeInteger(media.pk) && media.pk > 0) return String(media.pk);
		// unsafe integerでは、アカウントIDを含む正確な文字列IDがある場合だけ採用する。
		const exact = typeof media.id === "string" ? /^(\d+)_(\d+)$/.exec(media.id) : null;
		return exact?.[2] === account.id ? (exact[1] ?? null) : null;
	} catch {
		return null;
	}
};
