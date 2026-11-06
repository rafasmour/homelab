---
case: assistant-reminder-delegate
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 22
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: true
kanban: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"todos": [{"summary_pattern": "phone|τηλ[έε]φων|κινητ", "due_utc": "{{TEST_DATE}}T07:00:00Z", "calendars": ["tasks", "personal-1"], "label": "check the phone 09:00"}], "cards": [{"assignee": "calories", "body_patterns": [{"pattern": "toast|τοστ", "label": "the toast"}], "label": "log the toast"}], "consults": [{"profile": "calories", "request_patterns": [{"pattern": "toast|τοστ", "label": "the toast"}], "label": "ask calories to log the toast"}], "any_of": ["cards", "consults"], "spoken": {"language": "en"}, "keywords": ["phone"], "ok": "1 to-do 07:00Z + (card for calories or consult of calories)"}
---
Remind me on 15 January 2027 at 9:00 to check my phone, and note that I ate a toast.
