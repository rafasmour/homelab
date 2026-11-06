---
case: assistant-time-el
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 27
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: false
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"must_call": [["clock_now"]], "max_calls": 2, "spoken": {"language": "el"}, "keywords": [], "ok": "asked the clock, answered briefly in Greek"}
---
Τι ώρα είναι;
