"""Unit tests for the clock reminder repair and the spoken_reply cleaner.

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
spoken = load("spoken_reply")
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


class SpokenReply(unittest.TestCase):
    def test_markdown(self):
        t = "## Σήμερα\n- **Γιατρός** στις 10\n- Ψώνια\n1. Πρώτο\nΔες https://example.com/x και [σύνδεσμο](http://a.b)."
        self.assertEqual(spoken.speakable(t),
                         "Σήμερα. Γιατρός στις 10. Ψώνια. Πρώτο. Δες και σύνδεσμο.")

    def test_table(self):
        t = "| A | B |\n|---|---|\n| 1 | 2 |"
        self.assertEqual(spoken.speakable(t), "A B. 1 2.")

    def test_stray_scripts_and_emoji(self):
        self.assertEqual(spoken.speakable("Η προγραμματισμός یادирования είναι έτοιμη 😀"),
                         "Η προγραμματισμός είναι έτοιμη")
        self.assertEqual(spoken.speakable("hello мир 你好 world"), "hello world")

    def test_never_empty(self):
        self.assertEqual(spoken.speakable("мир"), "мир")
        self.assertEqual(spoken.speakable(""), "")

    def test_plain_text_unchanged_and_hook(self):
        os.environ["HERMES_PROFILE"] = "ai-assistant"
        plain = "Έχεις συνάντηση αύριο στις δέκα."
        self.assertEqual(spoken.speakable(plain), plain)
        self.assertIsNone(spoken._transform_llm_output(response_text=plain))
        self.assertEqual(spoken._transform_llm_output(response_text="- ένα\n- δύο"), "ένα. δύο.")
        os.environ["HERMES_PROFILE"] = "default"
        self.assertIsNone(spoken._transform_llm_output(response_text="- ένα"))


if __name__ == "__main__":
    unittest.main()
