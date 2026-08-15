import { describe, expect, it } from "vitest";
import {
	determineInstagramSessionState,
	type InstagramSessionProbe,
} from "../src/session.js";

const probe = (overrides: Partial<InstagramSessionProbe> = {}): InstagramSessionProbe => ({
	origin: "https://www.instagram.com",
	pathname: "/",
	hasBridge: true,
	hasTwoFactorInput: false,
	hasLoginFormOrInput: false,
	...overrides,
});

describe("determineInstagramSessionState", () => {
	it("two-factorを他のログイン・challenge兆候より優先する", () => {
		expect(
			determineInstagramSessionState(
				probe({
					pathname: "/challenge/",
					hasTwoFactorInput: true,
					hasLoginFormOrInput: true,
				}),
			),
		).toBe("two_factor_required");
		expect(determineInstagramSessionState(probe({ pathname: "/accounts/login/two_factor/" }))).toBe(
			"two_factor_required",
		);
	});

	it.each(["/challenge/", "/accounts/suspended/", "/checkpoint/abc"])(
		"%sをchallengeとして判定する",
		(pathname) => {
			expect(determineInstagramSessionState(probe({ pathname, hasLoginFormOrInput: true }))).toBe(
				"challenge_required",
			);
		},
	);

	it("login URLまたはlogin inputをログイン要求として判定する", () => {
		expect(determineInstagramSessionState(probe({ pathname: "/accounts/login/" }))).toBe(
			"login_required",
		);
		expect(determineInstagramSessionState(probe({ hasLoginFormOrInput: true }))).toBe(
			"login_required",
		);
	});

	it("Instagram origin上でbridgeが存在するとreadyを返す", () => {
		expect(determineInstagramSessionState(probe())).toBe("ready");
		expect(determineInstagramSessionState(probe({ origin: "https://m.instagram.com" }))).toBe("ready");
	});

	it("Instagram外またはbridge不在ならunknownを返す", () => {
		expect(determineInstagramSessionState(probe({ origin: "https://example.com" }))).toBe("unknown");
		expect(determineInstagramSessionState(probe({ hasBridge: false }))).toBe("unknown");
	});
});
