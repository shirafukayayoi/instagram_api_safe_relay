import { describe, expect, it } from "vitest";
import {
	getOperationHttpPath,
	getPublicProfileInputSchema,
	listPublicProfileMediaInputSchema,
	mapVerifiedPublic,
	PublicAccessError,
} from "./index.js";

describe("入力契約", () => {
	it("未知のキーと 50 を超える limit を拒否する", () => {
		expect(() => getPublicProfileInputSchema.parse({ username: "openai", extra: true })).toThrow();
		expect(() => listPublicProfileMediaInputSchema.parse({ username: "openai", limit: 51 })).toThrow();
	});
});

describe("HTTP パス", () => {
	it("識別子を URL エンコードして対応する公開パスを返す", () => {
		expect(getOperationHttpPath("getPublicMedia", { shortcode: "Ab_c-1" })).toBe(
		"/v1/media/Ab_c-1",
	);
	});
});

describe("公開性の境界", () => {
	it("private 判定なら DTO 変換を実行せず NOT_PUBLIC を送出する", () => {
		let converted = false;
		const convert = () => {
			converted = true;
			return "実行されてはいけない";
		};
		expect(() => mapVerifiedPublic({ visibility: "private" }, convert)).toThrow(PublicAccessError);
		expect(converted).toBe(false);
	});
});
