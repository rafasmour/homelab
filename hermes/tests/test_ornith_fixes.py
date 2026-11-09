"""Unit tests for the clock plugin: clock_to_utc, the datetime guard and the reminder repair.

Run: python3 -m unittest discover -s hermes/tests
"""
import importlib.util
import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "plugins"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / name / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


clock = load("clock")
TOOL = "mcp__nextcloud_assistant__nc_calendar_create_todo"


class ClockReminders(unittest.TestCase):
    def setUp(self):
        os.environ["HERMES_PROFILE"] = "ai-assistant"

    def run_hook(self, args, tool=TOOL):
        return clock._pre_tool_call(tool_name=tool, args=args, session_id="s")

    def test_minutes_before_wins_over_trigger(self):
        r = self.run_hook({"summary": "x", "reminders": [{"minutes_before": 15, "trigger": "-PT15M"}]})
        self.assertEqual(r["args"]["reminders"], [{"minutes_before": 15}])

    def test_trigger_at_priority_and_other_keys(self):
        r = self.run_hook({"reminders": [{"trigger_at": "2026-11-08T10:00:00Z", "minutes_before": 5,
                                          "trigger": "-PT5M", "action": "DISPLAY", "description": "d"}]})
        self.assertEqual(r["args"]["reminders"],
                         [{"action": "DISPLAY", "description": "d", "trigger_at": "2026-11-08T10:00:00Z"}])

    def test_drops_empty_items(self):
        r = self.run_hook({"reminders": [{"action": "DISPLAY"}, {"trigger": "-PT10M"}]})
        self.assertEqual(r["args"]["reminders"], [{"trigger": "-PT10M"}])

    def test_valid_is_noop(self):
        self.assertIsNone(self.run_hook({"reminders": [{"minutes_before": 15}]}))
        self.assertIsNone(self.run_hook({"summary": "no reminders"}))

    def test_default_profile_and_other_tools_noop(self):
        bad = {"reminders": [{"minutes_before": 15, "trigger": "-PT15M"}]}
        os.environ["HERMES_PROFILE"] = "default"
        self.assertIsNone(self.run_hook(bad))
        os.environ["HERMES_PROFILE"] = "ai-assistant"
        self.assertIsNone(self.run_hook(bad, tool="mcp__x__nc_notes_create_note"))

    def test_never_raises(self):
        self.assertIsNone(self.run_hook({"reminders": "oops"}))
        self.assertIsNone(self.run_hook({"reminders": [5, None]}))

    def test_combines_with_datetime_fix(self):
        clock._handle_to_utc({"local_datetime": "2026-11-08T10:00"}, session_id="s")
        r = self.run_hook({"due": "2026-11-08T10:00", "reminders": [{"minutes_before": 15, "trigger": "-PT15M"}]})
        self.assertEqual(r["args"]["due"], "2026-11-08T08:00:00Z")
        self.assertEqual(r["args"]["reminders"], [{"minutes_before": 15}])


class ClockToUtc(unittest.TestCase):
    def resolve(self, now_utc, **args):
        import json
        from datetime import datetime, timezone
        real = clock._now
        clock._now = lambda: datetime.fromisoformat(now_utc).replace(tzinfo=timezone.utc)
        try:
            return json.loads(clock._handle_to_utc(args, session_id="t"))
        finally:
            clock._now = real

    def test_tomorrow_late_sunday_is_monday(self):
        # 2026-11-08 22:26 Athens: "tomorrow at 11:00" was filed on Tuesday.
        r = self.resolve("2026-11-08T20:26:30", add_days=1, time="11:00")
        self.assertEqual(r["utc"], "2026-11-09T09:00:00Z")
        self.assertEqual((r["weekday"], r["relative"], r["in_past"]), ("Monday", "tomorrow", False))

    def test_athens_date_not_utc_date(self):
        # 23:30 UTC on the 8th is already the 9th in Athens: tomorrow is the 10th.
        r = self.resolve("2026-11-08T23:30:00", add_days=1, time="09:00")
        self.assertEqual((r["local"], r["relative"]), ("2026-11-10T09:00:00+02:00", "tomorrow"))

    def test_today_past_time(self):
        r = self.resolve("2026-11-09T09:30:00", add_days=0, time="11:00")
        self.assertEqual((r["utc"], r["relative"], r["in_past"]), ("2026-11-09T09:00:00Z", "today", True))

    def test_dst_offset_of_target_day(self):
        # Created in summer time (+03:00), due after the switch to winter time (+02:00).
        r = self.resolve("2026-10-24T09:00:00", add_days=2, time="10:00")
        self.assertEqual((r["utc"], r["utc_offset"], r["relative"]), ("2026-10-26T08:00:00Z", "+02:00", "in 2 days"))

    def test_named_date_and_time_override(self):
        r = self.resolve("2026-11-08T20:00:00", local_datetime="2027-01-15", time="13:00")
        self.assertEqual((r["utc"], r["relative"]), ("2027-01-15T11:00:00Z", "in 68 days"))
        r = self.resolve("2026-11-08T20:00:00", local_datetime="2026-11-10T11:00")
        self.assertEqual((r["utc"], r["relative"]), ("2026-11-10T09:00:00Z", "in 2 days"))

    def test_in_an_hour_and_yesterday(self):
        r = self.resolve("2026-11-08T20:26:00", add_minutes=60)
        self.assertEqual((r["local"], r["relative"]), ("2026-11-08T23:26:00+02:00", "today"))
        r = self.resolve("2026-11-08T20:26:00", add_days=-1, time="13:00")
        self.assertEqual((r["utc"], r["relative"], r["in_past"]), ("2026-11-07T11:00:00Z", "yesterday", True))

    def test_resolved_value_passes_hook_unchanged(self):
        r = self.resolve("2026-11-08T20:26:30", add_days=1, time="11:00")
        os.environ["HERMES_PROFILE"] = "ai-assistant"
        hook = clock._pre_tool_call(tool_name=TOOL, args={"due": r["utc"]}, session_id="t")
        self.assertIsNone(hook)
        hook = clock._pre_tool_call(tool_name=TOOL, args={"due": r["utc"][:-1]}, session_id="t")
        self.assertEqual(hook["args"]["due"], r["utc"])

    def test_bad_time(self):
        for bad in ("25:00", "noon", "11:7"):
            self.assertFalse(self.resolve("2026-11-08T20:00:00", add_days=1, time=bad)["ok"])


class ClockGuard(unittest.TestCase):
    """pre_tool_call blocks datetimes no clock tool or earlier result gave the session."""

    NOW = "2026-11-09T12:45:16"

    def setUp(self):
        import json
        from datetime import datetime, timezone
        os.environ["HERMES_PROFILE"] = "ai-assistant"
        self.json = json
        self.sid = f"guard-{self._testMethodName}"
        self.real = clock._now
        clock._now = lambda: datetime.fromisoformat(self.NOW).replace(tzinfo=timezone.utc)

    def tearDown(self):
        clock._now = self.real

    def hook(self, args, tool=TOOL):
        return clock._pre_tool_call(tool_name=tool, args=args, session_id=self.sid)

    def to_utc(self, **args):
        return self.json.loads(clock._handle_to_utc(args, session_id=self.sid))

    def test_self_computed_utc_is_blocked(self):
        # 2026-11-09: clock_now, then a UTC value the model worked out itself.
        clock._handle_now({}, session_id=self.sid)
        r = self.hook({"todo_uid": "x", "due": "2026-11-09T09:00:00Z"})
        self.assertEqual(r["action"], "block")
        self.assertIn("clock_to_utc", r["message"])
        self.assertIn("due 2026-11-09T09:00:00Z", r["message"])

    def test_self_typed_local_is_blocked(self):
        self.assertEqual(self.hook({"due": "2026-11-10T11:00:00"})["action"], "block")

    def test_clock_to_utc_value_passes(self):
        utc = self.to_utc(add_days=0, time="11:00")["utc"]
        self.assertIsNone(self.hook({"due": utc}))
        # Its local form is converted, not blocked.
        r = self.hook({"due": "2026-11-09T11:00"})
        self.assertEqual(r, {"action": "modify", "args": {"due": "2026-11-09T09:00:00Z"}})

    def test_existing_value_from_search_passes(self):
        result = '{"todos":[{"uid":"x","due":"2026-11-10T09:00:00+00:00"}]}'
        clock._transform_tool_result(tool_name="mcp__nextcloud_assistant__nc_calendar_search_todos",
                                     result=result, session_id=self.sid)
        self.assertIsNone(self.hook({"todo_uid": "x", "due": "2026-11-10T09:00:00Z"}))

    def test_clock_now_for_wger_just_now(self):
        now = self.json.loads(clock._handle_now({}, session_id=self.sid))["utc"]
        self.assertIsNone(self.hook({"when": now}, tool="mcp__wger__log_ingredient"))
        self.assertIsNone(self.hook({"when": "2026-11-09T12:45Z"}, tool="mcp__wger__log_ingredient"))

    def test_other_sessions_values_do_not_count(self):
        clock._handle_to_utc({"add_days": 0, "time": "11:00"}, session_id="someone-else")
        self.assertEqual(self.hook({"due": "2026-11-09T09:00:00Z"})["action"], "block")

    def test_not_guarded(self):
        self.assertIsNone(self.hook({"due": "2026-11-10"}))
        self.assertIsNone(self.hook({"start_datetime": "2026-11-10T00:00:00Z", "all_day": True},
                                    tool="mcp__nextcloud__nc_calendar_create_event"))
        self.assertIsNone(self.hook({"summary": "no dates"}))
        self.assertIsNone(self.hook({"due": "2026-11-09T09:00:00Z"}, tool="mcp__x__nc_notes_create_note"))
        os.environ["HERMES_PROFILE"] = "default"
        self.assertIsNone(self.hook({"due": "2026-11-09T09:00:00Z"}))

    def test_end_derived_from_checked_start_passes(self):
        # 2026-11-09: start from clock_to_utc, end = start + 1 h computed by the model.
        ev = "mcp__nextcloud_assistant__nc_calendar_create_event"
        start = self.to_utc(add_days=0, time="16:45")["utc"]
        self.assertIsNone(self.hook({"start_datetime": start, "end_datetime": "2026-11-09T15:45:00Z"}, tool=ev))
        self.assertEqual(self.hook({"start_datetime": start, "end_datetime": "2026-11-11T15:45:00Z"},
                                   tool=ev)["action"], "block")
        self.assertEqual(self.hook({"start_datetime": "2026-11-12T10:00:00Z",
                                    "end_datetime": "2026-11-12T11:00:00Z"}, tool=ev)["action"], "block")

    def test_updates_are_never_blocked(self):
        for tool in ("mcp__nextcloud_assistant__nc_calendar_update_todo",
                     "mcp__nextcloud_assistant__nc_calendar_update_event", "mcp__wger__update_log_item"):
            for field in ("due", "start_datetime", "when"):
                r = self.hook({"uid": "x", field: "2026-10-01T08:00:00Z"}, tool=tool)
                self.assertTrue(r is None or r["action"] == "modify", (tool, field, r))
        # Naive values on updates are still converted from Athens time.
        r = self.hook({"due": "2026-10-01T10:00"}, tool="mcp__nextcloud_assistant__nc_calendar_update_todo")
        self.assertEqual(r["args"]["due"], "2026-10-01T07:00:00Z")

    def test_block_wins_over_reminder_repair(self):
        r = self.hook({"due": "2026-11-09T09:00:00Z", "reminders": [{"minutes_before": 5, "trigger": "-PT5M"}]})
        self.assertEqual(r["action"], "block")


if __name__ == "__main__":
    unittest.main()
