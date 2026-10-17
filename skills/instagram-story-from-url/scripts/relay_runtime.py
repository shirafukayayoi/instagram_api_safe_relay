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
    if profile is None and len(profiles) > 1:
        selected_file = Path(config.get("accountSelectionFile", "../../work/skill-relay/selected-account.json"))
        if not selected_file.is_absolute():
            selected_file = REPOSITORY / "packages" / "server" / selected_file
        if selected_file.exists():
            profile = json.loads(selected_file.read_text(encoding="utf-8"))["profile"]
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
        explicit = profile is not None
        result.update(ensure_ready(profile, start=start))
        if not explicit:
            selected = request("v1/accounts")["data"].get("selected")
            if not selected or selected["profile"] != result["profile"]:
                raise RuntimeError("保存した投稿先を確認できません。--use-accountで選び直してください")
            result["account"] = selected["account"]
        result["ready"] = True
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        result["error"] = str(error)
    return result


def accounts(start=False):
    """認証値を含まない登録一覧と現在の選択を取得する。"""
    ensure_running(start=start)
    return request("v1/accounts")["data"]


def select_account(target, start=False):
    listing = accounts(start=start)
    name = target.removeprefix("@")
    matches = []
    for entry in listing["accounts"]:
        account = entry.get("account") or {}
        if (not target.startswith("@") and entry["profile"] == target) or account.get("username") == name:
            matches.append(entry)
    if len(matches) != 1:
        raise RuntimeError("アカウントを一意に指定できません。--list-accountsで確認し、プロファイル名または@ユーザー名を指定してください")
    selected = matches[0]
    if start:
        ensure_ready(selected["profile"], start=True)
    payload = {"profile": selected["profile"]}
    if selected.get("account"):
        payload["expectedAccountId"] = selected["account"]["id"]
    return request("v1/accounts/select", payload=payload)["data"]


def operation_profile(explicit, directory, start=False, offline=False):
    """既存操作は保存済み投稿先、新規操作は選択した投稿先に固定する。"""
    if explicit:
        return explicit
    ledger = directory / "operation.json"
    if ledger.exists():
        data = json.loads(ledger.read_text(encoding="utf-8"))
        profile = data.get("profile")
        if not isinstance(profile, str) or not profile:
            raise RuntimeError("既存操作の投稿先を確認できません。別アカウントで代用しません")
        return profile
    if offline:
        return configuration(None)
    selected = accounts(start=start).get("selected")
    if not selected:
        raise RuntimeError("投稿先が未選択です。--use-accountで切り替えるか--profileを指定してください")
    return selected["profile"]
