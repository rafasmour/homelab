---
case: cron-ai-news
kind: cron
job: ai-news
profile: ai-news
web: true  # needs the web search/extract tools: opt-in (--web or --cases), not in the default selection
order: 1
heading: "r/LocalLLaMA"
research: true
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "0 1 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job ai-news ai-news, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Nightly r/LocalLLaMA digest for the current Europe/Athens date.

1. clock_now once for today's date (YYYY-MM-DD).
2. mcp__web_search__fetch_url once with url https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day (an RSS feed returned as a list of posts with links and dates). Reddit rate-limits repeated requests.
3. Only if that fails: mcp__web_search__web_search once with query "r/LocalLLaMA" and use the Reddit results it returns.
4. Keep at most 8 posts dated within the last 24 hours, in feed order.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "r/LocalLLaMA, <YYYY-MM-DD>" with nothing before it. Then one bullet per kept post, each on one line: "- [<post title>](<post link>): <why it matters, at most 15 words>". At most 8 bullets, under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when no post is from the last 24 hours.
C) One line "Error: Reddit feed and search failed: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
