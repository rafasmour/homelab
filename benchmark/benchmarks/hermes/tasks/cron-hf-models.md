---
case: cron-hf-models
kind: cron
job: hf-models
profile: hf-models
order: 2
heading: "Hugging Face models"
research: true
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "30 1 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job hf-models hf-models, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Nightly new Hugging Face text models for the current Europe/Athens date.

1. clock_now once for today's date (YYYY-MM-DD).
2. mcp__huggingface__hub_repo_search once with repo_types ["model"], filters ["text-generation"], sort "trendingScore", and limit 15.
3. mcp__huggingface__hub_repo_search once with repo_types ["model"], filters ["gguf"], sort "trendingScore", and limit 15.
4. Keep models whose Created date is today or yesterday and that either have the gguf tag or more than 100 downloads. Skip image, audio, and video models. Never download weights.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "Hugging Face models, <YYYY-MM-DD>" with nothing before it. Then one bullet per kept model, each on one line: "- [<model id>](https://huggingface.co/<model id>): <why it qualified: GGUF, downloads, or GGUF and downloads>". At most 15 bullets, under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when no model qualifies.
C) One line "Error: Hugging Face search failed: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
