---
case: cron-payments-unpaid
kind: cron
job: payments-unpaid
profile: finance
order: 7
heading: "Unpaid subscriptions"
research: false
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "30 3 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job finance payments-unpaid, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Nightly unpaid-subscriptions check in Firefly III for the current Europe/Athens date.

1. clock_now once. Today is its date as YYYY-MM-DD.
2. mcp__firefly__list_bill once with start = the first day of the current month and end = today (YYYY-MM-DD). Each bill lists the dates it is expected to be paid (pay_dates) and the payments already linked to it (paid_dates).
3. For each active bill, compare every pay date with today, as YYYY-MM-DD:
   - A pay date after today is not due yet. Ignore it, even when it is in this month (for example, when today is 2026-10-24, a pay date 2026-10-31 is not due).
   - A pay date on or before today that is not among the bill's paid_dates is unpaid.
   List a bill only when it has an unpaid pay date. A bill whose pay dates are all after today is never listed.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "Unpaid subscriptions, <YYYY-MM-DD>" with nothing before it. Then one bullet per unpaid pay date, each on one line: "- <bill name>: <amount> EUR, due <pay date>". Under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when no bill has an unpaid pay date, including when every pay date is after today.
C) One line "Error: Firefly bills could not be read: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
