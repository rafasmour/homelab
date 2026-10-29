"""Unit tests for server.py with the runner API mocked.

  docker run --rm --network none -v ./tests:/app/tests:ro <image> python -m unittest discover -s /app/tests -v
"""

import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Fake:
    def __init__(self, active=False):
        self.active = active
        self.calls = []

    async def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path == "/models":
            return {"models": ["good-model"]}
        if path == "/status":
            return {"active": self.active}
        if path == "/runs":
            return {"started": True}
        return {}


class Tests(unittest.TestCase):
    def start(self, fake, *args, **kw):
        with mock.patch.object(server, "api", fake):
            return run(server.t_start(*args, **kw))

    def test_unknown_model_rejected_without_posting(self):
        f = Fake()
        with self.assertRaises(server.ToolError):
            self.start(f, "other-model")
        for bad in ("../x", "a b", "-rf", "", None, 5):
            with self.assertRaises(server.ToolError):
                self.start(f, bad)
        self.assertFalse([c for c in f.calls if c[0] == "POST"])

    def test_bad_suite_and_profile_rejected(self):
        f = Fake()
        with self.assertRaises(server.ToolError):
            self.start(f, "good-model", "everything")
        with self.assertRaises(server.ToolError):
            self.start(f, "good-model", "all", "nope")

    def test_second_concurrent_start_rejected(self):
        f = Fake(active=True)
        with self.assertRaises(server.ToolError) as cm:
            self.start(f, "good-model")
        self.assertIn("already active", str(cm.exception))
        self.assertFalse([c for c in f.calls if c[0] == "POST"])

    def test_valid_start_posts_once(self):
        f = Fake()
        self.start(f, "good-model", "cron", "finance")
        posts = [c for c in f.calls if c[0] == "POST"]
        self.assertEqual(posts, [("POST", "/runs", {"model": "good-model", "suite": "cron", "profile": "finance"})])

    def test_run_id_validation(self):
        for ok in ("latest", "2026-10-27_17-09", "2026-10-27_17-09-2"):
            with mock.patch.object(server, "api", Fake()):
                run(server.t_results(ok))
        for bad in ("../x", "2026-10-27", "latest/../x", "", None):
            with self.assertRaises(server.ToolError):
                run(server.t_results(bad))

    def test_safe_tool_hides_errors(self):
        @server.safe_tool
        async def boom():
            raise RuntimeError("secret")
        self.assertEqual(run(boom()), "Error: internal error")


if __name__ == "__main__":
    unittest.main()
