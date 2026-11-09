---
case: assistant-cal-medium-el
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
params: {"todos": [{"summary_pattern": "λογιστ|φ[όο]ρ|accountant|tax", "due_utc": "{{UTC:D1T10:00}}", "calendars": "personal-1", "label": "ο λογιστής αύριο 10:00"}, {"summary_pattern": "δ[άα]νε[ίι]|loan", "due_utc": "{{UTC:D1T13:00}}", "calendars": "personal-1", "label": "τα δάνεια αύριο 13:00"}, {"summary_pattern": "[έε]π[ίι]πλ|furniture", "due_utc": "{{UTC:D2T17:00}}", "calendars": ["personal-1", "tasks"], "label": "τα έπιπλα μεθαύριο 17:00"}], "spoken": {"language": "el"}, "keywords": ["λογιστ", "δάνει", "δανει", "έπιπλ", "επιπλ"], "ok": "medium (+1/+2 days): 3 separate to-dos, {{D1}} 10:00 and 13:00, {{D2}} 17:00 Athens"}
---
Θύμισέ μου αύριο στις 10:00 π.μ. να ρωτήσω τον λογιστή για τον φόρο εισοδήματος και στη 1:00 μ.μ. να πληρώσω τα δάνεια. Μεθαύριο στις 5:00 μ.μ. να πληρώσω τα έπιπλα του σπιτιού.
