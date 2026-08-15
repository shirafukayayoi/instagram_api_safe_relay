/** 制限された MAIN world ブリッジの公開型。 */
import type { OperationInput, OperationName, OperationOutcome, PublicProfile } from "instagram-api-safe-contracts";

export type InstagramOperationName = OperationName;

export type InstagramApiSafeRequest<TName extends InstagramOperationName = InstagramOperationName> = {
	operationName: TName;
	input: OperationInput<TName>;
};

export type InstagramApiSafeHookEntry = Readonly<{
	request: Readonly<{
		operationName?: InstagramOperationName;
		method: string;
		origin: "https://www.instagram.com";
		path: string;
	}>;
	response: Readonly<{ status: number; ok: boolean; contentType?: string }>;
	requestAt: number;
	receivedAt: number;
}>;

export type InstagramApiSafeHook = (entry: InstagramApiSafeHookEntry) => void | Promise<void>;

export type InstagramOperationOutcome<TName extends InstagramOperationName = InstagramOperationName> = OperationOutcome<TName>;

/** @deprecated InstagramOperationOutcome を使用してください。 */
export type InstagramApiSafeResult = InstagramOperationOutcome;

export type InstagramPublicProfile = PublicProfile;

export type InstagramApiSafeGlobal = {
	waitStartup(): Promise<void>;
	execute<TName extends InstagramOperationName>(
		request: InstagramApiSafeRequest<TName>,
	): Promise<InstagramOperationOutcome<TName>>;
	setHook(hook: InstagramApiSafeHook | null | undefined): void;
	getCatalogStatus(): Readonly<Record<InstagramOperationName, "ready" | "CATALOG_STALE">>;
};

/** @deprecated InstagramApiSafeGlobal を使用してください。 */
export type InstagramApiSafe = InstagramApiSafeGlobal;

declare global {
	var instagramApiSafe: InstagramApiSafeGlobal;
}
