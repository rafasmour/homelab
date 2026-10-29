---
case: cron-morning-digest
kind: cron
job: morning-digest
profile: nextcloud
order: 8
heading: "Good morning"
research: false
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "0 7 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job nextcloud morning-digest, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Morning digest for the current Europe/Athens date.

1. clock_now once for today's date and weekday.
2. mcp__nextcloud__nc_calendar_list_events once with calendar_name "personal", start_date today and end_date today (YYYY-MM-DD).
3. mcp__nextcloud__nc_calendar_search_todos once with status "NEEDS-ACTION". It returns the open to-dos of every task list (Home, Homelab, Personal, Γάμος, Δουλειά, Π Ηλίας, Αγ. Παρασκευή), each with its calendar.

Do not create, change, or complete anything.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "Good morning, <weekday> <YYYY-MM-DD>" with nothing before it. Then these sections in Markdown:
- "Today": each event with its start time and title (leave out when there are none).
- "Due or overdue": to-dos due today or earlier, each with its list and due date (leave out when there are none).
- "Open per list": one line per task list with open to-dos: the list name, the count, and up to 3 titles.
Under 2500 characters in total.
B) Exactly [SILENT] (nothing before or after it) when there are no events today and no open to-dos.
C) One line "Error: Nextcloud calendar could not be read: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
