"""実際のffmpegで縦変換・切り出しと原本保持を検証する（公開なし）。"""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from story_media import prepare_video, probe


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.source = Path(self.folder.name) / 'original.mp4'
        self.target = Path(self.folder.name) / 'video.mp4'

    def material(self, size, duration=2, rate='24'):
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate={rate}',
                        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', str(duration), '-c:v', 'libx264',
                        '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', str(self.source)], check=True)

    def test_horizontal_gets_vertical_background_and_keeps_source(self):
        self.material('160x90', 1)
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        result = prepare_video(self.source, self.target)
        info = probe(self.target)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        self.assertEqual((video['width'], video['height']), (1080, 1920))
        self.assertEqual(result['layout'], 'blurred-background-1080x1920')
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)
        self.assertEqual(next(s['codec_name'] for s in info['streams'] if s['codec_type'] == 'audio'), 'aac')

    def test_portrait_without_trim_keeps_exact_bytes(self):
        self.material('90x160')
        result = prepare_video(self.source, self.target)
        self.assertEqual(result['layout'], 'original')
        self.assertEqual(self.source.read_bytes(), self.target.read_bytes())

    def test_fractional_frame_rate_trim_fits_sixty_seconds(self):
        self.material('90x160', 61, '24000/1001')
        result = prepare_video(self.source, self.target, 0, 60)
        self.assertEqual(float(probe(self.target)['format']['duration']), 60)
        self.assertEqual(result['frameRate'], 24)
        self.assertGreater(float(probe(self.source)['format']['duration']), 60)

    def test_long_source_needs_explicit_valid_trim(self):
        self.material('90x160', 61)
        for beginning, ending in ((None, None), (0, 62), (4, 3), (-1, 20)):
            with self.subTest(start=beginning, end=ending), self.assertRaises(RuntimeError):
                prepare_video(self.source, self.target, beginning, ending)
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main()
