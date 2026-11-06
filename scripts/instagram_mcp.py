"""既存RelayとURL投稿スクリプトを利用する、ローカルstdio MCP。"""

import asyncio
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import Any, Literal
import urllib.parse
import uuid

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPTS = REPOSITORY / "skills/instagram-story-from-url/scripts"
os.environ.setdefault("INSTAGRAM_RELAY_REPOSITORY", str(REPOSITORY))
sys.path.insert(0, str(SCRIPTS))
import relay_runtime as relay
from share_instagram_post import canonical_url
from story_from_url import HOSTS, check_caption_transport, save

Audience = Literal["all", "close_friends"]
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)
LOCAL = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True)
mcp = FastMCP(
    "instagram-relay",
    instructions=(
        "InstagramのURL投稿用MCP。最初にinstagram_statusで接続と選択先を確認する。"
        "プレビューは公開しない。公開はユーザーの明示的な依頼があるときだけ行い、"
        "プレビューの操作ID・アカウントID・公開範囲をinstagram_publish_operationへ渡す。"
        "親しい友達はclose_friends。曲のコメントはスキルの規則で曲名 / アーティスト名とする。"
        "処理中・成功済み・結果不明は同じ操作IDで状態を確認し、新IDで再投稿しない。"
        "コメント・切り出し・指定ハイライトはプレビュー初回から指定する。"
        "認証、ログイン、2FA、challengeの自動化や削除は提供しない。"
    ),
    log_level="ERROR",
)
_startup_lock = threading.Lock()
_command_lock = asyncio.Lock()


def _ensure_relay():
    """MCPから専用ブラウザーを誤って起動しない。"""
    with _startup_lock:
        try:
            config = relay.settings()
            if any(p.get("browser", {}).get("type") != "http" for p in config.get("profiles", [])):
                raise ToolError("MCPは設定済みのHTTPプロファイル専用です")
            relay.ensure_running(start=True)
        except ToolError:
            raise
        except Exception:
            raise ToolError("Relayを確認できません。設定・ビルド・ローカル認証を確認してください") from None


def _request(endpoint, profile="", key="", payload=None):
    _ensure_relay()
    try:
        return relay.request(endpoint, profile, key, payload)
    except Exception:
        raise ToolError("Relayが処理を拒否したか接続を確認できません。状態を確認し、自動再送しないでください") from None


def _operation_path(operation_id):
    try:
        name = str(uuid.UUID(operation_id))
    except (ValueError, TypeError, AttributeError):
        raise ToolError("操作IDはUUIDで指定してください") from None
    root = relay.ROOT.resolve()
    directory = (root / name).resolve()
    if directory.parent != root:
        raise ToolError("操作フォルダーが許可範囲外です")
    return directory


def _ledger(operation_id):
    file = _operation_path(operation_id) / "operation.json"
    if not file.is_file() or file.is_symlink() or file.stat().st_size > 1024 * 1024:
        raise ToolError("保存済みの操作がありません")
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ToolError("操作の記録を読み取れません") from None


def _summary(operation_id):
    data = _ledger(operation_id)
    # 元投稿の生データ、署名付きURL、子プロセスの出力は返さない。
    keys = ("profile", "audience", "caption", "clip", "preview", "job", "result",
            "highlightIntent", "highlightJob", "highlightResult", "mcpPublishAttempt")
    return {"operationId": str(uuid.UUID(operation_id)), **{key: data[key] for key in keys if key in data}}


def _profile(explicit):
    listing = _request("v1/accounts")["data"]
    profile = explicit or (listing.get("selected") or {}).get("profile")
    if not profile or not any(p["profile"] == profile for p in listing["accounts"]):
        raise ToolError("投稿先を一意に確認できません。アカウントを選択してください")
    return profile


def _validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname in {"instagram.com", "www.instagram.com"}:
        try:
            return canonical_url(url)[0], "instagram_post"
        except ValueError:
            raise ToolError("Instagramの投稿またはリールのHTTPS URLを指定してください") from None
    try:
        allowed = (parsed.scheme == "https" and parsed.hostname in HOSTS and not parsed.username
                   and not parsed.password and parsed.port is None)
    except ValueError:
        allowed = False
    if not allowed:
        raise ToolError("YouTube・TikTok・Instagram投稿のHTTPS URLを指定してください")
    return url, "video"


def _command(data, operation_id, preview=False, highlight_only=False):
    url, kind = _validate_url(data["url"])
    script = "share_instagram_post.py" if kind == "instagram_post" else "story_from_url.py"
    args = [sys.executable, "-B", str(SCRIPTS / script), url, "--audience", data["audience"],
            "--operation", str(uuid.UUID(operation_id)), "--profile", data["profile"],
            "--comment", data.get("caption", ""), "--start-relay"]
    if preview:
        args.append("--preview-only")
    if highlight_only:
        if kind == "instagram_post":
            raise ToolError("Instagramカードの追加登録は初回プレビューで登録先を指定してください")
        args.append("--highlight-only")
    for key, flag in (("name", "--highlight"), ("id", "--highlight-id")):
        if data.get("highlightIntent", {}).get(key):
            args.extend([flag, data["highlightIntent"][key]])
    if data.get("clip"):
        if kind != "video":
            raise ToolError("Instagramカードに動画の切り出しは指定できません")
        for key in ("start", "end"):
            if data["clip"].get(key) is not None:
                args.extend(["--clip-" + key, str(data["clip"][key])])
    return args


async def _run(args, operation_id):
    await asyncio.to_thread(_ensure_relay)
    process = await asyncio.create_subprocess_exec(
        *args, cwd=REPOSITORY, env=dict(os.environ, PYTHONUTF8="1"),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        await asyncio.wait_for(process.wait(), timeout=540)
    except (TimeoutError, asyncio.CancelledError):
        # 途中の公開結果は不明のまま。同じ台帳・冪等キーでのみ再開する。
        if process.returncode is None:
            process.terminate()
            await process.wait()
        raise ToolError(f"処理を中断しました。新しいIDを作らず操作ID {operation_id} の状態を確認してください") from None
    file = _operation_path(operation_id) / "operation.json"
    result = _summary(operation_id) if file.is_file() else {"operationId": operation_id}
    result["commandSucceeded"] = process.returncode == 0
    if process.returncode:
        result["message"] = "処理を完了できませんでした。保存状態を確認し、結果不明を再投稿しないでください"
    return result


@mcp.tool(annotations=READ)
def instagram_status() -> dict[str, Any]:
    """HTTP Relayを必要時だけ起動し、依存ツール・接続・選択中の投稿先を診断する。"""
    _ensure_relay()
    return relay.diagnose()


@mcp.tool(annotations=READ)
def instagram_accounts() -> dict[str, Any]:
    """登録済みのアカウント・状態・選択中の投稿先を取得する。"""
    return _request("v1/accounts")["data"]


@mcp.tool(annotations=LOCAL)
def instagram_select_account(target: str) -> dict[str, Any]:
    """@ユーザー名またはプロファイル名で今後の投稿先を選択する。投稿はしない。"""
    _ensure_relay()
    try:
        return relay.select_account(target)
    except Exception:
        raise ToolError("アカウントを選択できません。一覧とログイン状態を確認してください") from None


@mcp.tool(annotations=LOCAL)
async def instagram_preview_url(
    url: str, audience: Audience = "all", profile: str | None = None,
    comment: str = "", clip_start: float | None = None, clip_end: float | None = None,
    highlight: str | None = None, highlight_id: str | None = None,
    operation_id: str | None = None,
) -> dict[str, Any]:
    """URL素材を準備し投稿先・公開範囲をプレビューする。Instagramへアップロード・公開しない。

    コメント・切り出し・指定ハイライトは初回から指定する。再開は同じ操作IDと同じ引数を使う。
    """
    async with _command_lock:
        url, kind = _validate_url(url)
        operation_id = str(uuid.UUID(operation_id)) if operation_id else str(uuid.uuid4())
        directory = _operation_path(operation_id)
        if highlight and highlight_id:
            raise ToolError("ハイライト名とIDはどちらか一方を指定してください")
        if highlight_id and not highlight_id.isdecimal():
            raise ToolError("ハイライトIDは数値です")
        if len(comment.encode("utf-16-le")) // 2 > 2200:
            raise ToolError("コメントはUTF-16で2200文字以内です")
        values = (clip_start, clip_end)
        if any(v is not None and (not math.isfinite(v) or v < 0) for v in values):
            raise ToolError("切り出し秒数は0以上の有限数です")
        if kind == "instagram_post" and any(v is not None for v in values):
            raise ToolError("Instagramカードに動画の切り出しは指定できません")
        if (directory / "operation.json").exists():
            previous = _ledger(operation_id)
            if previous.get("job"):
                raise ToolError("受理済みの操作です。instagram_operation_statusで確認してください")
            profile = profile or previous["profile"]
        else:
            profile = await asyncio.to_thread(_profile, profile)
        data = {"url": url, "audience": audience, "profile": profile, "caption": comment}
        if any(v is not None for v in values):
            data["clip"] = {"start": clip_start, "end": clip_end}
        if highlight or highlight_id:
            data["highlightIntent"] = {"name": highlight, "id": highlight_id}
        return await _run(_command(data, operation_id, preview=True), operation_id)


@mcp.tool(annotations=WRITE)
async def instagram_publish_operation(
    operation_id: str, expected_account_id: str, expected_audience: Audience,
) -> dict[str, Any]:
    """ユーザーの明示的な投稿依頼に基づき、プレビュー済みの同じ操作を公開する。

    プレビューのaccount.idとaudienceを指定する。成功済み・結果不明・処理中は再投稿しない。
    """
    async with _command_lock:
        data = _ledger(operation_id)
        if data.get("job"):
            return await asyncio.to_thread(instagram_operation_status, operation_id)
        if data.get("comment"):
            raise ToolError("旧方式の公開後コメントを持つ操作は公開しません")
        try:
            check_caption_transport(data, existing=True)
        except RuntimeError:
            raise ToolError("旧方式の投稿時コメントを持つ操作は公開しません") from None
        preview = data.get("preview")
        if not preview or preview.get("account", {}).get("id") != expected_account_id:
            raise ToolError("プレビューと指定アカウントが一致しません")
        if preview.get("audience") != expected_audience or data.get("audience") != expected_audience:
            raise ToolError("プレビューと指定公開範囲が一致しません")
        if preview.get("profile") != data.get("profile"):
            raise ToolError("プレビューと保存した投稿先が一致しません")
        try:
            expiry = datetime.fromisoformat(preview["expiresAt"].replace("Z", "+00:00"))
            if expiry <= datetime.now(timezone.utc):
                raise ValueError()
            preview_id = str(uuid.UUID(preview["id"]))
        except (KeyError, ValueError, TypeError):
            raise ToolError("プレビュー期限を確認できません。同じ操作IDでプレビューを更新してください") from None
        current = await asyncio.to_thread(_request, "v1/story-previews/" + preview_id, data["profile"])
        if (current.get("data", {}).get("preview") != preview or current.get("data", {}).get("job")):
            raise ToolError("プレビューの状態が変わりました。同じ操作の状態を確認してください")
        # 確認した素材コピーを公開する。通常投稿APIへの作り直しは行わない。
        lock = _operation_path(operation_id) / ".lock"
        try:
            lock.mkdir()
        except FileExistsError:
            raise ToolError("同じ操作が実行中です。停止を確認するまで再実行しません") from None
        try:
            if _ledger(operation_id) != data:
                raise ToolError("操作が同時に変更されました。状態を確認してください")
            data["job"] = preview_id
            data["mcpPublishAttempt"] = {
                "previewId": preview_id, "state": "sending",
                "at": datetime.now(timezone.utc).isoformat(),
            }
            file = _operation_path(operation_id) / "operation.json"
            # 応答喪失・キャンセル時も送信済みとして扱い、同じ要求を自動再送しない。
            save(file, data)
            try:
                response = await asyncio.to_thread(
                    _request, "v1/story-previews/" + preview_id + "/publish", data["profile"],
                    data["key"], {"confirmed": True},
                )
            except ToolError:
                return {**_summary(operation_id), "commandSucceeded": False,
                        "message": "公開要求の結果を確認できません。同じ操作IDで状態だけを照会してください"}
            job = response.get("data", {})
            if job.get("id") != preview_id or job.get("profile") != data["profile"]:
                raise ToolError("公開ジョブの対象を照合できません。再送せず状態を確認してください")
            data["result"] = job
            data["mcpPublishAttempt"]["state"] = "accepted"
            save(file, data)
        finally:
            lock.rmdir()
        # 既存ジョブのポーリングと指定済みハイライト処理だけを共用する。
        return await _run(_command(data, operation_id), operation_id)


@mcp.tool(annotations=READ)
def instagram_operation_status(operation_id: str) -> dict[str, Any]:
    """保存した操作と既存ジョブの最新状態を取得する。公開やハイライト登録は開始しない。"""
    data = _ledger(operation_id)
    result = _summary(operation_id)
    for saved, endpoint, output in (("job", "story-jobs", "result"),
                                    ("highlightJob", "highlight-jobs", "highlightResult")):
        if data.get(saved):
            job_id = str(uuid.UUID(data[saved]))
            try:
                result[output] = _request("v1/" + endpoint + "/" + job_id, data["profile"])["data"]
            except ToolError:
                if saved != "job" or not data.get("mcpPublishAttempt"):
                    raise
                result[output] = {"id": job_id, "state": "unknown",
                                  "message": "公開要求の受付状態を確認できません。自動再送しません"}
    return result


@mcp.tool(annotations=READ)
def instagram_highlights(profile: str | None = None) -> dict[str, Any]:
    """既存ハイライトの一覧と実アカウントを照合して返す。"""
    return _request("v1/highlights", _profile(profile))["data"]


@mcp.tool(annotations=WRITE)
async def instagram_resume_highlight(operation_id: str) -> dict[str, Any]:
    """初回から登録先を指定した公開済み動画を同じハイライトへ登録・再開する。再投稿しない。"""
    async with _command_lock:
        data = _ledger(operation_id)
        if not data.get("job") or not data.get("highlightIntent"):
            raise ToolError("公開済みジョブと初回のハイライト指定が必要です")
        status = await asyncio.to_thread(instagram_operation_status, operation_id)
        if status.get("result", {}).get("state") != "published":
            raise ToolError("公開成功を確認できません。再投稿・登録はしません")
        if status.get("highlightResult", {}).get("state") in {"unknown", "failed", "completed"}:
            return status
        return await _run(_command(data, operation_id, highlight_only=True), operation_id)


if __name__ == "__main__":
    mcp.run(transport="stdio")
