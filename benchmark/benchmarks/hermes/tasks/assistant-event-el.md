---
case: assistant-event-el
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
params: {"events": [{"summary_pattern": "οδοντ|dentist", "start_utc": "{{TEST_DATE}}T15:00:00Z", "end_utc": "{{TEST_DATE}}T16:00:00Z", "calendars": "personal", "label": "ο οδοντίατρος"}], "spoken": {"language": "el"}, "keywords": ["οδοντ", "dentist"], "ok": "one event on personal 17:00-18:00 Athens"}
---
Κλείσε ραντεβού με τον οδοντίατρο στις 15 Ιανουαρίου 2027 από τις 5 έως τις 6 το απόγευμα.
