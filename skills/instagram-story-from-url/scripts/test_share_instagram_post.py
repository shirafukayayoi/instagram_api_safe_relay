"""公開なしで投稿カード共有のURL・対象固定・再開動作を検証する。"""
import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import share_instagram_post as share
import story_from_url as story


class ShareTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.args = SimpleNamespace(url='https://www.instagram.com/p/BA/?tracking=x', profile='one',
                                    audience='all', caption='', operation='operation', highlight=None,
                                    highlight_id=None, start_relay=False, preview_only=False)
        self.reference = {'shortcode': 'BA', 'mediaId': '64', 'ownerId': '456'}
        self.data = {'sourceKind': 'instagram_post', 'url': 'https://www.instagram.com/p/BA/',
                     'profile': 'one', 'audience': 'all', 'caption': '', 'key': 'same-key',
                     'feedPost': self.reference, 'prepared': True}

    def save(self):
        story.save(self.directory / 'operation.json', self.data)

    def test_card_contains_photo_and_preserves_original(self):
        from PIL import Image
        original = self.directory / 'original.png'
        target = self.directory / 'card.jpg'
        Image.new('RGB', (160, 90), (190, 20, 20)).save(original)
        before = original.read_bytes()
        result = share.create_card(original, target, {'username':'source', 'carouselCount':4, 'collaborators':['collaborator']})
        with Image.open(target) as image:
            self.assertEqual(image.size, (1080, 1920))
            self.assertLess(image.getpixel((540,960))[1], 35)
            self.assertGreater(image.getpixel((540,100))[1], 45)
        self.assertEqual(result['authors'], ['source','collaborator'])
        self.assertEqual(original.read_bytes(), before)

    def test_tracking_removed_and_reel_normalized_without_network(self):
        self.assertEqual(share.canonical_url(self.args.url), ('https://www.instagram.com/p/BA/', 'BA'))
        self.assertEqual(share.canonical_url('https://instagram.com/reel/BA/')[1], 'BA')
        for url in ['http://instagram.com/p/BA/', 'https://instagram.com.evil/p/BA/',
                    'https://instagram.com@evil/p/BA/', 'https://instagram.com/p/BA/other/',
                    'https://instagram.com:123/p/BA/']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                share.canonical_url(url)

    def test_unknown_resume_does_not_fetch_prepare_or_resend(self):
        self.data['job'] = '24f00393-097d-4f64-85fc-b112a89ff759'
        self.save()
        with patch.object(story, 'api', return_value={'data': {'state': 'unknown'}}) as status, \
                patch.object(share, 'api') as api, patch.object(share, 'request') as image, \
                patch.object(share, 'ensure_ready') as ready, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                share.run(self.args, self.directory)
            self.assertEqual(status.call_count, 1)
            api.assert_not_called(); image.assert_not_called(); ready.assert_not_called()

    def test_changed_source_or_caption_rejects_before_contact(self):
        self.save()
        for field, value in [('url', 'https://instagram.com/p/BB/'), ('caption', '変更'), ('profile', 'two')]:
            old = getattr(self.args, field)
            setattr(self.args, field, value)
            with self.subTest(field=field), patch.object(share, 'api') as api, patch.object(share, 'ensure_ready') as ready:
                with self.assertRaises(RuntimeError):
                    share.run(self.args, self.directory)
                api.assert_not_called(); ready.assert_not_called()
            setattr(self.args, field, old)

    def test_preview_sends_exact_reference_and_does_not_publish(self):
        self.save(); self.args.preview_only = True
        preview = {'profile': 'one', 'audience': 'all', 'feedPost': self.reference}
        with patch.object(share, 'ensure_ready'), patch.object(share, 'api', return_value={'data': preview}) as api, \
                contextlib.redirect_stdout(io.StringIO()):
            share.run(self.args, self.directory)
            api.assert_called_once_with('story-previews', 'one', 'same-key', {
                'filePath': str(self.directory / 'story-card.jpg'), 'audience': 'all', 'caption': '',
                'feedPost': self.reference})
        self.assertNotIn('job', json.loads((self.directory / 'operation.json').read_text()))

    def test_legacy_caption_never_converts_or_contacts_relay(self):
        self.data['caption'] = self.args.caption = '旧方式の文面'
        self.save()
        with patch.object(share, 'api') as api, patch.object(share, 'ensure_ready') as ready:
            with self.assertRaisesRegex(RuntimeError, '旧方式'):
                share.run(self.args, self.directory)
            api.assert_not_called(); ready.assert_not_called()

    def test_missing_post_link_never_becomes_success(self):
        self.data['job'] = '24f00393-097d-4f64-85fc-b112a89ff759'; self.save()
        with patch.object(story, 'api', return_value={'data': {'state': 'published', 'mediaId': '999', 'audience': 'all'}}), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                share.run(self.args, self.directory)


if __name__ == '__main__':
    unittest.main()
