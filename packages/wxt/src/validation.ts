import {
	operationNames,
	operationResultSchemas,
	parseOperationInput,
	type OperationInput,
	type OperationName,
	type OperationResult,
} from "instagram-api-safe-contracts";
import { InstagramWxtError } from "./errors.js";

export type CatalogStatus = Readonly<Record<OperationName, "ready" | "CATALOG_STALE">>;

export const isOperationName = (value: unknown): value is OperationName =>
	typeof value === "string" && (operationNames as readonly string[]).includes(value);

export const parseInput = <TName extends OperationName>(operation: TName, input: unknown): OperationInput<TName> => {
	try {
		return parseOperationInput(operation, input);
	} catch {
		throw new InstagramWxtError("INVALID_INPUT", "操作入力が許可された形式ではありません。");
	}
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const normalizeProfile = (value: unknown): unknown => {
	const profile = asRecord(value);
	if (!profile || "avatarUrl" in profile) return value;
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

const toCode = (code: unknown): InstagramWxtError["code"] => {
	switch (code) {
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
			return code;
		default:
			return "UPSTREAM_CHANGED";
	}
};

/** MAIN world と content world の双方で呼び、結果 DTO を fail-closed にする。 */
export const parseResult = <TName extends OperationName>(operation: TName, result: unknown): OperationResult<TName> => {
	const response = result as { ok?: unknown; code?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
	if (response.ok !== true) {
		const rawCode = typeof response.error?.code === "string" ? response.error.code : response.code;
		const message = typeof response.error?.message === "string" ? response.error.message : `Instagram 操作 ${operation} を実行できませんでした。`;
		throw new InstagramWxtError(toCode(rawCode), message);
	}
	try {
		return operationResultSchemas[operation].parse(operation === "getPublicProfile" ? normalizeProfile(response.data) : response.data) as OperationResult<TName>;
	} catch {
		throw new InstagramWxtError("UPSTREAM_CHANGED", "Instagram の応答形式が公開契約と一致しません。");
	}
};
