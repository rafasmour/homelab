---
case: cron-calories-report
kind: cron
job: calories-report
profile: calories
order: 9
heading: "Nutrition"
research: false
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "0 22 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job calories calories-report, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Evening nutrition report for the current Europe/Athens date.

1. clock_now once for today's date (YYYY-MM-DD).
2. mcp__wger__nutrition_summary once for today (pass today's date when the tool accepts one): kcal, protein, carbohydrates, fat, and fiber.

Do not create to-dos and do not log food in this job.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "Nutrition, <YYYY-MM-DD>" with nothing before it. Then one bullet each for kcal, protein, carbohydrates, fat, and fiber with the numbers from nutrition_summary; never invent numbers. Under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when nutrition_summary shows nothing logged today (0 kcal and no items). Never send a report of zeros.
C) One line "Error: nutrition summary failed: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
