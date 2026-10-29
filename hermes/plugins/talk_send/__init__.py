"""talk_send: post a message to the calling profile's Nextcloud Talk room.

The message is sent through the hermes-nextcloud-bridge ``POST /deliver``
endpoint, so it appears as the Hermes Talk bot and notifies the room members.
The bridge URL, bearer secret and room tokens come from the process
environment and are never part of the tool schema or the model prompt. The room
is the profile's entry in NEXTCLOUD_TALK_PROFILE_ROOMS ("profile=token|...") or,
without one, NEXTCLOUD_TALK_HOME_ROOM.

Benchmark runs (HERMES_BENCHMARK=1, set per `docker exec` by the benchmark
runner) post only to HERMES_BENCHMARK_TALK_ROOM, the mock user's room. Without
that room the tool is unavailable; it never falls back to the real rooms.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

MAX_CHARS = 30000

TALK_SEND_SCHEMA = {
    "name": "talk_send",
    "description": (
        "Send a message to the user in Nextcloud Talk (this profile's Hermes room). "
        "The message is posted by the Hermes bot and notifies the user. "
        "Use it for notifications, reminders and results the user must see now. "
        "Returns ok=true and the delivery status when the message was posted."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "Plain text or Markdown message to post.",
            },
        },
        "required": ["message"],
    },
}


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _profile() -> str:
    try:
        from hermes_constants import get_hermes_home

        home = get_hermes_home()
    except Exception:
        return "default"
    return home.name if home.parent.name == "profiles" else "default"


def _benchmark() -> bool:
    return _env("HERMES_BENCHMARK") not in ("", "0")


def _room() -> str:
    if _benchmark():
        return _env("HERMES_BENCHMARK_TALK_ROOM")
    for entry in _env("NEXTCLOUD_TALK_PROFILE_ROOMS").split("|"):
        profile, sep, token = entry.partition("=")
        if sep and profile.strip() == _profile() and token.strip():
            return token.strip()
    return _env("NEXTCLOUD_TALK_HOME_ROOM")


def _available() -> bool:
    # Inside a Talk-room run the bridge posts the reply itself; offering talk_send
    # there only duplicated the answer and kept the run going.
    if _env("HERMES_SOURCE") == "nextcloud-talk":
        return False
    return bool(
        _env("NEXTCLOUD_TALK_DELIVER_URL")
        and _env("NEXTCLOUD_TALK_DELIVER_SECRET")
        and (_room() if _benchmark() else _env("NEXTCLOUD_TALK_HOME_ROOM"))
    )


def _handle_talk_send(args: dict, **kw) -> str:
    # Cron jobs deliver their final answer to the profile's room automatically;
    # a model calling talk_send there posted the digest again (8 times once).
    if str(kw.get("session_id") or "").startswith("cron_"):
        return json.dumps({
            "ok": False,
            "error": "Scheduled job: do not call talk_send. Your final answer is posted to Talk automatically; just give it.",
        })
    message = str((args or {}).get("message") or "").strip()
    if not message:
        return json.dumps({"ok": False, "error": "message is required"})
    if not _available():
        if _benchmark():
            return json.dumps({"ok": False, "error": "Benchmark run without a mock Talk room (HERMES_BENCHMARK_TALK_ROOM): nothing was sent"})
        return json.dumps({"ok": False, "error": "Talk delivery is not configured (NEXTCLOUD_TALK_* env)"})
    payload = {
        "room_token": _room(),
        "message": message[:MAX_CHARS],
        "actor": "hermes-tool",
    }
    request = urllib.request.Request(
        _env("NEXTCLOUD_TALK_DELIVER_URL"),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + _env("NEXTCLOUD_TALK_DELIVER_SECRET"),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read(300).decode("utf-8", "replace")
        return json.dumps({"ok": False, "error": f"bridge HTTP {exc.code}: {detail}"})
    except Exception as exc:  # network errors, timeouts
        return json.dumps({"ok": False, "error": f"bridge unreachable: {exc!r}"})
    try:
        data = json.loads(body) if body else {}
    except ValueError:
        data = {}
    if data.get("ok") is False:
        return json.dumps({"ok": False, "error": str(data.get("error") or body[:300])})
    return json.dumps({"ok": True, "status": data.get("status", "delivered")})


def register(ctx) -> None:
    ctx.register_tool(
        name="talk_send",
        toolset="talk",
        schema=TALK_SEND_SCHEMA,
        handler=_handle_talk_send,
        check_fn=_available,
        description="Send a message to this profile's Nextcloud Talk room",
        emoji="💬",
    )
