---
case: calendar-event
kind: chat
profile: default
order: 12
toolsets: cli
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: nextcloudEventCreated
cleanup: nextcloudNew
params: {"calendar": "personal", "start_utc": "{{TEST_DATE}}T15:00:00Z", "end_utc": "{{TEST_DATE}}T16:00:00Z", "summary_pattern": "dentist|οδοντ", "summary_label": "the dentist", "ok": "VEVENT on personal 15:00Z-16:00Z", "keywords": ["dentist", "οδοντ"]}
---
Dentist appointment on {{TEST_DATE}} from 17:00 to 18:00.
