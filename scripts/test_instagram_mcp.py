"""MCPの公開境界・再送防止・stdio接続を、実投稿なしで確認する。"""

import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import uuid

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.fastmcp.exceptions import ToolError

import instagram_mcp as server


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.patcher = patch.object(server.relay, "ROOT", self.root)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.operation_id = str(uuid.uuid4())
        self.preview_id = str(uuid.uuid4())
        self.data = {
            "url": "https://youtu.be/example", "profile": "account1", "audience": "close_friends",
            "caption": "テスト / 本人", "captionTransport": "comment_as_caption_v1", "key": "test-key",
            "preview": {"id": self.preview_id, "profile": "account1", "account": {"id": "123", "username": "test"},
                        "audience": "close_friends", "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()},
        }
        self.write()

    def write(self):
        directory = self.root / self.operation_id
        directory.mkdir(exist_ok=True)
        (directory / "operation.json").write_text(json.dumps(self.data), encoding="utf-8")

    async def test_preview_never_calls_publish(self):
        with patch.object(server, "_profile", return_value="account1"), patch.object(server, "_run", new_callable=AsyncMock) as run:
            await server.instagram_preview_url("https://youtu.be/example", "close_friends", comment="テスト")
            args = run.call_args.args[0]
            self.assertIn("--preview-only", args)
            self.assertEqual(args[args.index("--audience") + 1], "close_friends")

    async def test_account_or_audience_mismatch_stops_before_network(self):
        with patch.object(server, "_request") as request:
            for account, audience in (("999", "close_friends"), ("123", "all")):
                with self.assertRaises(ToolError):
                    await server.instagram_publish_operation(self.operation_id, account, audience)
            request.assert_not_called()

    async def test_expired_preview_stops_before_network(self):
        self.data["preview"]["expiresAt"] = "2000-01-01T00:00:00Z"
        self.write()
        with patch.object(server, "_request") as request:
            with self.assertRaises(ToolError):
                await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
            request.assert_not_called()

    async def test_missing_preview_cannot_publish(self):
        del self.data["preview"]
        self.write()
        with self.assertRaises(ToolError):
            await server.instagram_publish_operation(self.operation_id, "123", "close_friends")

    async def test_legacy_comments_stop_before_network(self):
        for change in ({"captionTransport": "legacy"}, {"comment": "旧方式"}):
            original = dict(self.data)
            self.data.update(change)
            self.write()
            with patch.object(server, "_request") as request:
                with self.assertRaises(ToolError):
                    await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
                request.assert_not_called()
            self.data = original

    async def test_changed_preview_is_rejected(self):
        with patch.object(server, "_request", return_value={"data": {"preview": None, "job": None}}), patch.object(server, "_run", new_callable=AsyncMock) as run:
            with self.assertRaises(ToolError):
                await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
            run.assert_not_called()

    async def test_publish_is_persisted_before_single_request(self):
        def request(endpoint, profile="", key="", payload=None):
            if endpoint.endswith("/publish"):
                persisted = server._ledger(self.operation_id)
                self.assertEqual(persisted["job"], self.preview_id)
                self.assertEqual(persisted["mcpPublishAttempt"]["state"], "sending")
                self.assertEqual(payload, {"confirmed": True})
                return {"data": {"id": self.preview_id, "profile": "account1", "state": "queued"}}
            return {"data": {"preview": self.data["preview"], "job": None}}
        with patch.object(server, "_request", side_effect=request) as api, patch.object(server, "_run", new_callable=AsyncMock) as run:
            await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
            self.assertEqual(sum(c.args[0].endswith("/publish") for c in api.call_args_list), 1)
            self.assertEqual(server._ledger(self.operation_id)["mcpPublishAttempt"]["state"], "accepted")
            self.assertEqual(run.call_args.args[0][run.call_args.args[0].index("--comment") + 1], "テスト / 本人")

    async def test_response_loss_is_not_retried(self):
        def request(endpoint, *args):
            if endpoint.endswith("/publish"):
                raise ToolError("応答喪失")
            if "/story-jobs/" in endpoint:
                return {"data": {"state": "unknown", "id": self.preview_id}}
            return {"data": {"preview": self.data["preview"], "job": None}}
        with patch.object(server, "_request", side_effect=request) as api, patch.object(server, "_run", new_callable=AsyncMock) as run:
            first = await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
            second = await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
            self.assertFalse(first["commandSucceeded"])
            self.assertEqual(second["result"]["state"], "unknown")
            self.assertEqual(sum(c.args[0].endswith("/publish") for c in api.call_args_list), 1)
            run.assert_not_called()

    async def test_existing_jobs_are_read_only(self):
        self.data["job"] = self.preview_id
        self.write()
        for state in ("queued", "published", "unknown", "failed"):
            with patch.object(server, "_request", return_value={"data": {"state": state}}) as api, patch.object(server, "_run", new_callable=AsyncMock) as run:
                result = await server.instagram_publish_operation(self.operation_id, "123", "close_friends")
                self.assertEqual(result["result"]["state"], state)
                self.assertTrue(all("/story-jobs/" in c.args[0] for c in api.call_args_list))
                run.assert_not_called()

    async def test_preview_cannot_reuse_an_accepted_operation(self):
        self.data["job"] = self.preview_id
        self.write()
        with patch.object(server, "_run", new_callable=AsyncMock) as run:
            with self.assertRaises(ToolError):
                await server.instagram_preview_url(self.data["url"], operation_id=self.operation_id)
            run.assert_not_called()

    async def test_highlight_unknown_is_not_resent(self):
        self.data.update(job=self.preview_id, highlightIntent={"name": "Music", "id": None},
                         highlightJob=str(uuid.uuid4()))
        self.write()
        def request(endpoint, *args):
            return {"data": {"state": "unknown" if "highlight-jobs" in endpoint else "published"}}
        with patch.object(server, "_request", side_effect=request), patch.object(server, "_run", new_callable=AsyncMock) as run:
            result = await server.instagram_resume_highlight(self.operation_id)
            self.assertEqual(result["highlightResult"]["state"], "unknown")
            run.assert_not_called()

    async def test_url_and_path_boundaries(self):
        for value in ("http://youtu.be/x", "https://evil.example/x", "https://u:p@youtu.be/x", "https://youtu.be:443/x"):
            with self.assertRaises(ToolError):
                server._validate_url(value)
        with self.assertRaises(ToolError):
            server._operation_path("../../settings.json")
        self.assertEqual(server._validate_url("https://www.instagram.com/reel/AbC/?igsh=example")[0],
                         "https://www.instagram.com/p/AbC/")

    async def test_local_browser_is_not_started(self):
        with patch.object(server.relay, "settings", return_value={"profiles": [{"browser": {"type": "launch"}}]}), patch.object(server.relay, "ensure_running") as start:
            with self.assertRaises(ToolError):
                server._ensure_relay()
            start.assert_not_called()

    async def test_raw_source_and_signed_urls_are_not_returned(self):
        self.data["source"] = {"imageUrl": "https://cdn.example/?secret=hidden"}
        self.write()
        self.assertNotIn("hidden", json.dumps(server._summary(self.operation_id)))

    async def test_schema_marks_writes_and_hides_raw_proxy(self):
        tools = {tool.name: tool for tool in await server.mcp.list_tools()}
        self.assertEqual(len(tools), 8)
        self.assertTrue(tools["instagram_accounts"].annotations.readOnlyHint)
        self.assertFalse(tools["instagram_publish_operation"].annotations.readOnlyHint)
        self.assertIn("expected_audience", tools["instagram_publish_operation"].inputSchema["required"])
        self.assertIsNotNone(tools["instagram_status"].outputSchema)
        self.assertNotIn("request", tools)


async def stdio_check(live=False):
    params = StdioServerParameters(command=sys.executable, args=["-B", str(Path(server.__file__).resolve())],
                                   env=dict(os.environ, PYTHONUTF8="1"))
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert len(tools.tools) == 8
            rejected = await session.call_tool("instagram_publish_operation", {
                "operation_id": "invalid-id", "expected_account_id": "0", "expected_audience": "all"})
            assert rejected.isError
            if live:
                status = await session.call_tool("instagram_status", {})
                accounts = await session.call_tool("instagram_accounts", {})
                assert not status.isError and not accounts.isError
                data = status.structuredContent
                assert data and data["ready"] is True
                print(json.dumps({"stdio": "接続成功", "tools": len(tools.tools), "ready": data["ready"],
                                  "account": data.get("account"), "published": False}, ensure_ascii=False))


if __name__ == "__main__":
    live = "--live" in sys.argv
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(BoundaryTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    asyncio.run(stdio_check(live))
