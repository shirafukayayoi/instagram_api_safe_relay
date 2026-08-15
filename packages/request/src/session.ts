export type InstagramSessionState =
	| "ready"
	| "login_required"
	| "two_factor_required"
	| "challenge_required"
	| "unknown";

export type InstagramSessionStatus = {
	state: InstagramSessionState;
	checkedAt: string;
};

export type InstagramSessionProbe = {
	origin: string;
	pathname: string;
	hasBridge: boolean;
	hasTwoFactorInput: boolean;
	hasLoginFormOrInput: boolean;
};

const isPath = (pathname: string, prefix: string): boolean =>
	pathname === prefix || pathname.startsWith(`${prefix}/`);

const isInstagramOrigin = (origin: string): boolean => {
	try {
		const url = new URL(origin);
		return (
			url.protocol === "https:" &&
			(url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com"))
		);
	} catch {
		return false;
	}
};

/** URLのpathと機密値を含まないDOMフラグだけからセッション状態を判定する。 */
export const determineInstagramSessionState = (probe: InstagramSessionProbe): InstagramSessionState => {
	if (isPath(probe.pathname, "/accounts/login/two_factor") || probe.hasTwoFactorInput) {
		return "two_factor_required";
	}

	if (
		isPath(probe.pathname, "/challenge") ||
		isPath(probe.pathname, "/accounts/suspended") ||
		isPath(probe.pathname, "/checkpoint")
	) {
		return "challenge_required";
	}

	if (isPath(probe.pathname, "/accounts/login") || probe.hasLoginFormOrInput) {
		return "login_required";
	}

	if (isInstagramOrigin(probe.origin) && probe.hasBridge) {
		return "ready";
	}

	return "unknown";
};
