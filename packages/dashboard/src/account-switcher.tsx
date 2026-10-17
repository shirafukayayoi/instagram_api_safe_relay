import type { StoryAccount } from "instagram-api-safe-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
export type AccountSelection = { profile: string; account: StoryAccount };
type AccountEntry = { profile: string; state: string; account: StoryAccount | null };
type AccountList = { accounts: AccountEntry[]; selected: AccountSelection | null };

export const AccountSwitcher = ({
	token,
	onSelection,
}: {
	token: string;
	onSelection: (selection: AccountSelection | null) => void;
}) => {
	const [list, setList] = useState<AccountList>({ accounts: [], selected: null });
	const [candidate, setCandidate] = useState("");
	const [message, setMessage] = useState("接続後にアカウントを選択できます。");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const active = useRef(true);
	const request = useCallback(
		async <T,>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
			const response = await fetch(route, {
				method: body === undefined ? "GET" : "POST",
				cache: "no-store",
				...(signal ? { signal } : {}),
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const result = (await response.json()) as { data: T; error?: { message: string } };
			if (!response.ok) throw new Error(result.error?.message ?? "アカウントを確認できません。");
			return result.data;
		},
		[token],
	);
	useEffect(() => {
		active.current = true;
		const controller = new AbortController();
		onSelection(null);
		if (token)
			void request<AccountList>("/v1/accounts", undefined, controller.signal)
				.then((data) => {
					if (controller.signal.aborted) return;
					setList(data);
					setCandidate(data.selected?.profile ?? "");
					onSelection(data.selected);
					setMessage(data.selected ? "選択した投稿先は次回も引き継がれます。" : "次の投稿先を選んでください。");
				})
				.catch(() => {
					if (!controller.signal.aborted) setMessage("アカウント一覧を取得できません。接続を確認してください。");
				});
		return () => {
			active.current = false;
			controller.abort();
		};
	}, [token, request, onSelection]);
	const choose = async () => {
		if (busyRef.current || !candidate || !token) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const entry = list.accounts.find((item) => item.profile === candidate);
			const selected = await request<AccountSelection>("/v1/accounts/select", {
				profile: candidate,
				...(entry?.account ? { expectedAccountId: entry.account.id } : {}),
			});
			if (!active.current) return;
			setList((old) => ({
				accounts: old.accounts.map((item) =>
					item.profile === selected.profile ? { ...item, account: selected.account } : item,
				),
				selected,
			}));
			onSelection(selected);
			setMessage(`次の投稿先を @${selected.account.username} に切り替えました。`);
		} catch (error) {
			if (active.current)
				setMessage(
					error instanceof Error ? error.message : "切り替えを確認できません。再読み込みして選択を確認してください。",
				);
		} finally {
			busyRef.current = false;
			if (active.current) setBusy(false);
		}
	};
	return (
		<section className="account-switcher">
			<h2>アカウント切り替え</h2>
			<p>
				次の投稿先: <strong>{list.selected ? `@${list.selected.account.username}` : "未選択"}</strong>
			</p>
			<label htmlFor="next-account">使うアカウント</label>
			<div className="account-controls">
				<select
					id="next-account"
					value={candidate}
					disabled={busy || !token}
					onChange={(event) => setCandidate(event.target.value)}
				>
					<option value="">選択してください</option>
					{list.accounts.map((entry) => (
						<option key={entry.profile} value={entry.profile} disabled={entry.state !== "ready"}>
							{entry.account ? `@${entry.account.username}` : entry.profile}
							{entry.state === "ready" ? "" : "（ログインが必要）"}
						</option>
					))}
				</select>
				<button type="button" disabled={busy || !candidate || !token} onClick={() => void choose()}>
					{busy ? "投稿先を確認中…" : "このアカウントを使う"}
				</button>
			</div>
			<p role="status">{message}</p>
			<p className="account-note">処理中の投稿や再開する操作は、元のアカウントのまま続きます。</p>
		</section>
	);
};
