"""clock: the current time and exact local-to-UTC conversion.

The system prompt only carries today's date, and the terminal toolset is
disabled, so the model had no clock: it computed "in an hour" from a UTC time
and filed reminders three hours early. The Nextcloud MCP stores a due time
without an offset as UTC and a "+03:00" offset as a non-IANA TZID, so to-dos
need a UTC ("...Z") value. These tools give both, using the Hermes timezone
(HERMES_TIMEZONE, default Europe/Athens) including daylight-saving changes.
"""

from __future__ import annotations

import json
import os
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
    return json.dumps({"ok": True, **_describe(local)})


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
