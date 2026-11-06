---
case: assistant-reminders-el
kind: chat
profile: ai-assistant
optin: true  # group "assistant": runs only with --profiles ai-assistant or --cases, never in the default selection
order: 21
toolsets: cli  # nextcloud_assistant, web_search, agents, clock, memory
write_tools: true
needs: nextcloud
setup: nextcloudSnapshot
verify: assistantOutcome
cleanup: nextcloudNew
params: {"todos": [{"summary_pattern": "λογιστ|φ[όο]ρ|accountant|tax", "due_utc": "{{TEST_DATE}}T08:00:00Z", "calendars": "personal-1", "label": "ο λογιστής / φόρος εισοδήματος 10:00"}, {"summary_pattern": "δ[άα]νε[ίι]|loan", "due_utc": "{{TEST_DATE}}T11:00:00Z", "calendars": "personal-1", "label": "τα δάνεια 13:00"}, {"summary_pattern": "[έε]π[ίι]πλ|furniture", "due_utc": "{{TEST_DATE}}T15:00:00Z", "calendars": ["personal-1", "tasks"], "label": "τα έπιπλα 17:00"}], "spoken": {"language": "el"}, "keywords": ["λογιστ", "δάνει", "δανει", "έπιπλ", "επιπλ"], "ok": "3 to-dos, 08:00Z / 11:00Z / 15:00Z"}
---
Θύμισέ μου στις 15 Ιανουαρίου 2027: να ρωτήσω τον λογιστή για τον φόρο εισοδήματος στις 10:00 π.μ., να πληρώσω τα δάνεια στη 1:00 μ.μ. και να πληρώσω τα έπιπλα του σπιτιού στις 5:00 μ.μ.
