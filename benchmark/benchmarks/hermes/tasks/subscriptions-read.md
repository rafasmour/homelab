---
case: subscriptions-read
kind: chat
profile: finance
order: 13
toolsets: cli
write_tools: false
needs: firefly
setup: fireflyBillsSnapshot
verify: fireflyBillsListedReadOnly
params: {"expected": ["ψαλτική", "IDE", "Κινητό", "ίντερνετ", "ΦΠΑ", "Λογιστής"]}
---
List my Firefly subscriptions with amount and next date. Read only: do not create or change anything.
