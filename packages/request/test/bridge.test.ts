import { describe, expect, it } from "vitest";
import { parseExecuteInput, parseExecuteResult } from "../src/bridge.js";
import { InstagramBrowserError } from "../src/errors.js";

describe("request 契約境界", () => {
	it("カタログ外の入力を送信前に拒否する", () => {
		expect(() => parseExecuteInput("getPublicProfile", { username: "bad/name" })).toThrow(InstagramBrowserError);
	});

	it("inject の profile 表現を公開 DTO として検証する", () => {
		const result = parseExecuteResult("getPublicProfile", {
			ok: true,
			data: {
				id: "1",
				username: "instagram",
				fullName: "Instagram",
				biography: undefined,
				profilePictureUrl: undefined,
				isVerified: true,
				followers: 1,
				following: 2,
				mediaCount: 3,
			},
		});
		expect(result).toMatchObject({ id: "1", avatarUrl: null, followerCount: 1 });
	});

	it("古いカタログを安定エラーに変換する", () => {
		expect(() => parseExecuteResult("getPublicMedia", { ok: false, code: "CATALOG_STALE" })).toThrow(
			expect.objectContaining({ code: "CATALOG_STALE" }),
		);
	});

	it("公開不可とレート制限のエラーコードを保持する", () => {
		for (const code of ["NOT_PUBLIC", "RATE_LIMITED"] as const) {
			expect(() => parseExecuteResult("getPublicMedia", { ok: false, error: { code, message: code } })).toThrow(
				expect.objectContaining({ code }),
			);
		}
	});
});
