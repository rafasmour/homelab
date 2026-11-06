"""Benchmark sandbox: no write of a benchmark run reaches a real system.

Active only when HERMES_BENCHMARK is set (the Hermes benchmark's `docker exec`
sets it per case, together with a throw-away HERMES_HOME). It wraps the tool
registry's dispatch:

* Tools that would act outside the throw-away home (Talk/messaging, cron jobs,
  delegation, shell and file writes, and every MCP write: notes, WebDAV,
  contacts, Firefly, n8n, benchmark runs, updates/deletes of items the case did
  not create) are NOT executed. They answer with a realistic fake success.
* Calendar events/to-dos and wger log items the case creates itself stay real,
  because the benchmark verifies them on the real system and deletes them by
  the ids recorded here. Updates and deletes of those same ids stay real too;
  of any other id they are faked. A wger meal (the MCP cannot delete one) is
  faked: its fake id is replaced by "no meal" in the real log call and
  shown again in the reply.
* Every call is appended to $HERMES_HOME/benchmark-calls.jsonl so the benchmark
  can grade attempted writes and clean up what it let through.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_CREATED: set[str] = set()  # uids / log item ids created for real by this case
_FAKE_MEALS: dict[str, dict] = {}

# Hermes built-in tools (not MCP) that act outside the throw-away home.
_ALWAYS_FAKE = {
    "talk_send", "send_message", "cronjob", "delegate_task",
    "terminal", "write_file", "patch", "execute_code", "process",
}
# First word of an MCP tool (after nc_<app>_ / talk_ / n8n_ prefixes) that writes.
_WRITE_VERBS = {
    "create", "update", "delete", "destroy", "complete", "append", "write", "upload", "move", "copy", "add",
    "remove", "share", "send", "post", "store", "edit", "set", "start", "cancel", "activate", "deactivate",
    "test", "run", "execute", "trigger", "import", "merge", "react", "mark", "archive", "restore", "rename",
    "log", "retain", "apply", "assign", "unassign", "invite", "join", "leave", "reply", "forward", "save",
    "publish", "unpublish", "autofix", "deploy",
}
# MCP tools that stay real: the benchmark verifies and removes what they create.
_REAL_CREATE = {"nc_calendar_create_event", "nc_calendar_create_todo", "log_ingredient"}
# Writes on an existing item: real only for an id this case created.
_ON_CREATED = {
    "nc_calendar_update_event", "nc_calendar_update_todo", "nc_calendar_complete_todo",
    "nc_calendar_delete_event", "nc_calendar_delete_todo", "update_log_item", "delete_log_item",
}
_ID_KEYS = ("event_uid", "todo_uid", "uid", "log_item_id")


def _enabled() -> bool:
    return (os.environ.get("HERMES_BENCHMARK") or "").strip() not in ("", "0")


def _home():
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        return None


def _split(name: str):
    """('mcp__nextcloud__nc_calendar_create_todo') -> ('nextcloud', 'nc_calendar_create_todo'); builtins -> (None, name)."""
    if name.startswith("mcp__"):
        parts = name.split("__", 2)
        if len(parts) == 3:
            return parts[1], parts[2]
    return None, name


def _verb(tool: str) -> str:
    words = tool.split("_")
    if words[0] == "nc" and len(words) > 2:
        words = words[2:]
    elif words[0] in ("talk", "collectives", "n8n") and len(words) > 1:
        words = words[1:]
    return words[0]


def _record(entry: dict) -> None:
    home = _home()
    if home is None:
        return
    entry["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        with _LOCK, open(os.path.join(str(home), "benchmark-calls.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception as exc:  # recording must never break the case
        logger.debug("benchmark_sandbox: cannot record: %s", exc)


def _mcp_result(payload: dict) -> str:
    return json.dumps({"result": json.dumps(payload, ensure_ascii=False), "structuredContent": payload}, ensure_ascii=False)


def _fake_payload(tool: str, args: dict) -> dict:
    """A plausible success reply for a write that was not executed."""
    args = args if isinstance(args, dict) else {}
    verb = _verb(tool)
    ident = next((str(args[k]) for k in _ID_KEYS if args.get(k)), None)
    out: dict = {"success": True, "status": "ok", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if verb in ("create", "store", "add", "start", "send", "post", "react", "log"):
        out["id"] = ident or str(uuid.uuid4())
        out["uid"] = out["id"]
        out["status_code"] = 201
    else:
        if ident:
            out["uid"] = ident
        out["status_code"] = 200
    for key in ("title", "name", "summary", "calendar_name", "path"):
        if args.get(key) is not None:
            out[key] = args[key]
    if tool.endswith("workflow") or "workflow" in tool:
        out["active"] = False
    return out


def _fake_meal_payload(args: dict) -> dict:
    meal_id = str(uuid.uuid4())
    payload = {"plan": args.get("plan_id"), "order": len(_FAKE_MEALS) + 1, "id": meal_id, "time": (f"{args.get('time')}:00" if args.get("time") and len(str(args.get("time"))) == 5 else args.get("time")), "name": args.get("name")}
    _FAKE_MEALS[meal_id] = payload
    return payload


def _created_id(result) -> str | None:
    text = result if isinstance(result, str) else json.dumps(result, default=str)
    m = re.search(r'"(?:uid|id)\\?"\s*:\s*\\?"([0-9A-Za-z-]{8,})\\?"', text)
    return m.group(1) if m else None


def _restore_meal(result: str, meal_id: str) -> str:
    """Show the fake meal id again in a real log item's reply."""
    try:
        outer = json.loads(result)
        inner = json.loads(outer["result"]) if isinstance(outer.get("result"), str) else outer.get("result")
        if isinstance(inner, dict):
            inner["meal"] = meal_id
            outer["result"] = json.dumps(inner, indent=2, ensure_ascii=False)
        if isinstance(outer.get("structuredContent"), dict):
            outer["structuredContent"]["meal"] = meal_id
        return json.dumps(outer, ensure_ascii=False)
    except Exception:
        return result


def _wrap(original):
    def dispatch(self, name, args, *a, **kw):
        server, tool = _split(str(name))
        args_d = args if isinstance(args, dict) else {}
        # 1. Built-ins that leave the throw-away home.
        if server is None and name in _ALWAYS_FAKE:
            payload = {"ok": True, "success": True, "status": "delivered" if name in ("talk_send", "send_message") else "ok"}
            _record({"tool": name, "args": args_d, "fake": True})
            return json.dumps(payload)
        if server is None:
            return original(self, name, args, *a, **kw)
        # 2. wger meals cannot be removed: fake them, hide the fake id from the real log call.
        if tool == "create_meal":
            payload = _fake_meal_payload(args_d)
            _record({"tool": name, "args": args_d, "fake": True, "result": payload})
            return _mcp_result(payload)
        ident = next((str(args_d[k]) for k in _ID_KEYS if args_d.get(k)), None)
        if tool in _REAL_CREATE or tool in ("update_log_item",) and args_d.get("meal_id") in _FAKE_MEALS:
            call_args = args_d
            fake_meal = None
            if args_d.get("meal_id") in _FAKE_MEALS:
                fake_meal = str(args_d["meal_id"])
                call_args = {k: v for k, v in args_d.items() if k != "meal_id"}
            if tool == "update_log_item" and ident not in _CREATED:
                payload = _fake_payload(tool, args_d)
                _record({"tool": name, "args": args_d, "fake": True, "result": payload})
                return _mcp_result(payload)
            result = original(self, name, call_args, *a, **kw)
            if tool in _REAL_CREATE:
                created = _created_id(result)
                if created:
                    _CREATED.add(created)
            if fake_meal:
                result = _restore_meal(result, fake_meal)
            _record({"tool": name, "args": args_d, "fake": False, "result": str(result)[:4000]})
            return result
        if tool in _ON_CREATED:
            if ident and ident in _CREATED:
                result = original(self, name, args, *a, **kw)
                _record({"tool": name, "args": args_d, "fake": False, "result": str(result)[:4000]})
                return result
            payload = _fake_payload(tool, args_d)
            _record({"tool": name, "args": args_d, "fake": True, "result": payload})
            return _mcp_result(payload)
        # 3. Every other MCP write.
        if _verb(tool) in _WRITE_VERBS:
            payload = _fake_payload(tool, args_d)
            _record({"tool": name, "args": args_d, "fake": True, "result": payload})
            return _mcp_result(payload)
        return original(self, name, args, *a, **kw)

    dispatch._homelab_benchmark = True
    return dispatch


def install() -> None:
    if not _enabled():
        return
    from tools.registry import ToolRegistry

    if getattr(ToolRegistry.dispatch, "_homelab_benchmark", False):
        return
    ToolRegistry.dispatch = _wrap(ToolRegistry.dispatch)
    _record({"tool": "__sandbox__", "fake": False})
    logger.info("benchmark_sandbox: writes are faked or recorded (HERMES_BENCHMARK set)")
