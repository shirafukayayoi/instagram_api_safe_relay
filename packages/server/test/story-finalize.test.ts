import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeStoryInBrowser } from "../src/stories/browser-finalize.js";

afterEach(() => vi.unstubAllGlobals());
const account = { id: "123", username: "owner" };
const fixture = (response: unknown, currentId = "123") => {
	const finalize = vi.fn(async () => response);
	vi.stubGlobal("window", {
		require: (name: string) => {
			if (name === "PolarisViewer") return { id: account.id, data: { username: account.username } };
			if (name === "Cookie") return { get: () => currentId };
			if (name === "PolarisAPICreationFinalizeStory") return { creationFinalizeStory: finalize };
			if (name === "PolarisInstapi")
				return { apiPost: async (...args: unknown[]) => ({ data: await finalize(...(args as [])) }) };
			throw new Error("UNKNOWN_MODULE");
		},
	});
	return finalize;
};

describe("ブラウザ内の公開確認", () => {
	it.each(["all", "close_friends"] as const)(
		"%sへ改行・日本語を含むキャプションを送信し、応答を検証する",
		async (audience) => {
			const caption = "コメントです🌸\n2行目";
			const finalize = fixture({
				media: { pk: "999", user: { pk: "123" }, audience: "besties", caption: { text: caption } },
			});
			expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account, audience, caption })).toBe("999");
			if (audience === "all")
				expect(finalize).toHaveBeenCalledExactlyOnceWith("1000000000000", caption, "", "", "USER", false);
			else
				expect(finalize).toHaveBeenCalledWith(
					"/api/v1/media/configure_to_story/",
					expect.objectContaining({ body: expect.objectContaining({ caption, audience: "besties" }) }),
				);
		},
	);
	it("キャプションの保存根拠がなければ成功とせず、再送しない", async () => {
		for (const caption of [undefined, null, { text: "別の文" }]) {
			const finalize = fixture({ media: { pk: "999", caption } });
			expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account, caption: "指定した文" })).toBeNull();
			expect(finalize).toHaveBeenCalledOnce();
		}
	});
	it("固定の公開先にbestiesを送り、限定公開の応答根拠を確認する", async () => {
		const finalize = fixture({ media: { pk: "999", user: { pk: "123" }, audience: "besties" } });
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account, audience: "close_friends" })).toBe("999");
		expect(finalize).toHaveBeenCalledExactlyOnceWith("/api/v1/media/configure_to_story/", {
			body: {
				caption: "",
				configure_mode: "1",
				share_to_facebook: "",
				share_to_fb_destination_id: "",
				share_to_fb_destination_type: "USER",
				upload_id: "1000000000000",
				audience: "besties",
			},
		});
	});
	it("公開範囲の根拠がなければ限定公開成功とせず、通常公開にも再送しない", async () => {
		for (const audience of [undefined, "all"]) {
			const finalize = fixture({ media: { pk: "999", user: { pk: "123" }, audience } });
			expect(
				await finalizeStoryInBrowser({ uploadId: "1000000000000", account, audience: "close_friends" }),
			).toBeNull();
			expect(finalize).toHaveBeenCalledTimes(1);
		}
	});
	it("statusを分離したInstagramモジュールの戻り値から証拠だけを返す", async () => {
		const finalize = fixture({ media: { pk: "999", user: { pk: "123" } }, confidential: "never-return-this" });
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBe("999");
		expect(finalize).toHaveBeenCalledExactlyOnceWith("1000000000000", "", "", "", "USER", false);
	});
	it("アカウントのCookieが変わったら公開要求を送らない", async () => {
		const finalize = fixture({ media: { pk: "999" } }, "456");
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBeNull();
		expect(finalize).not.toHaveBeenCalled();
	});
	it("公開IDがない応答・異なる所有者・通信エラーを成功にしない", async () => {
		for (const response of [
			{ upload_id: "1000000000000" },
			{ media: { pk: "999", user: { pk: "456" } } },
			{ media: { pk: "invalid" } },
		]) {
			fixture(response);
			expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBeNull();
		}
		fixture({});
		vi.stubGlobal("window", {
			require: () => {
				throw new Error("sensitive details");
			},
		});
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBeNull();
	});
	it("桁落ちした数値のpkは、正確な文字列IDと所有者を確認できる場合だけ採用する", async () => {
		fixture({ media: { pk: Number("3999999999999999999") } });
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBeNull();
		fixture({ media: { pk: Number("3999999999999999999"), id: "3999999999999999999_123" } });
		expect(await finalizeStoryInBrowser({ uploadId: "1000000000000", account })).toBe("3999999999999999999");
	});
});
