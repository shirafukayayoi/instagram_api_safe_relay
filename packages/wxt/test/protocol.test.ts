import { describe, expect, it } from "vitest";
import { validateRpcRequest } from "../src/protocol.js";
import { parseInput, parseResult } from "../src/validation.js";
import { InstagramWxtError } from "../src/errors.js";

describe("WXT の二重境界検証", () => {
	it("4操作以外の RPC を拒否する", () => {
		const channel = new MessageChannel();
		expect(
			validateRpcRequest({ id: "1", command: "execute", args: ["dispatch", {}], port: channel.port1 }),
		).toBeUndefined();
		channel.port1.close();
		channel.port2.close();
	});

	it("strict な入力を content 側でも検証する", () => {
		expect(() => parseInput("getPublicMedia", { shortcode: "ok", extra: true })).toThrow(InstagramWxtError);
	});

	it("未検証の MAIN-world 応答を公開しない", () => {
		expect(() => parseResult("getPublicMedia", { ok: true, data: { id: "x" } })).toThrow(
			expect.objectContaining({ code: "UPSTREAM_CHANGED" }),
		);
	});

	it("MAIN-worldの安定エラーコードを保持する", () => {
		expect(() => parseResult("getPublicMedia", { ok: false, error: { code: "NOT_PUBLIC", message: "private" } })).toThrow(
			expect.objectContaining({ code: "NOT_PUBLIC" }),
		);
	});
});
