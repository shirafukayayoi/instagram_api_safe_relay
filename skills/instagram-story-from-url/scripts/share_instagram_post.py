"""Instagramの公開投稿を、元投稿リンク付きカードとしてストーリーへ共有する。"""
import argparse
import json
import re
import subprocess
import sys
import urllib.parse
import uuid

from relay_runtime import ROOT, operation_profile, ensure_ready, ensure_running, request
from story_from_url import api, save, poll_job, add_caption_arguments, check_caption_transport


def canonical_url(value):
    url = urllib.parse.urlsplit(value)
    match = re.fullmatch(r'/(?:p|reel)/([A-Za-z0-9_-]{1,16})/?', url.path)
    if (url.scheme != 'https' or url.hostname not in {'www.instagram.com', 'instagram.com'}
            or url.username or url.password or url.port or not match):
        raise ValueError('Instagramの投稿またはリールのHTTPS URLが必要です')
    return 'https://www.instagram.com/p/' + match[1] + '/', match[1]


def create_card(original, target, source):
    """写真・共同投稿者名を実際の画像へ描画し、同じ領域に元投稿リンクを付ける。"""
    from PIL import Image, ImageOps, ImageFilter, ImageChops, ImageDraw, ImageFont
    with Image.open(original) as opened:
        if opened.width * opened.height > 25_000_000:
            raise RuntimeError('元画像が大きすぎます')
        image = ImageOps.exif_transpose(opened).convert('RGB')
        canvas = ImageOps.fit(image, (1080, 1920), method=Image.Resampling.LANCZOS)
        canvas = ImageChops.add(canvas, Image.new('RGB', canvas.size, (51, 51, 51))).filter(ImageFilter.GaussianBlur(17))
        foreground = ImageOps.contain(image, (950, 1360), method=Image.Resampling.LANCZOS)
        x, y = (1080 - foreground.width) // 2, (1920 - foreground.height - 80) // 2
        mask = Image.new('L', foreground.size)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, foreground.width-1, foreground.height-1), radius=34, fill=255)
        canvas.paste(foreground, (x, y), mask)
        draw = ImageDraw.Draw(canvas)
        if source.get('carouselCount', 1) > 1:
            right, top = x + foreground.width - 35, y + 35
            draw.rounded_rectangle((right-25, top+5, right+6, top+36), radius=7, outline='white', width=3)
            draw.rounded_rectangle((right-31, top, right, top+31), radius=7, fill='white')
        names = [source['username'], *source.get('collaborators', [])]
        label = ' & '.join('@' + name for name in dict.fromkeys(names))
        for size in range(32, 13, -2):
            try:
                font = ImageFont.truetype('DejaVuSans-Bold.ttf', size)
            except OSError:
                font = ImageFont.load_default(size=size)
            box = draw.textbbox((0, 0), label, font=font)
            if box[2] - box[0] <= 950:
                break
        draw.text(((1080-(box[2]-box[0]))/2, y+foreground.height+24), label, font=font,
                  fill='white', stroke_width=1, stroke_fill=(90,90,90))
        canvas.save(target, 'JPEG', quality=92, optimize=True)
    return {'layout': 'rounded-photo-with-collaborators', 'width':1080, 'height':1920,
            'original': original.name, 'image': target.name, 'authors': names}


def run(args, directory):
    url, shortcode = canonical_url(args.url)
    file = directory / 'operation.json'
    intent = {'sourceKind': 'instagram_post', 'url': url, 'profile': args.profile,
              'audience': args.audience, 'caption': args.caption}
    data = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {
        **intent, 'key': 'post-share-' + str(args.operation)}
    if data.get('comment'):
        raise RuntimeError('旧方式の公開後コメントを含む操作です。自動変換・追記・再投稿は行いません')
    if any(data.get(k) != v for k, v in intent.items()):
        raise RuntimeError('同じ操作IDの元投稿・投稿先・公開範囲・キャプションを変更できません')
    check_caption_transport(data, file.exists())
    if args.highlight or args.highlight_id:
        target = {'name': args.highlight, 'id': args.highlight_id}
        if data.get('highlightIntent') and data['highlightIntent'] != target:
            raise RuntimeError('同じ操作IDのハイライト登録先を変更できません')
        data['highlightIntent'] = target
    save(file, data)
    if data.get('job'):
        if args.start_relay:
            ensure_running(start=True)
        poll_job(args, directory, data)
        return
    ensure_ready(args.profile, start=args.start_relay)
    if not data.get('prepared'):
        source = api('story-feed-posts/' + shortcode, args.profile, data['key'])['data']
        if source.get('shortcode') != shortcode:
            raise RuntimeError('元投稿のコードが一致しません')
        data['feedPost'] = {k: source[k] for k in ('shortcode', 'mediaId', 'ownerId')}
        data['source'] = source
        save(file, data)
        original = directory / 'original-post-image'
        original.write_bytes(request('v1/story-feed-posts/' + shortcode + '/image', args.profile, binary=True))
        image = directory / 'story-card.jpg'
        data.update(prepared=True, transformation=create_card(original, image, source))
        save(file, data)
    payload = {'filePath': str(directory / 'story-card.jpg'), 'audience': args.audience,
               'caption': args.caption, 'feedPost': data['feedPost']}
    if args.preview_only:
        preview = api('story-previews', args.profile, data['key'], payload)['data']
        if (preview['profile'] != args.profile or preview['audience'] != args.audience
                or any(preview.get('feedPost', {}).get(k) != v for k, v in data['feedPost'].items())):
            raise RuntimeError('プレビューの元投稿または公開範囲が一致しません')
        data['preview'] = preview
        save(file, data)
        print(json.dumps({'preview': preview, 'published': False}, ensure_ascii=False))
        return
    result = api('stories', args.profile, data['key'], payload)['data']
    data['job'] = str(uuid.UUID(result['id']))
    save(file, data)
    poll_job(args, directory, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('--audience', choices=['all', 'close_friends'], required=True)
    parser.add_argument('--operation', type=uuid.UUID, required=True)
    parser.add_argument('--profile')
    add_caption_arguments(parser)
    parser.add_argument('--preview-only', action='store_true')
    parser.add_argument('--start-relay', action='store_true')
    target = parser.add_mutually_exclusive_group()
    target.add_argument('--highlight')
    target.add_argument('--highlight-id')
    args = parser.parse_args()
    canonical_url(args.url)
    if len(args.caption.encode('utf-16-le')) // 2 > 2200:
        parser.error('キャプションはUTF-16で2200文字以内です')
    if args.highlight_id and not args.highlight_id.isdecimal():
        parser.error('ハイライトIDは数値で指定してください')
    directory = ROOT / str(args.operation)
    args.profile = operation_profile(args.profile, directory, start=args.start_relay)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / '.lock'
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError('同じ操作が実行中です。停止を確認するまで再実行しません') from None
    try:
        run(args, directory)
    finally:
        lock.rmdir()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
