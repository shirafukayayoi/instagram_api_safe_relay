"""指定URLの素材取得と、同じ操作IDによるストーリー投稿・状態確認。"""
import argparse
import json
import math
import subprocess
import sys
import time
import urllib.parse
import uuid

from story_media import prepare_video

from relay_runtime import ROOT, diagnose, ensure_ready, ensure_running, request, accounts, select_account, operation_profile
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
         "tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"}


def save(file, data):
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)


def inspect(file):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format",
                             "-of", "json", str(file)], check=True, capture_output=True, text=True)
    probe = json.loads(result.stdout)
    streams = probe["streams"]
    videos = [s for s in streams if s["codec_type"] == "video"]
    audios = [s for s in streams if s["codec_type"] == "audio"]
    duration = float(probe["format"].get("duration", 0))
    if (len(videos) != 1 or videos[0]["codec_name"] != "h264"
            or any(s["codec_name"] != "aac" for s in audios) or len(audios) > 1
            or not 1 <= duration <= 60 or file.stat().st_size > 100 * 1024 * 1024
            or max(videos[0]["width"], videos[0]["height"]) > 4096
            or "mp4" not in probe["format"]["format_name"]):
        raise RuntimeError("動画がRelayの制限外です。自動変換・分割はしません")
    return {"duration": duration, "width": videos[0]["width"], "height": videos[0]["height"]}


def api(endpoint, profile, key, payload=None):
    return request("v1/" + endpoint, profile, key, payload)


def add_caption_arguments(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--caption", default="", help="ストーリーの投稿時に添える文面")
    group.add_argument("--comment", dest="caption", help="--captionと同じ、投稿時に添える文面")


def check_caption_transport(data, existing):
    if not data.get("caption"):
        return
    if existing and data.get("captionTransport") != "comment_as_caption_v1":
        raise RuntimeError("旧方式の投稿時コメントを含む操作です。新方式へ自動変換・再投稿しません")
    data["captionTransport"] = "comment_as_caption_v1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?")
    parser.add_argument("--audience", choices=["all", "close_friends"])
    parser.add_argument("--profile")
    parser.add_argument("--operation", type=uuid.UUID)
    management = parser.add_mutually_exclusive_group()
    management.add_argument("--list-accounts", action="store_true", help="登録アカウントと選択中の投稿先を一覧表示")
    management.add_argument("--use-account", help="プロファイル名または@ユーザー名で次の投稿先を選択")
    management.add_argument("--check", action="store_true", help="投稿せず依存関係・設定・ログイン状態を診断")
    parser.add_argument("--start-relay", action="store_true", help="停止中のRelayを既存設定・台帳で起動")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--download-only", action="store_true")
    mode.add_argument("--preview-only", action="store_true", help="取得素材と実ログインアカウントを確認。アップロード・公開はしません")
    mode.add_argument("--highlight-only", action="store_true", help="同じ操作の公開済み動画をハイライトへ登録。再投稿しません")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--highlight", help="投稿後に追加する既存ハイライト名（完全一致）")
    target.add_argument("--highlight-id", help="投稿後に追加する既存ハイライトの数値ID")
    parser.add_argument("--clip-start", type=float, help="明示指定された切り出し開始秒")
    parser.add_argument("--clip-end", type=float, help="明示指定された切り出し終了秒")
    add_caption_arguments(parser)
    args = parser.parse_args()
    if any(v is not None and (not math.isfinite(v) or v < 0) for v in (args.clip_start, args.clip_end)):
        parser.error("切り出し秒数は0以上の有限数で指定してください")
    if args.list_accounts or args.use_account:
        if args.url or args.operation or args.download_only or args.preview_only or args.highlight_only:
            parser.error("アカウント管理と投稿・取得を同じコマンドで実行できません")
        result = select_account(args.use_account, start=args.start_relay) if args.use_account else accounts(start=args.start_relay)
        print(json.dumps(result, ensure_ascii=False))
        return
    if args.check:
        result = diagnose(args.profile, start=args.start_relay)
        print(json.dumps(result, ensure_ascii=False))
        if not result["ready"]:
            sys.exit(1)
        return
    if not all((args.url, args.audience, args.operation)):
        parser.error("投稿・取得にはURL、--audience、--operationが必要です")
    if len(args.caption.encode("utf-16-le")) // 2 > 2200:
        parser.error("caption・commentはUTF-16で2200文字以内にしてください")
    if args.highlight_only and not (args.highlight or args.highlight_id):
        parser.error("--highlight-onlyには--highlightまたは--highlight-idが必要です")
    if args.highlight_id and not args.highlight_id.isdecimal():
        parser.error("ハイライトIDは数値で指定してください")
    url = urllib.parse.urlsplit(args.url)
    if url.scheme != "https" or url.hostname not in HOSTS or url.username or url.password or url.port:
        parser.error("YouTube/TikTokのHTTPS URLを指定してください")
    directory = ROOT / str(args.operation)
    args.profile = operation_profile(args.profile, directory, start=args.start_relay, offline=args.download_only)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError("同じ操作が実行中です。プロセス停止を確認するまで再実行しないでください") from None
    try:
        run(args, directory)
    finally:
        lock.rmdir()


def run(args, directory):
    ledger = directory / "operation.json"
    intent = {"url": args.url, "audience": args.audience, "profile": args.profile, "caption": getattr(args, "caption", "")}
    data = json.loads(ledger.read_text(encoding="utf-8")) if ledger.exists() else {
        **intent, "key": "url-story-" + str(args.operation)}
    if data.get("comment"):
        raise RuntimeError("旧方式の公開後コメントを含む操作です。投稿時コメントへの変換・追記・再投稿は行いません")
    clip = {"start": getattr(args, "clip_start", None), "end": getattr(args, "clip_end", None)}
    clip = clip if any(v is not None for v in clip.values()) else None
    if data.get("clip") != clip:
        if ledger.exists():
            raise RuntimeError("同じ操作IDの切り出し範囲は変更できません")
    if clip is not None:
        data["clip"] = clip
    if any(data.get(k, "" if k == "caption" else None) != v for k, v in intent.items()):
        raise RuntimeError("操作IDを異なるURL・公開範囲・プロファイル・キャプションに再利用できません")
    data.update(intent)
    check_caption_transport(data, ledger.exists())
    highlight = getattr(args, "highlight", None)
    highlight_id = getattr(args, "highlight_id", None)
    if highlight or highlight_id:
        target = {"name": highlight, "id": highlight_id}
        if data.get("highlightIntent") and data["highlightIntent"] != target:
            raise RuntimeError("同じ操作のハイライト登録先を変更できません")
        data["highlightIntent"] = target
    save(ledger, data)
    if getattr(args, "highlight_only", False) and not data.get("job"):
        raise RuntimeError("公開済みジョブがありません。ハイライト登録だけでは投稿しません")
    # 受理済みジョブの照会は素材の有無やログイン準備に依存させない。
    if data.get("job") and not args.download_only:
        if getattr(args, "start_relay", False):
            ensure_running(start=True)
        poll_job(args, directory, data)
        return
    if not args.download_only:
        ensure_ready(args.profile, start=getattr(args, "start_relay", False))
    file = directory / "video.mp4"
    if not data.get("downloaded"):
        source = directory / "original.mp4"
        if not data.get("sourceDownloaded"):
            subprocess.run([sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
                            "--js-runtimes", "node",
                            "--max-filesize", "300M", "--merge-output-format", "mp4",
                            "-f", "b[ext=mp4][vcodec~='^(avc1|h264)'][acodec~='^(mp4a|aac)']/bv[ext=mp4][height<=1080][vcodec~='^(avc1|h264)']+ba[ext=m4a][acodec~='^(mp4a|aac)']/b[ext=mp4][vcodec~='^(avc1|h264)'][acodec=none]",
                            "-o", str(source), "--", args.url], check=True)
            data["sourceDownloaded"] = True
            save(ledger, data)
        data["transformation"] = prepare_video(source, file, (clip or {}).get("start"), (clip or {}).get("end"))
        data["media"] = inspect(file)
        data["downloaded"] = True
        save(ledger, data)
    print(json.dumps({"filePath": str(file), "audience": args.audience, "media": data["media"]}, ensure_ascii=False))
    if args.download_only:
        return
    if getattr(args, "preview_only", False):
        result = None
        if data.get("preview"):
            preview_id = str(uuid.UUID(data["preview"]["id"]))
            try:
                status = api("story-previews/" + preview_id, args.profile, data["key"])["data"]
                if status.get("job"):
                    data["job"] = status["job"]["id"]
                    save(ledger, data)
                    poll_job(args, directory, data)
                    return
                result = status.get("preview")
            except RuntimeError as error:
                if str(error) not in {"Relay HTTP 404: NOT_FOUND", "Relay HTTP 409: PREVIEW_EXPIRED"}:
                    raise
        if result is None:
            result = api("story-previews", args.profile, data["key"], {
                "filePath": str(file), "audience": args.audience, "caption": intent["caption"]})["data"]
        if result.get("audience") != args.audience or result.get("profile") != args.profile:
            raise RuntimeError("プレビューの投稿先または公開範囲が一致しません")
        data["preview"] = result
        save(ledger, data)
        print(json.dumps({"preview": result, "published": False}, ensure_ascii=False))
        return
    if not data.get("job"):
        # POST前にキーと素材を保存済み。応答喪失からの手動再開も同じキーを使う。
        result = api("stories", args.profile, data["key"], {"filePath": str(file), "audience": args.audience, "caption": intent["caption"]})
        data["job"] = result["data"]["id"]
        save(ledger, data)
    poll_job(args, directory, data)


def poll_job(args, directory, data):
    ledger = directory / "operation.json"
    deadline = time.monotonic() + 45
    while True:
        result = api("story-jobs/" + str(uuid.UUID(data["job"])), args.profile, data["key"])["data"]
        data["result"] = result
        save(ledger, data)
        if result["state"] in {"published", "failed", "unknown"}:
            print(json.dumps(result, ensure_ascii=False))
            if result["state"] != "published":
                raise RuntimeError("公開成功を確認できません。再投稿せずInstagram上で確認してください")
            if data.get("feedPost") and result.get("feedPost") != data["feedPost"]:
                raise RuntimeError("公開結果の元投稿参照が一致しません。再投稿しません")
            if result.get("audience") != args.audience or not result.get("mediaId"):
                raise RuntimeError("投稿IDまたは公開範囲の確認が取れません。再投稿せずInstagram上で確認してください")
            if data.get("highlightIntent") and not getattr(args, "preview_only", False):
                register_highlight(args, directory, data)
            return
        if time.monotonic() >= deadline:
            print("処理継続中です。同じ操作IDで状態確認を再開してください: " + data["job"])
            return
        time.sleep(2)


def register_highlight(args, directory, data):
    ledger = directory / "operation.json"
    target = data["highlightIntent"]
    key = data["key"] + ":highlight"
    if not data.get("highlightTarget"):
        own = api("highlights", args.profile, key)["data"]
        if own["account"] != data["result"]["account"]:
            raise RuntimeError("ハイライトと公開済みストーリーのアカウントが一致しません")
        matches = [item for item in own["highlights"] if
                   (item["id"] == target["id"] if target["id"] else item["title"] == target["name"])]
        if len(matches) != 1:
            raise RuntimeError("ハイライトを一意に指定できません。既存ハイライトのIDを指定してください")
        data["highlightTarget"] = matches[0]
        save(ledger, data)
    if not data.get("highlightJob"):
        result = api("highlights/" + data["highlightTarget"]["id"] + "/stories", args.profile, key,
                     {"storyJobId": data["job"]})["data"]
        data["highlightJob"] = str(uuid.UUID(result["id"]))
        save(ledger, data)
    deadline = time.monotonic() + 45
    while True:
        result = api("highlight-jobs/" + data["highlightJob"], args.profile, key)["data"]
        data["highlightResult"] = result
        save(ledger, data)
        if (result.get("highlight") != data["highlightTarget"] or result.get("storyJobId") != data["job"]
                or result.get("account") != data["result"]["account"]
                or result.get("mediaId") != data["result"]["mediaId"]
                or result.get("audience") != args.audience or result.get("profile") != args.profile):
            raise RuntimeError("ハイライト登録結果の対象照合ができません。再登録せずInstagram上で確認してください")
        if result["state"] in {"completed", "failed", "unknown"}:
            print(json.dumps({"highlight": result}, ensure_ascii=False))
            if result["state"] != "completed":
                raise RuntimeError("ハイライト登録を確認できません。自動再登録はしません")
            return
        if time.monotonic() >= deadline:
            print("ハイライト処理継続中です。同じ操作IDで状態確認を再開してください: " + data["highlightJob"])
            return
        time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
