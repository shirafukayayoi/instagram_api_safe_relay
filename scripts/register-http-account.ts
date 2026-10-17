/** ローカルに移行済みのセッションを照合し、別プロファイルとして登録する。 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { InstagramHttpClient } from "../packages/server/src/http/client.js";
import { loadSettings } from "../packages/server/src/utils/settings.js";

export const registerHttpAccount = async (root: string, name: string, sessionName: string) => {
	const lock = path.join(root, "work/skill-relay/register-account.lock");
	await fs.mkdir(path.dirname(lock), { recursive: true });
	await fs.mkdir(lock);
	try {
		const sessionFile = await fs.realpath(path.resolve(root, sessionName));
		const privateRoot = await fs.realpath(path.join(root, "private_sessions"));
		const relative = path.relative(privateRoot, sessionFile);
		if (relative.startsWith("..") || path.isAbsolute(relative) || !relative)
			throw new Error("セッションはGit管理外のprivate_sessions内へ保存してください");
		const settingsFile = path.join(root, "settings.json");
		const original = await fs.readFile(settingsFile, "utf8");
		const config = JSON.parse(original);
		const settings = loadSettings(config);
		if (settings.profiles.some((profile) => profile.name === name))
			throw new Error("同じプロファイル名が登録済みです。既存設定は変更しません");
		const client = await InstagramHttpClient.open(sessionFile);
		try {
			const account = await client.getAccount(AbortSignal.timeout(30000));
			for (const profile of settings.profiles) {
				if (profile.browser.type !== "http") continue;
				const current = JSON.parse(
					await fs.readFile(path.resolve(root, "packages/server", profile.browser.sessionFile), "utf8"),
				);
				if (current.account?.id === account.id)
					throw new Error("このアカウントは登録済みです。既存のプロファイルへ切り替えてください");
			}
			config.profiles.push({
				name: name,
				home: "https://www.instagram.com/",
				browser: { type: "http", sessionFile },
			});
			loadSettings(config);
			const backup = path.join(root, "work/skill-relay", `settings-before-account-${randomUUID()}.json`);
			await fs.mkdir(path.dirname(backup), { recursive: true });
			await fs.writeFile(backup, original, { mode: 0o600, flag: "wx" });
			const temporary = path.join(root, `.${randomUUID()}.settings.tmp`);
			try {
				await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
				// 別プロセスの同時編集は上書きせず停止する。
				if ((await fs.readFile(settingsFile, "utf8")) !== original)
					throw new Error("設定が同時に変更されました。保存せず停止します");
				await fs.rename(temporary, settingsFile);
			} finally {
				await fs.unlink(temporary).catch(() => undefined);
			}
			return { registered: true, profile: name, account, restartRequired: true };
		} finally {
			client.close();
		}
	} finally {
		await fs.rmdir(lock);
	}
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const { values } = parseArgs({
			options: { name: { type: "string" }, "session-file": { type: "string" }, help: { type: "boolean" } },
		});
		if (values.help)
			console.log("使い方: pnpm accounts:register --name account2 --session-file private_sessions/account2.json");
		else {
			if (!values.name || !values["session-file"]) throw new Error("プロファイル名とセッションを指定してください");
			console.log(
				JSON.stringify(
					await registerHttpAccount(
						fileURLToPath(new URL("../", import.meta.url)),
						values.name,
						values["session-file"],
					),
				),
			);
		}
	} catch {
		console.error(
			"登録を停止しました。引数・ログイン状態・保存先・既存登録との重複・別の登録処理が実行中でないかを確認してください。認証値は表示しません",
		);
		process.exitCode = 1;
	}
}
