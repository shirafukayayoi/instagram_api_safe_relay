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

export const parseSseChunk = (buffer: string) => {
	const entries: SafeTrace[] = [];
	const blocks = buffer.split("\n\n");
	const remainder = blocks.pop() ?? "";
	for (const block of blocks) {
		const line = block
			.split("\n")
			.find((candidate) => candidate.startsWith("data:"));
		if (!line) continue;
		try {
			entries.push(JSON.parse(line.slice(5).trim()) as SafeTrace);
		} catch {
			// 不完全または不正なイベントは次の完全なSSEブロックまで無視する。
		}
	}
	return { entries, remainder };
};
