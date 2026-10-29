---
case: reminder-todo
kind: chat
profile: nextcloud
order: 11
toolsets: cli
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: nextcloudTodoCreated
cleanup: nextcloudNew
params: {"calendar": "homelab", "due_utc": "{{TEST_DATE}}T08:00:00Z", "due_label": "10:00 Athens", "summary_pattern": "rocm|llama", "ok": "VTODO on homelab due 08:00Z", "keywords": ["rocm", "llama.cpp"]}
---
Remind me on {{TEST_DATE}} at 10:00 to update the llama.cpp ROCm image on the server.
