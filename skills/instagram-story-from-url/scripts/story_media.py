"""ストーリー用の切り出しと、横動画の背景ぼかし付き縦変換。"""
import hashlib
import json
import math
from fractions import Fraction
from pathlib import Path
import shutil
import subprocess


def probe(file):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(file)],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def prepare_video(source, target, start=None, end=None):
    source, target = Path(source), Path(target)
    info = probe(source)
    videos = [s for s in info['streams'] if s['codec_type'] == 'video']
    audios = [s for s in info['streams'] if s['codec_type'] == 'audio']
    duration = float(info['format']['duration'])
    if (len(videos) != 1 or videos[0]['codec_name'] != 'h264' or len(audios) > 1
            or any(s['codec_name'] != 'aac' for s in audios)
            or 'mp4' not in info['format']['format_name']):
        raise RuntimeError('配信元のH.264/AAC MP4を取得してください')
    beginning, ending = start if start is not None else 0, end if end is not None else duration
    if not 0 <= beginning < ending <= duration or not 1 <= ending - beginning <= 60:
        raise RuntimeError('切り出しは元動画内の1〜60秒で指定してください')
    video = videos[0]
    width, height = video['width'], video['height']
    rotation = next((float(s.get('rotation', 0)) for s in video.get('side_data_list', [])
                     if 'rotation' in s), float(video.get('tags', {}).get('rotate', 0)))
    if round(rotation) % 180:
        width, height = height, width
    horizontal = width > height
    trimmed = start is not None or end is not None
    transformation = {'sourceFile': source.name, 'startSeconds': beginning, 'endSeconds': ending,
                      'layout': 'blurred-background-1080x1920' if horizontal else 'original',
                      'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}
    temporary = target.with_name(target.stem + '.preparing.mp4')
    if horizontal or trimmed:
        # 23.976fpsなどの端数で60秒を超えないよう、整数fpsのフレーム境界へ合わせる。
        rate = min(60, max(1, math.ceil(Fraction(video.get('avg_frame_rate', '30/1')))))
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '2',
                '-ss', str(beginning), '-i', str(source), '-t', str(ending - beginning)]
        if horizontal:
            # MediaDownloaderTool.pyのCPU処理と同じ背景の明るさ・ぼかし・中央配置。
            filters = ("[0:v]split=2[bg][fg];"
                       "[bg]scale=w='if(gte(iw/ih,1080/1920),-2,1080)':"
                       "h='if(gte(iw/ih,1080/1920),1920,-2)',"
                       "crop=1080:1920:(iw-1080)/2:(ih-1920)/2,setsar=1,"
                       "eq=brightness=0.2,gblur=sigma=17[blur];"
                       "[fg]scale=1080:-2,setsar=1[front];"
                       "[blur][front]overlay=x=(W-w)/2:y=(H-h)/2[v]")
            args += ['-filter_complex', filters, '-map', '[v]']
        else:
            args += ['-map', '0:v:0']
        if audios:
            samples = math.floor((ending - beginning) * int(audios[0]['sample_rate']))
            args += ['-af', f'atrim=end_sample={samples},asetpts=PTS-STARTPTS']
        args += ['-map', '0:a:0?', '-r', str(rate), '-fps_mode', 'cfr', '-c:v', 'libx264',
                 '-preset', 'veryfast', '-crf', '20', '-threads', '4', '-profile:v', 'high',
                 '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(temporary)]
        subprocess.run(args, check=True)
        transformation.update(frameRate=rate, command=args)
    else:
        shutil.copyfile(source, temporary)
    actual = probe(temporary)
    if not 1 <= float(actual['format']['duration']) <= 60 or temporary.stat().st_size > 100 * 1024 * 1024:
        raise RuntimeError('変換後の動画が60秒または100MiBの上限を超えています。公開しません')
    temporary.replace(target)
    transformation['videoSha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
    return transformation
