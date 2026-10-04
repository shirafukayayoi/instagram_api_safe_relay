import type { StoryJob, StoryPreview, StoryPreviewStatus } from "instagram-api-safe-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearPendingStory, type PendingStory, readPendingStory, savePendingStory } from "./story-pending";

type Props = { token: string; profiles: { name: string; state: string }[] };
type Draft = { profile: string; filePath: string; audience: "all" | "close_friends"; caption: string };
const audienceLabel = (value: Draft["audience"]) => (value === "close_friends" ? "親しい友達" : "通常公開");
const terminal = (job: StoryJob | null) => job && ["published", "failed", "unknown"].includes(job.state);

export const StoryComposer = ({ token, profiles }: Props) => {
	const [initial] = useState(readPendingStory);
	const [pending, setPending] = useState(initial.pending);
	const pendingRef = useRef(pending);
	const [draft, setDraft] = useState<Draft>({ profile: "", filePath: "", audience: "all", caption: "" });
	const [preview, setPreview] = useState<StoryPreview | null>(null);
	const [mediaUrl, setMediaUrl] = useState("");
	const [mediaReady, setMediaReady] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const confirmedRef = useRef(false);
	const [job, setJob] = useState<StoryJob | null>(null);
	const [message, setMessage] = useState(initial.error ?? "素材と公開範囲を選んでプレビューしてください。");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const previewRef = useRef(preview);
	previewRef.current = preview;
	const blocked = Boolean(pending || initial.error || busy);

	const request = useCallback(
		async <T,>(profile: string, route: string, method = "GET", body?: unknown): Promise<T> => {
			const response = await fetch(route, {
				method,
				cache: "no-store",
				headers: {
					Authorization: `Bearer ${token}`,
					"x-profile-name": profile,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			const result = (await response.json()) as { data: T; error?: { code: string; message: string } };
			if (!response.ok)
				throw new Error(result.error ? `${result.error.code}: ${result.error.message}` : `HTTP ${response.status}`);
			return result.data;
		},
		[token],
	);

	const resetPreview = () => {
		setPreview(null);
		previewRef.current = null;
		setMediaUrl("");
		setMediaReady(false);
		setConfirmed(false);
		confirmedRef.current = false;
	};
	const changeDraft = (patch: Partial<Draft>) => {
		if (busyRef.current || pendingRef.current || initial.error) return;
		const old = previewRef.current;
		resetPreview();
		if (old) void request(old.profile, `/v1/story-previews/${old.id}`, "DELETE").catch(() => undefined);
		setDraft((current) => ({ ...current, ...patch }));
		setMessage("変更した内容でプレビューを作り、再確認してください。");
	};
	useEffect(
		() => () => {
			if (mediaUrl) URL.revokeObjectURL(mediaUrl);
		},
		[mediaUrl],
	);

	const refresh = useCallback(
		async (operation: PendingStory) => {
			try {
				const status = await request<StoryPreviewStatus>(operation.profile, `/v1/story-previews/${operation.id}`);
				if (pendingRef.current?.id !== operation.id) return;
				setJob(status.job);
				setMessage(
					status.job
						? "この操作IDの状態を照会しています。"
						: "公開の受付を確認できません。再送せず、照会または中止してください。",
				);
			} catch {
				if (pendingRef.current?.id === operation.id)
					setMessage(
						"通信または状態の確認に失敗しました。公開された可能性があるため再送しません。状態を照会してください。",
					);
			}
		},
		[request],
	);
	const settled = Boolean(terminal(job));
	useEffect(() => {
		if (!pending || !token || settled) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await refresh(pending);
			if (active) timer = setTimeout(() => void poll(), 2000);
		};
		void poll();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [pending, token, settled, refresh]);

	const prepare = async () => {
		if (busyRef.current || pendingRef.current || initial.error || !draft.profile || !token) return;
		busyRef.current = true;
		setBusy(true);
		const old = previewRef.current;
		resetPreview();
		let created: StoryPreview | undefined;
		try {
			if (old) await request(old.profile, `/v1/story-previews/${old.id}`, "DELETE");
			created = await request<StoryPreview>(draft.profile, "/v1/story-previews", "POST", {
				filePath: draft.filePath,
				audience: draft.audience,
				caption: draft.caption,
			});
			const response = await fetch(`/v1/story-previews/${created.id}/media`, {
				headers: { Authorization: `Bearer ${token}`, "x-profile-name": created.profile },
				cache: "no-store",
			});
			if (!response.ok) throw new Error("素材を表示できません。再度プレビューしてください。");
			setMediaUrl(URL.createObjectURL(await response.blob()));
			setPreview(created);
			setMessage("実ログインアカウント・素材・公開範囲を確認してください。プレビューで公開は発生しません。");
		} catch (error) {
			if (created) void request(created.profile, `/v1/story-previews/${created.id}`, "DELETE").catch(() => undefined);
			setMessage(error instanceof Error ? error.message : "プレビューに失敗しました。");
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const publish = async () => {
		if (
			busyRef.current ||
			pendingRef.current ||
			initial.error ||
			!preview ||
			previewRef.current?.id !== preview.id ||
			!confirmedRef.current ||
			!mediaReady
		)
			return;
		busyRef.current = true;
		setBusy(true);
		const operation = { id: preview.id, profile: preview.profile };
		try {
			// 通信開始より前に操作IDを保存し、再読込後も照会のみで復旧する。
			savePendingStory(operation);
			pendingRef.current = operation;
			setPending(operation);
			setConfirmed(false);
			confirmedRef.current = false;
			setMessage("公開要求を送信しています。この操作を再送しないでください。");
			setJob(
				await request<StoryJob>(operation.profile, `/v1/story-previews/${operation.id}/publish`, "POST", {
					confirmed: true,
				}),
			);
		} catch {
			setMessage(
				pendingRef.current
					? "公開の成否を確認できません。再送せず状態を照会してください。"
					: "操作IDを保存できないため公開を開始できません。",
			);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const back = async () => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const operation = pendingRef.current;
			if (operation && (!job || !terminal(job)))
				await request(operation.profile, `/v1/story-previews/${operation.id}`, "DELETE");
			if (job?.state === "unknown") return;
			if (!operation && preview) await request(preview.profile, `/v1/story-previews/${preview.id}`, "DELETE");
			clearPendingStory();
			pendingRef.current = null;
			setPending(null);
			setJob(null);
			resetPreview();
			setMessage("準備画面に戻りました。新しい操作にはプレビューと確認が必要です。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "中止を確認できません。状態を照会してください。");
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	return (
		<section className="story-composer">
			<h2>ストーリーズ投稿</h2>
			<p>プレビューで実際の投稿先を確認し、確認後に公開します。</p>
			<fieldset disabled={blocked}>
				<label htmlFor="story-profile">接続プロファイル（設定ラベル）</label>
				<select
					id="story-profile"
					value={draft.profile}
					onChange={(event) => changeDraft({ profile: event.target.value })}
				>
					<option value="">選択してください</option>
					{profiles.map((profile) => (
						<option key={profile.name} value={profile.name}>
							{profile.name} ({profile.state})
						</option>
					))}
				</select>
				<label htmlFor="story-file">Relay側の素材の絶対パス</label>
				<input
					id="story-file"
					value={draft.filePath}
					onChange={(event) => changeDraft({ filePath: event.target.value })}
				/>
				<label htmlFor="story-audience">公開範囲</label>
				<select
					id="story-audience"
					value={draft.audience}
					onChange={(event) => changeDraft({ audience: event.target.value as Draft["audience"] })}
				>
					<option value="all">通常公開</option>
					<option value="close_friends">親しい友達</option>
				</select>
				<label htmlFor="story-caption">キャプション（任意）</label>
				<textarea
					id="story-caption"
					maxLength={2200}
					value={draft.caption}
					onChange={(event) => changeDraft({ caption: event.target.value })}
				/>
				<button type="button" disabled={!token || !draft.profile || !draft.filePath} onClick={() => void prepare()}>
					プレビューを作成
				</button>
			</fieldset>
			{preview && (
				<article className="story-preview">
					<h3>投稿前プレビュー</h3>
					<p className="story-account">
						実ログインアカウント: <strong>@{preview.account.username}</strong> (ID: {preview.account.id})
					</p>
					<p>
						接続プロファイル: {preview.profile} / 公開範囲: <strong>{audienceLabel(preview.audience)}</strong>
					</p>
					{preview.media.mimeType === "video/mp4" ? (
						<video
							src={mediaUrl}
							controls
							preload="auto"
							onLoadedData={() => setMediaReady(true)}
							onError={() => {
								setMediaReady(false);
								confirmedRef.current = false;
								setConfirmed(false);
							}}
						>
							<track kind="captions" />
						</video>
					) : (
						<img
							src={mediaUrl}
							alt="投稿素材のプレビュー"
							onLoad={() => setMediaReady(true)}
							onError={() => {
								setMediaReady(false);
								confirmedRef.current = false;
								setConfirmed(false);
							}}
						/>
					)}
					<p>
						{preview.media.width} × {preview.media.height} / {preview.media.size.toLocaleString()} bytes{" "}
						{preview.media.durationSeconds === null ? "" : `/ ${preview.media.durationSeconds}秒`}
					</p>
					<p>キャプション: {draft.caption || "なし"}</p>
					{!pending && (
						<>
							<label className="story-confirm">
								<input
									type="checkbox"
									checked={confirmed}
									disabled={busy || !mediaReady || Boolean(initial.error)}
									onChange={(event) => {
										confirmedRef.current = event.target.checked;
										setConfirmed(event.target.checked);
									}}
								/>
								@{preview.account.username} に、この素材を「{audienceLabel(preview.audience)}
								」で公開することを確認しました
							</label>
							<p>「確認して公開」はInstagramへのアップロードと公開を開始します。</p>
							<button
								type="button"
								className="publish"
								disabled={!confirmed || !mediaReady || busy || Boolean(initial.error)}
								onClick={() => void publish()}
							>
								確認して公開
							</button>
							<button type="button" className="secondary" disabled={busy} onClick={() => void back()}>
								キャンセル / 戻る
							</button>
						</>
					)}
				</article>
			)}
			<p role="status">{message}</p>
			{pending && (
				<article className="story-result">
					<p>
						操作ID: {pending.id} / 接続プロファイル: {pending.profile}
					</p>
					{job && (
						<>
							<p>
								状態: <strong>{job.state}</strong> {job.errorCode ?? ""}
							</p>
							<p>
								確認したアカウント: @{job.account?.username ?? "不明"} / 公開範囲: {audienceLabel(job.audience)}
							</p>
							{job.state === "published" && <p>公開成功を確認しました。メディアID: {job.mediaId}</p>}
							{job.state === "failed" && (
								<p>公開前に失敗しました。内容を確認し、新しいプレビューからやり直してください。</p>
							)}
							{job.state === "unknown" && (
								<p>公開された可能性があります。Instagram上で結果を確認してください。自動再送しません。</p>
							)}
						</>
					)}
					<button type="button" onClick={() => void refresh(pending)}>
						状態を照会
					</button>
					{(!job || (terminal(job) && job.state !== "unknown")) && (
						<button type="button" className="secondary" disabled={busy} onClick={() => void back()}>
							{job ? "新しい投稿の準備へ" : "この操作を中止"}
						</button>
					)}
				</article>
			)}
		</section>
	);
};
