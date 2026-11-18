---
case: assistant-delegate-n8n
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 23
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: false
kanban: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"cards": [{"assignee": ["n8n", "default"], "body_patterns": [{"pattern": "morning", "label": "the workflow name (morning)"}, {"pattern": "digest", "label": "the workflow name (digest)"}], "label": "n8n workflow check"}], "consults": [{"profile": "n8n", "request_patterns": [{"pattern": "morning", "label": "the workflow name (morning)"}, {"pattern": "digest", "label": "the workflow name (digest)"}], "label": "ask n8n about the workflow"}], "any_of": ["cards", "consults"], "spoken": {"language": "el"}, "keywords": [], "ok": "1 card for n8n (or default) or a consult of n8n, nothing in Nextcloud"}
---
Ζήτα από τον πράκτορα n8n να κοιτάξει γιατί το workflow «hermes digest morning-digest» δεν δουλεύει.
