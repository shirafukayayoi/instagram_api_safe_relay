import { timingSafeEqual } from "node:crypto";

export const isAuthorized = (authorization: string | undefined, expectedToken: string) => {
	if (!authorization?.startsWith("Bearer ")) return false;
	const actual = Buffer.from(authorization.slice(7));
	const expected = Buffer.from(expectedToken);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const isAllowedHost = (host: string | undefined) => {
	if (!host) return false;
	const hostname = host.replace(/:\d+$/, "").toLowerCase();
	return hostname === "127.0.0.1" || hostname === "localhost";
};

