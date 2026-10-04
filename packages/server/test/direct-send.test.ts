import { describe, expect, it, vi } from "vitest";
import { sendDmThroughUi } from "../src/direct/browser-send.js";

const account = { id: "123", username: "owner" };
const thread = {
	id: "999",
	title: "会話",
	isGroup: false,
	canSendText: true,
	users: [{ id: "456", username: "recipient", displayName: "宛先" }],
};
const message = { id: "888", senderId: "123", timestamp: "123456", type: "text", text: "こんにちは" };
const fixture = (newMessage: boolean) => {
	let reads = 0;
	const editor = {
		waitFor: vi.fn(async () => undefined),
		fill: vi.fn(async () => undefined),
		press: vi.fn(async () => undefined),
	};
	const profile = { first: () => ({ waitFor: vi.fn(async () => undefined) }) };
	const page = {
		goto: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		waitForFunction: vi.fn(async () => undefined),
		waitForTimeout: vi.fn(async () => undefined),
		locator: vi.fn((selector: string) => (selector.includes("contenteditable") ? editor : profile)),
		evaluate: vi.fn(async (_fn, input) => {
			if (input.op === "account") return account;
			if (input.op === "thread") {
				reads++;
				return {
					account,
					thread,
					messages: reads > 1 && newMessage ? [{ ...message, id: "889" }, message] : [message],
					nextCursor: null,
					hasMore: false,
				};
			}
			return "777";
		}),
	};
	const source = { context: () => ({ newPage: async () => page }) };
	return { source, page, editor };
};
describe("DM画面送信", () => {
	it("既存本文を成功扱いせず、新しい自分のメッセージIDを読み戻す", async () => {
		const f = fixture(true);
		expect(await sendDmThroughUi(f.source as never, new AbortController().signal, "999", "こんにちは", account)).toBe(
			"889",
		);
		expect(f.page.goto).toHaveBeenLastCalledWith("https://www.instagram.com/direct/t/777/", expect.anything());
		expect(f.editor.fill).toHaveBeenCalledExactlyOnceWith("こんにちは");
		expect(f.editor.press).toHaveBeenCalledExactlyOnceWith("Enter");
		expect(f.page.close).toHaveBeenCalledOnce();
	});
	it("送信後に同じ本文の既存メッセージしかなければunknownとして再送しない", async () => {
		const f = fixture(false);
		await expect(
			sendDmThroughUi(f.source as never, new AbortController().signal, "999", "こんにちは", account),
		).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
		expect(f.editor.press).toHaveBeenCalledOnce();
		expect(f.page.close).toHaveBeenCalledOnce();
	});
	it("中断済みの要求は入力も送信もしない", async () => {
		const f = fixture(true);
		const controller = new AbortController();
		controller.abort();
		await expect(
			sendDmThroughUi(f.source as never, controller.signal, "999", "こんにちは", account),
		).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
		expect(f.editor.press).not.toHaveBeenCalled();
	});
});
