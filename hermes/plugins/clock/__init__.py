"""clock: the current time and exact local-to-UTC conversion.

The system prompt only carries today's date, and the terminal toolset is
disabled, so the model had no clock: it computed "in an hour" from a UTC time
and filed reminders three hours early. The Nextcloud MCP stores a due time
without an offset as UTC and a "+03:00" offset as a non-IANA TZID, so to-dos
need a UTC ("...Z") value. These tools give both, using the Hermes timezone
(HERMES_TIMEZONE, default Europe/Athens) including daylight-saving changes.

Small models still write the local time instead of the converted value, so two
hooks back the tools up on profiles other than default (the default profile is
left exactly as it was):

* pre_tool_call: datetime arguments of Nextcloud to-do/event writes and wger
  log writes are normalised to UTC "...Z". A naive value that equals a UTC
  value clock_to_utc returned in this session just gets its Z; any other naive
  value is taken as Athens wall-clock time; an explicit non-UTC offset is
  converted. Date-only values, values already in UTC, all-day events and calls
  with a timezone argument are left alone.
* pre_tool_call also repairs `reminders` of the same to-do/event tools: each item
  keeps exactly one of trigger_at / minutes_before / trigger.
* transform_tool_result: calendar and wger-log results are UTC, which the model
  mis-speaks; one "Athens times:" line is appended with the same instants in
  Athens local time.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _zone() -> ZoneInfo:
    try:
        return ZoneInfo((os.environ.get("HERMES_TIMEZONE") or "Europe/Athens").strip())
    except ZoneInfoNotFoundError:
        return ZoneInfo("Europe/Athens")


def _describe(moment: datetime) -> dict:
    local = moment.astimezone(_zone())
    return {
        "local": local.isoformat(timespec="seconds"),
        "weekday": local.strftime("%A"),
        "utc": moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone": _zone().key,
        "utc_offset": local.strftime("%z")[:3] + ":" + local.strftime("%z")[3:],
    }


CLOCK_NOW_SCHEMA = {
    "name": "clock_now",
    "description": (
        "Current date and time in the user's timezone (Europe/Athens) and in UTC. "
        "Call it before resolving 'now', 'in an hour', 'tonight' or 'tomorrow morning'."
    ),
    "parameters": {"type": "object", "properties": {}},
}

CLOCK_TO_UTC_SCHEMA = {
    "name": "clock_to_utc",
    "description": (
        "Convert a local Europe/Athens date and time (e.g. 2026-10-24T10:00) to UTC. "
        "Use the returned 'utc' value (ending in Z) for Nextcloud to-do due/dtstart and wger 'when'. "
        "Optionally add minutes/hours/days to the local time first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "local_datetime": {
                "type": "string",
                "description": "Local wall-clock time, YYYY-MM-DDTHH:MM (no offset). Omit to use now.",
            },
            "add_minutes": {"type": "integer", "description": "Minutes to add first (e.g. 60 for 'in an hour')."},
            "add_days": {"type": "integer", "description": "Days to add first (e.g. 1 for 'tomorrow')."},
        },
    },
}


def _handle_now(args: dict, **kw) -> str:
    return json.dumps(_describe(datetime.now(timezone.utc)))


def _handle_to_utc(args: dict, **kw) -> str:
    args = args or {}
    raw = str(args.get("local_datetime") or "").strip()
    try:
        if raw:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            local = parsed.astimezone(_zone()) if parsed.tzinfo else parsed.replace(tzinfo=_zone())
        else:
            local = datetime.now(_zone())
        local = local + timedelta(
            minutes=int(args.get("add_minutes") or 0), days=int(args.get("add_days") or 0)
        )
        # Re-attach the zone so a DST change between now and the target uses the right offset.
        local = local.replace(tzinfo=None).replace(tzinfo=_zone())
    except (TypeError, ValueError) as exc:
        return json.dumps({"ok": False, "error": f"cannot parse {raw!r}: {exc}; use YYYY-MM-DDTHH:MM"})
    described = _describe(local)
    _remember(kw.get("session_id"), local.replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%S"), described["utc"])
    return json.dumps({"ok": True, **described})


log = logging.getLogger(__name__)

_MAX_SESSIONS = 200
_MAX_PAIRS = 30
_seen: "OrderedDict[str, list]" = OrderedDict()
_lock = threading.Lock()


def _remember(session_id, local_naive: str, utc: str) -> None:
    try:
        key = str(session_id or "")
        with _lock:
            pairs = _seen.pop(key, [])
            pairs.append((local_naive, utc))
            _seen[key] = pairs[-_MAX_PAIRS:]
            while len(_seen) > _MAX_SESSIONS:
                _seen.popitem(last=False)
    except Exception:  # never let bookkeeping break the tool
        pass


def _recorded_utc(session_id) -> set:
    with _lock:
        return {utc[:-1] for _, utc in _seen.get(str(session_id or ""), [])}


def _is_profile() -> bool:
    """True on every profile except default."""
    try:
        env = (os.environ.get("HERMES_PROFILE") or "").strip().lower()
        if env and env != "default":
            return True
        from hermes_constants import get_hermes_home

        return "profiles" in get_hermes_home().parts
    except Exception:
        return False


_NAIVE = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$")
_OFFSET = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$", re.I
)

# tool-name suffix -> datetime fields
_WRITE_FIELDS = {
    "nc_calendar_create_todo": ("due", "dtstart"),
    "nc_calendar_update_todo": ("due", "dtstart"),
    "nc_calendar_create_event": ("start_datetime", "end_datetime"),
    "nc_calendar_update_event": ("start_datetime", "end_datetime"),
    "log_ingredient": ("when",),
    "update_log_item": ("when",),
}
_RESULT_SUFFIXES = ("log_ingredient", "update_log_item", "list_log_items")


def _fix_value(value: str, recorded: set):
    """Return the UTC "Z" form of value, or None when it should stay as is."""
    v = value.strip()
    m = _NAIVE.match(v)
    if m:
        date, hh, mm, ss = m.group(1), m.group(2), m.group(3), m.group(4) or "00"
        norm = f"{date}T{hh}:{mm}:{ss}"
        if norm in recorded:
            return norm + "Z"
        local = datetime.fromisoformat(norm).replace(tzinfo=_zone())
        return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    m = _OFFSET.match(v)
    if m:
        off = m.group(5).upper()
        if off == "Z" or int(off.replace(":", "")[1:3] + off.replace(":", "")[3:5].ljust(2, "0")) == 0:
            return None
        parsed = datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4) or '00'}{_iso_offset(off)}")
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _iso_offset(off: str) -> str:
    digits = off[1:].replace(":", "")
    return f"{off[0]}{digits[:2]}:{digits[2:4] or '00'}"


def _fix_args(tool_name: str, args: dict, session_id) -> dict:
    """Changed fields only ({} when nothing changes)."""
    fields = None
    for suffix, names in _WRITE_FIELDS.items():
        if tool_name.endswith(suffix):
            fields = names
            break
    if not fields or not isinstance(args, dict):
        return {}
    if str(args.get("timezone") or "").strip():
        return {}
    if args.get("all_day") in (True, "true", "True", 1):
        return {}
    recorded = _recorded_utc(session_id)
    changed = {}
    for field in fields:
        value = args.get(field)
        if not isinstance(value, str) or not value.strip():
            continue
        try:
            new = _fix_value(value, recorded)
        except (ValueError, OverflowError):
            new = None
        if new and new != value:
            changed[field] = new
            log.info("clock: %s %s %s -> %s", tool_name, field, value, new)
    return changed


_REMINDER_TOOLS = ("nc_calendar_create_todo", "nc_calendar_update_todo",
                   "nc_calendar_create_event", "nc_calendar_update_event")
_REMINDER_KEYS = ("trigger_at", "minutes_before", "trigger")


def _fix_reminders(tool_name: str, args: dict):
    """Normalised `reminders` list (or None when it needs no change).

    The Nextcloud MCP wants exactly one of trigger_at / minutes_before / trigger
    per reminder; the model often sends two (minutes_before plus trigger "-PT15M").
    Priority: trigger_at, minutes_before, trigger. Items with none are dropped;
    other keys (action, description) stay.
    """
    if not tool_name.endswith(_REMINDER_TOOLS) or not isinstance(args, dict):
        return None
    reminders = args.get("reminders")
    if not isinstance(reminders, list):
        return None
    out = []
    for item in reminders:
        if not isinstance(item, dict):
            out.append(item)
            continue
        present = [k for k in _REMINDER_KEYS if item.get(k) not in (None, "")]
        if not present:
            continue
        fixed = {k: v for k, v in item.items() if k not in _REMINDER_KEYS}
        fixed[present[0]] = item[present[0]]
        out.append(fixed)
    if out == reminders:
        return None
    log.info("clock: %s reminders %s -> %s", tool_name, reminders, out)
    return out


def _pre_tool_call(tool_name="", args=None, session_id="", **kw):
    try:
        if not tool_name or tool_name.rsplit("__", 1)[-1].startswith("clock_") or not _is_profile():
            return None
        changed = _fix_args(str(tool_name), args or {}, session_id)
        try:
            reminders = _fix_reminders(str(tool_name), args or {})
        except Exception as exc:
            log.debug("clock reminders: %s", exc)
            reminders = None
        if reminders is not None:
            changed["reminders"] = reminders
        return {"action": "modify", "args": changed} if changed else None
    except Exception as exc:
        log.debug("clock pre_tool_call: %s", exc)
        return None


_TS = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\+00:00)|\d{8}T\d{6}Z"
)
_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December"]


def _parse_ts(ts: str) -> datetime:
    if re.fullmatch(r"\d{8}T\d{6}Z", ts):
        return datetime.strptime(ts, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _athens_line(result: str):
    found = []
    for ts in _TS.findall(result):
        if ts not in found:
            found.append(ts)
        if len(found) >= 40:
            break
    parts = []
    for ts in found:
        try:
            loc = _parse_ts(ts).astimezone(_zone())
        except ValueError:
            continue
        parts.append(
            f"{ts} = {_DAYS[loc.weekday()]} {loc.day} {_MONTHS[loc.month - 1]} {loc.year} {loc:%H:%M}"
        )
    return "\n\nAthens times: " + "; ".join(parts) if parts else None


def _transform_tool_result(tool_name="", result=None, status=None, **kw):
    try:
        name = str(tool_name or "")
        if not isinstance(result, str) or not _is_profile():
            return None
        if name.rsplit("__", 1)[-1].startswith("clock_"):
            return None
        if "nc_calendar_" not in name and not name.endswith(_RESULT_SUFFIXES):
            return None
        if str(status or "").lower() in ("error", "failed", "failure"):
            return None
        try:
            data = json.loads(result)
            if isinstance(data, dict) and (data.get("error") or data.get("isError") or data.get("success") is False):
                return None
        except ValueError:
            pass
        line = _athens_line(result)
        return result + line if line else None
    except Exception as exc:
        log.debug("clock transform_tool_result: %s", exc)
        return None


def register(ctx) -> None:
    ctx.register_tool(
        name="clock_now",
        toolset="clock",
        schema=CLOCK_NOW_SCHEMA,
        handler=_handle_now,
        description="Current time in Europe/Athens and UTC",
        emoji="🕒",
    )
    ctx.register_tool(
        name="clock_to_utc",
        toolset="clock",
        schema=CLOCK_TO_UTC_SCHEMA,
        handler=_handle_to_utc,
        description="Convert Athens local time to UTC",
        emoji="🕒",
    )
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("transform_tool_result", _transform_tool_result)
