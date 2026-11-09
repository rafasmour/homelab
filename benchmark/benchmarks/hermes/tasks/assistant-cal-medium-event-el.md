---
case: assistant-cal-medium-event-el
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 28
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"events": [{"summary_pattern": "οδοντ|dentist", "start_utc": "{{UTC:D2T17:00}}", "end_utc": "{{UTC:D2T18:00}}", "calendars": "personal", "label": "ο οδοντίατρος μεθαύριο"}], "spoken": {"language": "el"}, "keywords": ["οδοντ", "dentist"], "ok": "medium (+2 days): one event on personal {{D2}} 17:00-18:00 Athens"}
---
Κλείσε ραντεβού με τον οδοντίατρο μεθαύριο από τις 5 έως τις 6 το απόγευμα.
