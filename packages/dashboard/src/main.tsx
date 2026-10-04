import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type SafeTrace, parseSseChunk } from "./events";
import { StoryComposer } from "./story-composer";
import "./style.css";

type ProfileStatus = {
	name: string;
	state: string;
	catalog: Record<string, string>;
};

const App = () => {
	const [token, setToken] = useState(() => sessionStorage.getItem("relayToken") ?? "");
	const [profiles, setProfiles] = useState<ProfileStatus[]>([]);
	const [events, setEvents] = useState<SafeTrace[]>([]);
	const [message, setMessage] = useState("Bearerトークンを入力してください");

	const connect = useCallback(async () => {
		if (!token) return;
		sessionStorage.setItem("relayToken", token);
		const headers = { Authorization: `Bearer ${token}` };
		const response = await fetch("/profiles", { headers, cache: "no-store" });
		if (!response.ok) {
			setMessage(`接続失敗: HTTP ${response.status}`);
			return;
		}
		const body = (await response.json()) as { profiles: ProfileStatus[] };
		setProfiles(body.profiles);
		setMessage("接続済み。資格情報や生リクエストは表示されません。");

		const stream = await fetch("/api/events", { headers, cache: "no-store" });
		if (!stream.ok || !stream.body) return;
		const reader = stream.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			buffer += decoder.decode(part.value, { stream: true });
			const parsed = parseSseChunk(buffer);
			buffer = parsed.remainder;
			if (parsed.entries.length > 0) {
				setEvents((current) => [...parsed.entries, ...current].slice(0, 200));
			}
		}
	}, [token]);

	useEffect(() => {
		if (token) void connect().catch((error: unknown) => setMessage(String(error)));
	}, [connect, token]);

	return (
		<main>
			<header>
				<div>
					<p className="eyebrow">LOCAL SAFE RELAY</p>
					<h1>Instagram API Safe Relay</h1>
				</div>
				<span className="local">127.0.0.1 only</span>
			</header>

			<section className="auth">
				<label htmlFor="token">Bearer token</label>
				<input id="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} />
				<button type="button" onClick={() => void connect()}>接続</button>
				<p>{message}</p>
			</section>

			<section>
				<h2>Profiles</h2>
				<div className="cards">
					{profiles.map((profile) => (
						<article key={profile.name}>
							<strong>{profile.name}</strong>
							<span data-state={profile.state}>{profile.state}</span>
							<ul>{Object.entries(profile.catalog).map(([name, state]) => <li key={name}>{name}: {state}</li>)}</ul>
						</article>
					))}
				</div>
			</section>

			<StoryComposer key={token} token={token} profiles={profiles} />

			<section>
				<h2>Redacted traces</h2>
				<div className="trace-list">
					{events.map((entry) => (
						<div className="trace" key={entry.id}>
							<time>{new Date(entry.at).toLocaleTimeString()}</time>
							<strong>{entry.operation}</strong>
							<span>{entry.profile}</span>
							<span>{entry.phase}</span>
							<span>{entry.durationMs === undefined ? "—" : `${entry.durationMs} ms`}</span>
							<span>{entry.errorCode ?? entry.status ?? ""}</span>
						</div>
					))}
				</div>
			</section>
		</main>
	);
};

const root = document.getElementById("root");
if (!root) throw new Error("Dashboardのroot要素が見つかりません");
createRoot(root).render(<App />);
