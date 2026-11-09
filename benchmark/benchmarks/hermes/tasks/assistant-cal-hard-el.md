---
case: assistant-cal-hard-el
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 29
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"todos": [{"summary_pattern": "υδραυλ|plumber", "due_utc": "{{UTC:D4T11:00}}", "calendars": ["tasks", "personal-1"], "label": "ο υδραυλικός {{D4_EL}} 11:00"}, {"summary_pattern": "λογιστ|accountant", "due_utc": "{{UTC:D1T11:00}}", "calendars": ["personal-1", "tasks"], "label": "ο λογιστής αύριο 11:00"}], "spoken": {"language": "el"}, "keywords": ["υδραυλ", "λογιστ", "plumber", "accountant"], "ok": "hard (later date first, then an earlier one at the same time): plumber {{D4}} 11:00, accountant {{D1}} 11:00 Athens"}
---
Θύμισέ μου {{D4_EL}} στις 11:00 να πάρω τον υδραυλικό να δω πότε θα τελειώσει το σπίτι. Και αύριο στις 11:00 να πάρω τον λογιστή.
