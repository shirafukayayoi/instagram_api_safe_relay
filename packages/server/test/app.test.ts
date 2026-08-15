import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const token = "0123456789abcdef0123456789abcdef";
const client = {
	execute: vi.fn(async () => ({ id: "1", username: "example", fullName: null, biography: null, avatarUrl: null, isVerified: false, followerCount: null, followingCount: null, mediaCount: null })),
	getCatalogStatus: vi.fn(async () => ({ getPublicProfile: "ready" })),
};

const app = createApp({ profiles: [{ name: "one", client: client as never, state: "ready" }], token });

describe("relay security boundary", () => {
	it("認証なしのデータアクセスを拒否する", async () => {
		const response = await app.request("http://127.0.0.1/v1/profiles/example", { headers: { host: "127.0.0.1" } });
		expect(response.status).toBe(401);
	});

	it("名前付きの公開プロフィール操作だけを実行する", async () => {
		const response = await app.request("http://127.0.0.1/v1/profiles/example", { headers: { host: "127.0.0.1", authorization: `Bearer ${token}` } });
		expect(response.status).toBe(200);
		expect(client.execute).toHaveBeenCalledWith("getPublicProfile", { username: "example" });
	});

	it("raw proxy routeを持たない", async () => {
		const response = await app.request("http://127.0.0.1/proxy/api/v1/friendships/create", { headers: { host: "127.0.0.1", authorization: `Bearer ${token}` } });
		expect(response.status).toBe(404);
	});

	it("外部Hostを拒否する", async () => {
		const response = await app.request("http://evil.example/health", { headers: { host: "evil.example" } });
		expect(response.status).toBe(403);
	});

	it("ブラウザ層の公開不可エラーを403として保持する", async () => {
		client.execute.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "NOT_PUBLIC" }));
		const response = await app.request("http://127.0.0.1/v1/media/C", { headers: { host: "127.0.0.1", authorization: `Bearer ${token}` } });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "NOT_PUBLIC" } });
	});
});
