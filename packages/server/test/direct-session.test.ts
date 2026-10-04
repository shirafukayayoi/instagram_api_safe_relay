import { describe, expect, it, vi } from "vitest";
import { createDmTransport } from "../src/direct/browser.js";

describe("DM通信のログイン転送", () => {
	for (const operation of ["inbox", "messages"] as const) {
		it(`${operation}のログインHTMLをセッション切れとして扱う`, async () => {
			let responseListener: (response: { url: () => string }) => void = () => undefined;
			const page = {
				on: vi.fn((_event, listener) => {
					responseListener = listener;
				}),
				goto: vi.fn(async () => undefined),
				waitForFunction: vi.fn(async () => undefined),
				route: vi.fn(async () => undefined),
				close: vi.fn(async () => undefined),
				evaluate: vi.fn(async () => {
					responseListener({ url: () => "https://www.instagram.com/accounts/login/" });
					return null;
				}),
			};
			const source = { context: () => ({ newPage: async () => page }) };
			const transport = await createDmTransport(source as never, new AbortController().signal);
			try {
				const request = operation === "inbox" ? transport.inbox({ limit: 1 }) : transport.messages("999", { limit: 1 });
				await expect(request).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
				await expect(transport.account()).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
			} finally {
				await transport.close();
			}
		});
	}
});
