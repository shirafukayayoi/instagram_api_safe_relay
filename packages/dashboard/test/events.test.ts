import { describe, expect, it } from "vitest";
import { parseSseChunk } from "../src/events";

describe("parseSseChunk", () => {
	it("完全なイベントだけを読み取る", () => {
		const result = parseSseChunk('event: trace\ndata: {"id":"1","profile":"a","operation":"getPublicProfile","phase":"completed","at":"2026-01-01T00:00:00Z"}\n\ndata: {');
		expect(result.entries).toHaveLength(1);
		expect(result.remainder).toBe("data: {");
	});
});

