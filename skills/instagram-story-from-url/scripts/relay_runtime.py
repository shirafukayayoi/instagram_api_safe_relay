"""Relayの設定・接続確認と、既存セッションを使う非公開テスト用の起動補助。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request

def repository_path():
    configured = os.environ.get("INSTAGRAM_RELAY_REPOSITORY")
    if configured:
        return Path(configured).resolve()
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "packages" / "server" / "src" / "server.ts").is_file():
            return candidate
    return Path.home() / "Documents" / "Program" / "instagram_api_safe_relay"


REPOSITORY = repository_path()
ROOT = REPOSITORY / "work" / "story-smoke"


def settings():
    return json.loads((REPOSITORY / "settings.json").read_text(encoding="utf-8-sig"))


def token():
    value = os.environ.get("INSTAGRAM_RELAY_API_TOKEN", "")
    if not value:
        env_file = REPOSITORY / ".env"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                name, separator, candidate = line.strip().partition("=")
                if separator and name == "INSTAGRAM_RELAY_API_TOKEN":
                    value = candidate.strip().strip("\"'")
                    break
    if len(value) < 32:
        raise RuntimeError("Relayの環境変数または.envに32文字以上のAPIトークンが必要です")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Relayのリダイレクトを拒否しました")


def request(endpoint, profile="", key="", payload=None, timeout=30):
    port = settings().get("port", 3000)
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise RuntimeError("Relayのport設定が不正です")
    headers = {"Authorization": "Bearer " + token(), "x-profile-name": profile}
    body = None
    if payload is not None:
        headers.update({"Content-Type": "application/json", "Idempotency-Key": key})
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{port}/{endpoint}", body, headers)
    # ローカルBearerを環境変数のHTTP proxyへ転送しない。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            code = json.loads(error.read())["error"]["code"]
        except (ValueError, KeyError, TypeError):
            code = "HTTP_ERROR"
        raise RuntimeError(f"Relay HTTP {error.code}: {code}") from None
    except urllib.error.URLError:
        raise RuntimeError("Relayに接続できません。--check --start-relayで起動・診断してください") from None


def configuration(profile):
    config = settings()
    stories = config.get("stories", {})
    if not stories.get("enabled"):
        raise RuntimeError("settings.jsonのstories.enabledが無効です")
    server_dir = REPOSITORY / "packages" / "server"
    permitted = []
    for value in stories.get("allowedMediaDirectories", []):
        path = Path(value)
        permitted.append((path if path.is_absolute() else server_dir / path).resolve())
    if not any(ROOT.resolve().is_relative_to(path) for path in permitted):
        raise RuntimeError("work/story-smokeがRelayの素材許可ディレクトリに含まれていません")
    profiles = config.get("profiles", [])
    if profile is None and len(profiles) == 1:
        profile = profiles[0]["name"]
    if not any(entry.get("name") == profile for entry in profiles):
        raise RuntimeError("設定済みのプロファイルを--profileで指定してください")
    return profile


def start_relay():
    node = shutil.which("node")
    server_dir = REPOSITORY / "packages" / "server"
    entry = server_dir / "dist" / "server.js"
    if not node or not entry.exists():
        raise RuntimeError("Relayのビルドが必要です。リポジトリでpnpm install --frozen-lockfileとpnpm buildを実行してください")
    logs = REPOSITORY / "work" / "skill-relay"
    logs.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, INSTAGRAM_RELAY_API_TOKEN=token())
    environment["INSTAGRAM_RELAY_SETTINGS"] = str(REPOSITORY / "settings.json")
    flags = (subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
             | subprocess.CREATE_NO_WINDOW) if os.name == "nt" else 0
    with (logs / "stdout.log").open("ab") as stdout, (logs / "stderr.log").open("ab") as stderr:
        process = subprocess.Popen([node, str(entry)], cwd=server_dir, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                   creationflags=flags, start_new_session=os.name != "nt")
    (logs / "process.json").write_text(json.dumps({"pid": process.pid}), encoding="utf-8")
    for _ in range(30):
        if process.poll() is not None:
            raise RuntimeError(f"Relayの起動に失敗しました。{logs / 'stderr.log'}を確認してください")
        try:
            request("health", timeout=1)
            return
        except RuntimeError:
            time.sleep(0.5)
    raise RuntimeError("Relayの起動を確認できません。再起動せず既存プロセスとログを確認してください")


def ensure_running(start=False):
    try:
        health = request("health", timeout=2)
    except RuntimeError as error:
        if not start or "接続できません" not in str(error):
            raise
        start_relay()
        health = request("health", timeout=2)
    if health.get("status") != "ok":
        raise RuntimeError("接続先がInstagram Relayか確認できません")


def ensure_ready(profile, start=False):
    profile = configuration(profile)
    ensure_running(start=start)
    deadline = time.monotonic() + (40 if start else 0)
    while True:
        response = request("profiles", profile, timeout=5)
        selected = next((entry for entry in response.get("profiles", []) if entry.get("name") == profile), None)
        if selected is None:
            raise RuntimeError("稼働中Relayに指定プロファイルがありません。設定と起動プロセスを確認してください")
        state = selected.get("state", "unknown")
        if state == "ready":
            return {"profile": profile, "state": state}
        if state not in {"starting", "recovering"} or time.monotonic() >= deadline:
            raise RuntimeError(f"Instagramセッション: {state}。ログイン・2FA・challengeはブラウザで手動完了してください")
        time.sleep(1)


def diagnose(profile=None, start=False):
    checks = []
    for program in ("ffmpeg", "ffprobe", "node"):
        checks.append({"name": program, "ok": bool(shutil.which(program))})
    checks.append({"name": "yt-dlp", "ok": importlib.util.find_spec("yt_dlp") is not None})
    result = {"ready": False, "checks": checks}
    try:
        if not all(check["ok"] for check in checks):
            raise RuntimeError("不足している依存ツールを導入してください")
        token()
        result.update(ensure_ready(profile, start=start))
        result["ready"] = True
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        result["error"] = str(error)
    return result
