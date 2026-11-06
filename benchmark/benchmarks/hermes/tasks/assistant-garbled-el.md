---
case: assistant-garbled-el
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 26
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: false
kanban: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"max_calls": 1, "spoken": {"language": "el"}, "keywords": [], "ok": "no card, no item, short Greek reply"}
---
Οι κινήσεις του μέσα στη νύχτα ενώθηκαν κομμάτι κομμάτι μέσα από τις καταθέσεις του συναδέλφου και τα αρχεία των επικοινωνιών του.
