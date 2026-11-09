---
case: assistant-cal-easy-en
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
params: {"events": [{"summary_pattern": "to-?do|task|list|overdue|λίστα|εργασ", "start_utc": "{{UTC:D0TLATER}}", "end_utc": "{{UTC:D0TLATER_END}}", "calendars": "personal", "label": "check the to-do list"}], "spoken": {"language": "en"}, "keywords": ["to-do", "todo", "overdue"], "ok": "easy (today): one event on personal today {{LATER}}-{{LATER_END}} Athens"}
---
Create a calendar event today at {{LATER}} to check my to-do list, because many tasks are overdue.
