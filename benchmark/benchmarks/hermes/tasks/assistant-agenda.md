---
case: assistant-agenda
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 25
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: false
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"must_call": [["nc_calendar_search_todos"], ["nc_calendar_get_upcoming_events", "nc_calendar_list_events"]], "mention_from_results": true, "spoken": {"language": "en"}, "keywords": [], "ok": "read both calendar and to-dos, created nothing"}
---
What do I have to do for the day?
