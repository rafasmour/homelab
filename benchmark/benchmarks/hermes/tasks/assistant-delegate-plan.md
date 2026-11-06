---
case: assistant-delegate-plan
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 24
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: false
kanban: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"cards": [{"assignee": "planner", "body_patterns": [{"pattern": "fine-?tun", "label": "fine-tuning"}, {"pattern": "greek|ellin|ελλην", "label": "Greek"}], "label": "planner research card"}], "spoken": {"language": "en"}, "keywords": [], "ok": "1 card for planner, nothing in Nextcloud"}
---
Ask the planner to research how we could fine-tune a small model for Greek and for our homelab tools, and to write up a plan. It should not report back before 15 January 2027 at 10:00.
