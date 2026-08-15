import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const setup = await readFile(new URL("../setup.js", import.meta.url), "utf8");

class FakeResponse {
	constructor(payload, status = 200) {
		this.payload = payload;
		this.status = status;
		this.ok = status >= 200 && status < 300;
		this.headers = { get: (name) => (name === "content-type" ? "application/json; charset=utf-8" : null) };
	}
	clone() {
		return new FakeResponse(this.payload, this.status);
	}
	async json() {
		return this.payload;
	}
}

const createContext = (payload = { data: { user: { id: "123", username: "safe.user", is_private: false, edge_followed_by: { count: 3 } } } }) => {
	const calls = [];
	const getPayload = typeof payload === "function" ? payload : () => payload;
	const context = {
		URL,
		Promise,
		Date,
		Object,
		String,
		Number,
		BigInt,
		Boolean,
		WeakMap,
		Headers,
		TypeError,
		encodeURIComponent,
		location: { origin: "https://www.instagram.com" },
		fetch: (url, init) => {
			calls.push({ url: String(url), init });
			return Promise.resolve(new FakeResponse(getPayload(String(url), init)));
		},
	};
	context.globalThis = context;
	return { context: vm.createContext(context), calls };
};

test("document_start injection is idempotent and does not stack fetch wrappers", async () => {
	const { context } = createContext();
	vm.runInContext(setup, context);
	const firstApi = context.instagramApiSafe;
	const firstFetch = context.fetch;
	vm.runInContext(setup, context);
	assert.equal(context.instagramApiSafe, firstApi);
	assert.equal(context.fetch, firstFetch);
	await firstApi.waitStartup();
});

test("catalog fetchはWindowをreceiverとしてnative fetchを呼ぶ", async () => {
	const calls = [];
	const context = {
		URL, Headers, Promise, Date, Object, String, Number, BigInt, Boolean, WeakMap, TypeError, Reflect, encodeURIComponent,
		location: { origin: "https://www.instagram.com" },
	};
	context.fetch = function (url, init) {
		if (this?.location?.origin !== "https://www.instagram.com") throw new TypeError("Illegal invocation");
		calls.push({ url, init });
		return Promise.resolve(new FakeResponse({ data: { user: { id: "123", username: "safe.user", is_private: false } } }));
	};
	context.globalThis = context;
	const sandbox = vm.createContext(context);
	vm.runInContext(setup, sandbox);
	const result = await sandbox.instagramApiSafe.execute({ operationName: "getPublicProfile", input: { username: "safe.user" } });
	assert.equal(result.ok, true);
	assert.equal(calls.length, 1);
});

test("execute allowlists exactly the catalog and builds the reviewed profile request", async () => {
	const { context, calls } = createContext();
	vm.runInContext(setup, context);
	const api = context.instagramApiSafe;
	assert.deepEqual({ ...api.getCatalogStatus() }, {
		getPublicProfile: "ready",
		listPublicProfileMedia: "ready",
		getPublicMedia: "ready",
		listPublicMediaComments: "ready",
	});
	const result = await api.execute({ operationName: "getPublicProfile", input: { username: "safe.user" } });
	assert.equal(result.ok, true);
	assert.deepEqual({ ...result.data }, {
		id: "123",
		username: "safe.user",
		fullName: null,
		biography: null,
		avatarUrl: null,
		isVerified: false,
		followerCount: 3,
		followingCount: null,
		mediaCount: null,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://www.instagram.com/api/v1/users/web_profile_info/?username=safe.user");
	assert.equal(calls[0].init.method, "GET");
	assert.equal(calls[0].init.credentials, "include");
	assert.equal(calls[0].init.redirect, "error");
	const invalidInput = await api.execute({ operationName: "getPublicProfile", input: { username: "safe", url: "https://evil.example" } });
	assert.equal(invalidInput.ok, false);
	assert.equal(invalidInput.error.code, "INVALID_INPUT");
	const rejectedOperation = await api.execute({ operationName: "anythingElse", url: "https://evil.example" });
	assert.equal(rejectedOperation.ok, false);
	assert.equal(rejectedOperation.error.code, "INVALID_INPUT");
	const malformedMedia = await api.execute({ operationName: "getPublicMedia" });
	assert.equal(malformedMedia.ok, false);
	assert.equal(malformedMedia.error.code, "INVALID_INPUT");
});

test("catalog media and comments use only reviewed fixed GET paths", async () => {
	const { context, calls } = createContext((url) => {
		if (url.includes("web_profile_info")) return { data: { user: { id: "123", username: "safe.user", is_private: false } } };
		if (url.includes("feed/user/")) return { items: [{ pk: "m1", code: "C", product_type: "feed", user: { pk: "123", username: "safe.user" } }], next_max_id: null };
		if (url.includes("/info/")) return { items: [{ pk: "m1", code: "C", product_type: "feed", user: { pk: "u1", username: "safe.user", is_private: false } }] };
		return { comments: [{ pk: "c1", text: "public", user: { pk: "u2", username: "commenter", is_private: false } }], next_max_id: null };
	});
	vm.runInContext(setup, context);
	const api = context.instagramApiSafe;
	assert.equal((await api.execute({ operationName: "listPublicProfileMedia", input: { username: "safe.user", limit: 1 } })).ok, true);
	assert.equal((await api.execute({ operationName: "getPublicMedia", input: { shortcode: "C" } })).ok, true);
	assert.equal((await api.execute({ operationName: "listPublicMediaComments", input: { shortcode: "C", limit: 1 } })).ok, true);
	assert.deepEqual(calls.map((call) => call.url), [
		"https://www.instagram.com/api/v1/users/web_profile_info/?username=safe.user",
		"https://www.instagram.com/api/v1/feed/user/123/?count=1",
		"https://www.instagram.com/api/v1/media/2/info/",
		"https://www.instagram.com/api/v1/media/2/info/",
		"https://www.instagram.com/api/v1/media/2/comments/?count=1",
	]);
	for (const call of calls) {
		assert.equal(call.init.method, "GET");
		assert.equal(call.init.credentials, "include");
		assert.equal(call.init.redirect, "error");
	}
});

test("private profile is rejected before a vendor response can escape", async () => {
	const { context } = createContext({
		data: { user: { id: "123", username: "private.user", is_private: true, biography: "not for callers" } },
	});
	vm.runInContext(setup, context);
	const result = await context.instagramApiSafe.execute({
		operationName: "getPublicProfile",
		input: { username: "private.user" },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "NOT_PUBLIC");
	assert.equal(JSON.stringify(result).includes("not for callers"), false);
});

test("private media comments are rejected before the comments endpoint is called", async () => {
	const { context, calls } = createContext((url) => {
		if (url.includes("/info/")) return { items: [{ pk: "m1", code: "C", user: { pk: "u1", username: "private.user", is_private: true } }] };
		return { comments: [{ pk: "c1", text: "secret" }] };
	});
	vm.runInContext(setup, context);
	const result = await context.instagramApiSafe.execute({
		operationName: "listPublicMediaComments",
		input: { shortcode: "C", limit: 1 },
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "NOT_PUBLIC");
	assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/v1/media/2/info/"]);
});

test("profile feedの別所有者を拒否し、公開性不明のコメント著者を除外する", async () => {
	const { context } = createContext((url) => {
		if (url.includes("web_profile_info")) return { data: { user: { id: "123", username: "safe.user", is_private: false } } };
		if (url.includes("feed/user/")) return { items: [{ pk: "m1", code: "C", user: { pk: "other", username: "other", is_private: false } }] };
		if (url.includes("/info/")) return { items: [{ pk: "m1", code: "C", user: { pk: "123", username: "safe.user", is_private: false } }] };
		return { comments: [{ pk: "c1", text: "unknown visibility", user: { pk: "u2", username: "commenter" } }] };
	});
	vm.runInContext(setup, context);
	const media = await context.instagramApiSafe.execute({ operationName: "listPublicProfileMedia", input: { username: "safe.user" } });
	assert.equal(media.ok, false);
	assert.equal(media.error.code, "UPSTREAM_CHANGED");
	const comments = await context.instagramApiSafe.execute({ operationName: "listPublicMediaComments", input: { shortcode: "C" } });
	assert.equal(comments.ok, true);
	assert.deepEqual([...comments.data.items], []);
});

test("native fetch observation redacts headers, cookies, body, and query strings", async () => {
	const { context, calls } = createContext();
	vm.runInContext(setup, context);
	const entries = [];
	context.instagramApiSafe.setHook((entry) => entries.push(entry));
	const response = await context.fetch("/api/v1/users/web_profile_info/?username=private&token=secret", {
		method: "POST",
		headers: { Cookie: "sessionid=secret", "X-CSRFToken": "secret", "X-IG-App-ID": "936619743392459" },
		body: "secret-body",
	});
	assert.equal(response.status, 200);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(entries.length, 1);
	assert.deepEqual({ ...entries[0].request }, {
		operationName: undefined,
		method: "POST",
		origin: "https://www.instagram.com",
		path: "/api/v1/users/web_profile_info/",
	});
	assert.equal(JSON.stringify(entries[0]).includes("secret"), false);
	const result = await context.instagramApiSafe.execute({ operationName: "getPublicProfile", input: { username: "safe.user" } });
	assert.equal(result.ok, true);
	assert.deepEqual({ ...calls[1].init.headers }, { "x-ig-app-id": "936619743392459" });
});
