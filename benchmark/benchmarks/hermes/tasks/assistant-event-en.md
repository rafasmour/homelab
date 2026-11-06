---
case: assistant-event-en
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 20
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"events": [{"summary_pattern": "to-?do|task|list|overdue|λίστα|εργασ", "start_utc": "{{TEST_DATE}}T08:00:00Z", "end_utc": "{{TEST_DATE}}T09:00:00Z", "calendars": "personal", "label": "check the to-do list"}], "spoken": {"language": "en"}, "keywords": ["to-do", "todo", "overdue"], "ok": "one event on personal 10:00-11:00 Athens"}
---
Create a calendar event on 15 January 2027 at 10:00 to check my to-do list, because many tasks are overdue.
