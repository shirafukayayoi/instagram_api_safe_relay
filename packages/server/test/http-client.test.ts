import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstagramHttpClient } from "../src/http/client.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const account = { id: "123", username: "owner" };
const fixture = async (responses: Response[], options: { invalidPermissions?: boolean } = {}) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ig-http-"));
	directories.push(directory);
	const file = path.join(directory, "session.json");
	await fs.writeFile(
		file,
		JSON.stringify({
			version: 1,
			account,
			userAgent: "test",
			cookies: [
				{ name: "sessionid", value: "SECRET", domain: ".instagram.com", path: "/", secure: true, expires: null },
				{ name: "csrftoken", value: "CSRF_SECRET", domain: ".instagram.com", path: "/", secure: true, expires: null },
				{ name: "ds_user_id", value: "123", domain: ".instagram.com", path: "/", secure: true, expires: null },
			],
		}),
		{ mode: options.invalidPermissions ? 0o644 : 0o600 },
	);
	const fetcher = vi.fn<typeof fetch>(async () => {
		const response = responses.shift();
		if (!response) throw new Error("予期しない通信");
		return response;
	});
	const onSessionError = vi.fn();
	return {
		file,
		fetcher,
		onSessionError,
		open: () => InstagramHttpClient.open(file, { fetch: fetcher, onSessionError }),
	};
};
const ok = (body: object) =>
	new Response(JSON.stringify({ status: "ok", ...body }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
const signal = () => new AbortController().signal;

describe("ブラウザーを使わない固定HTTP通信", () => {
	it("実ログインアカウントを読み取り、認証を固定ホストだけに送る", async () => {
		const f = await fixture([ok({ form_data: { username: "owner", email: "PRIVATE" } })]);
		const client = await f.open();
		expect(await client.getAccount(signal())).toEqual(account);
		expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
			"https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
	});
	it("権限が広いセッションファイル・リンクを拒否する", async () => {
		if (process.platform === "win32") return;
		const f = await fixture([], { invalidPermissions: true });
		await expect(f.open()).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
		await fs.chmod(f.file, 0o600);
		const link = path.join(path.dirname(f.file), "link.json");
		await fs.symlink(f.file, link);
		await expect(InstagramHttpClient.open(link)).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
	});
	it("別アカウント・失効・challenge・制限では停止し、認証値や本文を例外に含めない", async () => {
		for (const response of [
			ok({ form_data: { username: "other" } }),
			new Response("SECRET", { status: 302, headers: { Location: "https://example.com/" } }),
			ok({ challenge: { token: "SECRET" } }),
			new Response("SECRET", { status: 429 }),
		]) {
			const f = await fixture([response]);
			const client = await f.open();
			await expect(client.getAccount(signal())).rejects.toThrow(/一致しません|リダイレクト|追加認証|利用制限/);
			expect(f.fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("Cookie更新を権限600で保存し、次の読み取りで利用する", async () => {
		const updated = ok({ form_data: { username: "owner" } });
		updated.headers.append("Set-Cookie", "csrftoken=ROTATED; Path=/; Secure; HttpOnly");
		const f = await fixture([updated, ok({ form_data: { username: "owner" } })]);
		const client = await f.open();
		await client.getAccount(signal());
		await client.getAccount(signal());
		expect(
			JSON.parse(await fs.readFile(f.file, "utf8")).cookies.find((c: { name: string }) => c.name === "csrftoken").value,
		).toBe("ROTATED");
		if (process.platform !== "win32") expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
		expect(f.fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-CSRFToken": "ROTATED" });
	});
	it("親しい友達・文面・アカウントが一致した公開応答だけを成功にする", async () => {
		const f = await fixture([
			ok({ media: { pk: "999", user: { pk: "123" }, audience: "besties", caption: { text: "文面" } } }),
		]);
		const client = await f.open();
		expect(await client.publish("1234567890123", account, "close_friends", "文面", signal())).toBe("999");
		const body = f.fetcher.mock.calls[0]?.[1]?.body as URLSearchParams;
		expect(body.get("audience")).toBe("besties");
		expect(body.get("caption")).toBe("文面");
		expect(body.get("share_to_facebook")).toBe("");
	});
	it("限定公開の根拠・文面が欠けた結果やタイムアウトを再送しない", async () => {
		for (const media of [
			{ pk: "999", user: { pk: "123" } },
			{ pk: "999", user: { pk: "123" }, audience: "besties", caption: { text: "別" } },
			{ pk: "999", user: { pk: "456" }, audience: "besties", caption: { text: "文面" } },
		]) {
			const f = await fixture([ok({ media })]);
			const client = await f.open();
			await expect(client.publish("1234567890123", account, "close_friends", "文面", signal())).rejects.toMatchObject({
				code: "PUBLICATION_UNKNOWN",
			});
			expect(f.fetcher).toHaveBeenCalledTimes(1);
		}
		const f = await fixture([]);
		const client = await f.open();
		await expect(client.publish("1234567890123", account, "all", "", signal())).rejects.toMatchObject({
			code: "CATALOG_STALE",
		});
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
	it("大きな数値IDを丸めず、ハイライトのID・所有者を検証する", async () => {
		const f = await fixture([
			ok({ form_data: { username: "owner" } }),
			ok({ tray: [{ id: "highlight:17999999999999999", title: "保存先", user: { pk: "123" } }] }),
			new Response(
				'{"status":"ok","reels":{"highlight:17999999999999999":{"id":"highlight:17999999999999999","user":{"pk":123},"items":[{"pk":39999999999999999}]}}}',
			),
		]);
		const client = await f.open();
		expect((await client.listHighlights(signal())).highlights).toEqual([{ id: "17999999999999999", title: "保存先" }]);
		expect(await client.highlightItems("17999999999999999", signal())).toEqual(["39999999999999999"]);
		await expect(client.highlightItems("../../other", signal())).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(f.fetcher).toHaveBeenCalledTimes(3);
	});
	it("素材を固定アップロード先へ送り、既存offsetがあれば停止する", async () => {
		const f = await fixture([ok({ offset: 0 }), ok({}), ok({})]);
		const client = await f.open();
		await client.uploadVideo("1234567890123", new Uint8Array([1, 2]), 720, 1280, 2, signal());
		await client.uploadPhoto("1234567890123", new Uint8Array([3]), 720, 1280, "image/jpeg", signal());
		expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://i.instagram.com/rupload_igvideo/story_1234567890123",
			"https://i.instagram.com/rupload_igvideo/story_1234567890123",
			"https://i.instagram.com/rupload_igphoto/story_1234567890123",
		]);
		const other = await fixture([ok({ offset: 1 })]);
		const otherClient = await other.open();
		await expect(
			otherClient.uploadVideo("1234567890123", new Uint8Array([1]), 720, 1280, 2, signal()),
		).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
		expect(other.fetcher).toHaveBeenCalledTimes(1);
	});
});
