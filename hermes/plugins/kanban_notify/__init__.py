"""kanban_notify: tell the owner in Nextcloud Talk when a Kanban card finishes.

Hooks only (no tools). Hermes fires kanban_task_completed and
kanban_task_blocked in the worker process after the board change is committed
(hermes_cli/kanban_db.py). The message goes to the Talk home room through the
hermes-nextcloud-bridge ``POST /deliver`` endpoint; URL, secret and room come
from the process environment. Benchmark runs (HERMES_BENCHMARK=1) post only to
HERMES_BENCHMARK_TALK_ROOM and skip without it. A hook never raises.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request

log = logging.getLogger(__name__)

MAX_SUMMARY = 3000
MAX_CHARS = 30000


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _room() -> str:
    if _env("HERMES_BENCHMARK") not in ("", "0"):
        return _env("HERMES_BENCHMARK_TALK_ROOM")
    return _env("NEXTCLOUD_TALK_HOME_ROOM")


def _deliver(message: str) -> None:
    url, secret, room = _env("NEXTCLOUD_TALK_DELIVER_URL"), _env("NEXTCLOUD_TALK_DELIVER_SECRET"), _room()
    if not (url and secret and room):
        log.info("kanban_notify: Talk delivery not configured, message skipped")
        return
    request = urllib.request.Request(
        url,
        data=json.dumps({"room_token": room, "message": message[:MAX_CHARS], "actor": "hermes-tool"}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read(1000)


def _task(task_id, board):
    """Return (title, assignee, latest summary) of the card; blanks on failure."""
    try:
        from contextlib import closing

        from hermes_cli import kanban_db

        with closing(kanban_db.connect(board=board) if board else kanban_db.connect()) as conn:
            task = kanban_db.get_task(conn, task_id)
            summary = None
            try:
                summary = kanban_db.latest_summary(conn, task_id)
            except Exception:
                pass
            if task is not None:
                return (task.title or ""), (task.assignee or ""), summary
    except Exception as exc:
        log.info("kanban_notify: could not read card %s: %s", task_id, exc)
    return "", "", None


def _notify(kind: str, task_id, board, assignee, text) -> None:
    try:
        title, found_assignee, latest = _task(task_id, board)
        who = assignee or found_assignee or "unknown"
        title = title or str(task_id)
        text = (text or latest or "").strip()
        if kind == "Done":
            text = text[:MAX_SUMMARY] or "(no summary)"
        else:
            text = text[:MAX_SUMMARY] or "(no reason given)"
        _deliver(f"{kind}: {title} ({who}): {text}")
    except Exception as exc:
        log.warning("kanban_notify: %s message for %s failed: %s", kind, task_id, exc)


def _on_completed(task_id=None, board=None, assignee=None, summary=None, **kwargs) -> None:
    _notify("Done", task_id, board, assignee, summary)


def _on_blocked(task_id=None, board=None, assignee=None, reason=None, **kwargs) -> None:
    _notify("Blocked", task_id, board, assignee, reason)


def register(ctx) -> None:
    ctx.register_hook("kanban_task_completed", _on_completed)
    ctx.register_hook("kanban_task_blocked", _on_blocked)
