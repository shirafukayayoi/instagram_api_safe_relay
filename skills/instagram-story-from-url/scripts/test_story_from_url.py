"""公開なしで、再開・投稿先・プレビュー・接続失敗の振る舞いを検証する。"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import relay_runtime
import story_from_url as story

JOB = "24f00393-097d-4f64-85fc-b112a89ff759"


class StoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.data = {"url": "https://youtu.be/example", "audience": "close_friends",
                     "profile": "account1", "caption": "文面🌸\n2行目", "key": "same-key",
                     "captionTransport": "comment_as_caption_v1",
                     "downloaded": True, "media": {}}
        self.args = SimpleNamespace(**self.data, download_only=False, preview_only=False,
                                    start_relay=False)
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def run_story(self):
        story.save(self.directory / "operation.json", self.data)
        story.run(self.args, self.directory)

    def test_account_selection_reads_and_switches_without_publication(self):
        listing = {"accounts": [{"profile": "one", "state": "ready", "account": {"id": "123", "username": "owner"}}]}
        with patch.object(relay_runtime, "accounts", return_value=listing), patch.object(relay_runtime, "request", return_value={"data": {"profile": "one"}}) as request:
            self.assertEqual(relay_runtime.select_account("@owner"), {"profile": "one"})
            request.assert_called_once_with("v1/accounts/select", payload={"profile": "one", "expectedAccountId": "123"})

    def test_unknown_or_ambiguous_account_never_switches(self):
        entries = [{"profile": "one", "account": {"id": "123", "username": "same"}},
                   {"profile": "two", "account": {"id": "456", "username": "same"}}]
        with patch.object(relay_runtime, "accounts", return_value={"accounts": entries}), patch.object(relay_runtime, "request") as request:
            for target in ("@same", "missing"):
                with self.assertRaises(RuntimeError):
                    relay_runtime.select_account(target)
            request.assert_not_called()

    def test_existing_operation_keeps_original_profile_after_switch(self):
        story.save(self.directory / "operation.json", self.data)
        with patch.object(relay_runtime, "accounts") as accounts:
            self.assertEqual(relay_runtime.operation_profile(None, self.directory), "account1")
            accounts.assert_not_called()

    def test_new_operation_uses_selected_account_and_rejects_missing_selection(self):
        with patch.object(relay_runtime, "accounts", return_value={"selected": {"profile": "two"}}):
            self.assertEqual(relay_runtime.operation_profile(None, self.directory), "two")
            self.assertEqual(relay_runtime.operation_profile("explicit", self.directory), "explicit")
        with patch.object(relay_runtime, "accounts", return_value={"selected": None}):
            with self.assertRaises(RuntimeError):
                relay_runtime.operation_profile(None, self.directory)

    def test_explicit_download_profile_needs_no_account_api(self):
        with patch.object(relay_runtime, "accounts") as accounts:
            self.assertEqual(relay_runtime.operation_profile("one", self.directory, offline=True), "one")
            accounts.assert_not_called()

    def test_unknown_job_resume_queries_without_material_or_session(self):
        self.data.update(job=JOB, downloaded=False)
        with patch.object(story, "api", return_value={"data": {"state": "unknown"}}) as api, \
                patch.object(story, "ensure_ready") as ready, patch.object(story.subprocess, "run") as download:
            with self.assertRaises(RuntimeError):
                self.run_story()
            api.assert_called_once_with("story-jobs/" + JOB, "account1", "same-key")
            ready.assert_not_called()
            download.assert_not_called()

    def test_explicit_start_for_existing_job_does_not_require_login(self):
        self.data["job"] = JOB
        self.args.start_relay = True
        with patch.object(story, "ensure_running") as running, patch.object(story, "ensure_ready") as ready, \
                patch.object(story, "api", return_value={"data": {"state": "published", "audience": "close_friends", "mediaId": "123"}}):
            self.run_story()
            running.assert_called_once_with(start=True)
            ready.assert_not_called()

    def test_changed_intent_does_not_contact_relay(self):
        for field, value in (("audience", "all"), ("caption", "変更"), ("profile", "other")):
            with self.subTest(field=field), patch.object(story, "api") as api, patch.object(story, "ensure_ready") as ready:
                previous = getattr(self.args, field)
                setattr(self.args, field, value)
                with self.assertRaises(RuntimeError):
                    self.run_story()
                setattr(self.args, field, previous)
                api.assert_not_called()
                ready.assert_not_called()

    def test_changed_clip_never_contacts_relay(self):
        self.data['clip'] = {'start': 0.0, 'end': 60.0}
        self.args.clip_start, self.args.clip_end = 0.0, 30.0
        with patch.object(story, 'api') as api, patch.object(story, 'ensure_ready') as ready:
            with self.assertRaises(RuntimeError):
                self.run_story()
            api.assert_not_called()
            ready.assert_not_called()

    def test_missing_relay_fails_before_download_or_publish(self):
        self.data["downloaded"] = False
        with patch.object(story, "ensure_ready", side_effect=RuntimeError("接続できません")), \
                patch.object(story.subprocess, "run") as download, patch.object(story, "api") as api:
            with self.assertRaises(RuntimeError):
                self.run_story()
            download.assert_not_called()
            api.assert_not_called()

    def test_download_only_needs_no_relay(self):
        self.args.download_only = True
        with patch.object(story, "ensure_ready") as ready, patch.object(story, "api") as api:
            self.run_story()
            ready.assert_not_called()
            api.assert_not_called()

    def test_caption_forwarded_and_job_persisted(self):
        with patch.object(story, "ensure_ready"), patch.object(story, "api", side_effect=[
                {"data": {"id": JOB}}, {"data": {"state": "published", "audience": "close_friends", "mediaId": "123"}}]) as api:
            self.run_story()
            self.assertEqual(api.call_args_list[0].args[3]["caption"], self.data["caption"])
            self.assertEqual(json.loads((self.directory / "operation.json").read_text(encoding="utf-8"))["job"], JOB)

    def test_comment_argument_is_the_same_publication_caption(self):
        parser = argparse.ArgumentParser()
        story.add_caption_arguments(parser)
        self.assertEqual(parser.parse_args(['--comment', '投稿時の文面']).caption, '投稿時の文面')
        self.assertEqual(parser.parse_args(['--caption', '投稿時の文面']).caption, '投稿時の文面')
        self.assertEqual(parser.parse_args([]).caption, '')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser.parse_args(['--comment', '一方', '--caption', '別の文面'])

    def test_legacy_after_publication_comment_never_retries_or_converts(self):
        self.data.update(job=JOB, comment='旧方式の文面')
        with patch.object(story, 'api') as api, patch.object(story, 'register_highlight') as register:
            with self.assertRaisesRegex(RuntimeError, '旧方式'):
                self.run_story()
            api.assert_not_called()
            register.assert_not_called()

    def test_legacy_quick_caption_never_converts_or_contacts_relay(self):
        self.data.pop('captionTransport')
        with patch.object(story, 'api') as api, patch.object(story, 'ensure_ready') as ready:
            with self.assertRaisesRegex(RuntimeError, '旧方式'):
                self.run_story()
            api.assert_not_called()
            ready.assert_not_called()

    def test_new_caption_transport_is_recorded_without_changing_text(self):
        data = {'caption': '文面🌸\n2行目'}
        story.check_caption_transport(data, False)
        self.assertEqual(data, {'caption': '文面🌸\n2行目', 'captionTransport': 'comment_as_caption_v1'})

    def test_preview_never_creates_publication_and_reuses_same_preview(self):
        self.args.preview_only = True
        view = {"id": JOB, "profile": "account1", "audience": "close_friends"}
        with patch.object(story, "ensure_ready"), patch.object(story, "api", return_value={"data": view}) as api:
            self.run_story()
            self.assertEqual(api.call_count, 1)
            self.assertEqual(api.call_args.args[0], "story-previews")
            self.assertEqual(api.call_args.args[3]["audience"], "close_friends")
        with patch.object(story, "ensure_ready"), patch.object(story, "api", return_value={"data": {"preview": view, "job": None}}) as api:
            story.run(self.args, self.directory)
            api.assert_called_once_with("story-previews/" + JOB, "account1", "same-key")

    def test_running_authenticated_relay_is_not_restarted(self):
        with patch.object(relay_runtime, "request", return_value={"status": "ok"}) as request, \
                patch.object(relay_runtime, "start_relay") as start:
            relay_runtime.ensure_running(start=True)
            request.assert_called_once_with("health", timeout=2)
            start.assert_not_called()

    def test_http_auth_failure_does_not_start_another_relay(self):
        with patch.object(relay_runtime, "request", side_effect=RuntimeError("Relay HTTP 401: AUTH_REQUIRED")), \
                patch.object(relay_runtime, "start_relay") as start:
            with self.assertRaises(RuntimeError):
                relay_runtime.ensure_running(start=True)
            start.assert_not_called()

    def highlight_responses(self, state="completed"):
        account = {"id": "123", "username": "owner"}
        target = {"id": "456", "title": "idol"}
        self.data.update(job=JOB, result={"state": "published", "account": account, "mediaId": "999"},
                         highlightIntent={"name": "idol", "id": None})
        result = {"id": JOB, "highlight": target, "storyJobId": JOB, "account": account,
                  "mediaId": "999", "audience": "close_friends", "profile": "account1", "state": state}
        return [{"data": {"account": account, "highlights": [target]}},
                {"data": {"id": JOB}}, {"data": result}]

    def test_highlight_registers_and_resume_only_polls(self):
        responses = self.highlight_responses()
        with patch.object(story, "api", side_effect=responses) as api:
            story.register_highlight(self.args, self.directory, self.data)
            self.assertEqual(api.call_args_list[1].args, (
                "highlights/456/stories", "account1", "same-key:highlight", {"storyJobId": JOB}))
        with patch.object(story, "api", return_value=responses[-1]) as api:
            story.register_highlight(self.args, self.directory, self.data)
            api.assert_called_once_with("highlight-jobs/" + JOB, "account1", "same-key:highlight")

    def test_unknown_highlight_does_not_create_another_job(self):
        responses = self.highlight_responses("unknown")
        with patch.object(story, "api", side_effect=responses):
            with self.assertRaises(RuntimeError):
                story.register_highlight(self.args, self.directory, self.data)
        with patch.object(story, "api", return_value=responses[-1]) as api:
            with self.assertRaises(RuntimeError):
                story.register_highlight(self.args, self.directory, self.data)
            self.assertEqual(api.call_count, 1)
            self.assertTrue(api.call_args.args[0].startswith("highlight-jobs/"))

    def test_duplicate_title_rejects_without_registering(self):
        responses = self.highlight_responses()
        responses[0]["data"]["highlights"].append({"id": "789", "title": "idol"})
        with patch.object(story, "api", side_effect=responses) as api:
            with self.assertRaises(RuntimeError):
                story.register_highlight(self.args, self.directory, self.data)
            self.assertEqual(api.call_count, 1)

    def test_highlight_only_requires_existing_job(self):
        self.args.highlight_only = True
        self.args.highlight = "idol"
        with patch.object(story, "api") as api, patch.object(story.subprocess, "run") as download:
            with self.assertRaises(RuntimeError):
                self.run_story()
            api.assert_not_called()
            download.assert_not_called()

    def test_preview_of_published_operation_does_not_add_highlight(self):
        self.data["job"] = JOB
        self.args.highlight = "idol"
        self.args.preview_only = True
        with patch.object(story, "api", return_value={"data": {
                "state": "published", "audience": "close_friends", "mediaId": "123"}}) as api:
            self.run_story()
            api.assert_called_once_with("story-jobs/" + JOB, "account1", "same-key")

    def test_changed_highlight_intent_never_contacts_relay(self):
        self.data["highlightIntent"] = {"name": "idol", "id": None}
        self.args.highlight = "video/image"
        with patch.object(story, "api") as api:
            with self.assertRaises(RuntimeError):
                self.run_story()
            api.assert_not_called()

    def test_highlight_result_mismatch_stops(self):
        responses = self.highlight_responses()
        responses[-1]["data"]["mediaId"] = "different"
        with patch.object(story, "api", side_effect=responses):
            with self.assertRaises(RuntimeError):
                story.register_highlight(self.args, self.directory, self.data)


if __name__ == "__main__":
    unittest.main()
