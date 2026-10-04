export type PendingStory = { id: string; profile: string };
export const pendingStoryKey = "relayStoryPending";

// 公開前に保存できなければ送らない。壊れた記録も「未送信」とはみなさない。
export const readPendingStory = (): { pending: PendingStory | null; error: string | null } => {
	try {
		const value = localStorage.getItem(pendingStoryKey);
		if (value === null) return { pending: null, error: null };
		const parsed = JSON.parse(value) as Partial<PendingStory> | null;
		if (
			!parsed ||
			typeof parsed.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(parsed.id) ||
			typeof parsed.profile !== "string" ||
			!parsed.profile
		)
			throw new Error("INVALID_PENDING");
		return { pending: { id: parsed.id, profile: parsed.profile }, error: null };
	} catch {
		return { pending: null, error: "保存された操作を確認できません。ストレージの復旧と投稿結果の確認が必要です。" };
	}
};

export const savePendingStory = (pending: PendingStory): void => {
	localStorage.setItem(pendingStoryKey, JSON.stringify(pending));
};
export const clearPendingStory = (): void => localStorage.removeItem(pendingStoryKey);
