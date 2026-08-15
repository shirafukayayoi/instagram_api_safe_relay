import {
	ProfileInUseError,
	resolveSmokeConfig,
	runLiveSmoke,
	SmokeSkipError,
} from "../packages/test-utils/src/index.ts";

const main = async () => {
	const config = await resolveSmokeConfig();
	await runLiveSmoke(config, ({ operation, count, durationMs }) => {
		console.log(`operation=${operation} count=${count} durationMs=${durationMs}`);
	});
};

try {
	await main();
} catch (error) {
	if (error instanceof SmokeSkipError) {
		console.log(`SKIP: ${error.message}`);
		process.exitCode = 0;
	} else if (error instanceof ProfileInUseError) {
		console.error(`ERROR: ${error.message}`);
		process.exitCode = 2;
	} else {
		const code =
			typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
				? error.code.replace(/[^A-Z0-9_]/gi, "").slice(0, 64)
				: error instanceof Error
					? error.name.replace(/[^A-Z0-9_]/gi, "").slice(0, 64)
					: "UNKNOWN_ERROR";
		const safeDetail = error instanceof Error && error.name === "InstagramBrowserError" ? ` detail=${error.message}` : "";
		console.error(`ERROR: code=${code || "UNKNOWN_ERROR"}${safeDetail}`);
		process.exitCode = 1;
	}
}
