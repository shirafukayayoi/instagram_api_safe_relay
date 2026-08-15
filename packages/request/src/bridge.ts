import {
	operationResultSchemas,
	parseOperationInput,
	type OperationInput,
	type OperationName,
	type OperationResult,
} from "instagram-api-safe-contracts";
import type { InstagramApiSafeResult } from "instagram-api-safe-inject/types";
import { InstagramBrowserError } from "./errors.js";

export type CatalogStatus = Readonly<Record<OperationName, "ready" | "CATALOG_STALE">>;

const failureCode = (value: string): InstagramBrowserError["code"] => {
	switch (value) {
		case "AUTH_REQUIRED":
		case "SESSION_NOT_READY":
		case "CATALOG_STALE":
		case "UPSTREAM_CHANGED":
		case "RATE_LIMITED":
		case "NOT_PUBLIC":
		case "NOT_FOUND":
		case "BROWSER_DISCONNECTED":
		case "INVALID_INPUT":
		case "UNKNOWN_PROFILE":
		case "OPERATION_NOT_ALLOWED":
		case "REQUEST_FAILED":
			return value;
		default:
			return "UPSTREAM_CHANGED";
	}
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** inject の狭い profile 表現を contracts の公開 DTO に正規化する。 */
const normalizeProfile = (value: unknown): unknown => {
	const profile = asRecord(value);
	if (!profile) return value;
	if ("avatarUrl" in profile) return value;

	return {
		id: profile.id,
		username: profile.username,
		fullName: profile.fullName ?? null,
		biography: profile.biography ?? null,
		avatarUrl: profile.profilePictureUrl ?? null,
		isVerified: profile.isVerified,
		followerCount: profile.followers ?? null,
		followingCount: profile.following ?? null,
		mediaCount: profile.mediaCount ?? null,
	};
};

export const parseExecuteInput = <TName extends OperationName>(operation: TName, input: unknown): OperationInput<TName> => {
	try {
		return parseOperationInput(operation, input);
	} catch {
		throw new InstagramBrowserError("INVALID_INPUT", "操作入力が許可された形式ではありません。");
	}
};

export const parseExecuteResult = <TName extends OperationName>(
	operation: TName,
	result: InstagramApiSafeResult | unknown,
): OperationResult<TName> => {
	const response = result as { ok?: unknown; code?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
	if (response.ok !== true) {
		const rawCode = typeof response.error?.code === "string" ? response.error.code : response.code;
		const code = typeof rawCode === "string" ? failureCode(rawCode) : "UPSTREAM_CHANGED";
		const message = typeof response.error?.message === "string" ? response.error.message : `Instagram 操作 ${operation} を実行できませんでした。`;
		throw new InstagramBrowserError(code, message);
	}

	try {
		const data = operation === "getPublicProfile" ? normalizeProfile(response.data) : response.data;
		return operationResultSchemas[operation].parse(data) as OperationResult<TName>;
	} catch {
		throw new InstagramBrowserError("UPSTREAM_CHANGED", "Instagram の応答形式が公開契約と一致しません。");
	}
};
