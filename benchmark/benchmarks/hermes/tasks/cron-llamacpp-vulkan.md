---
case: cron-llamacpp-vulkan
kind: cron
job: llamacpp-vulkan
profile: llamacpp-vulkan
order: 3
heading: "llama.cpp Vulkan"
research: true
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "0 2 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job llamacpp-vulkan llamacpp-vulkan, CRON_RULES expanded; frozen 2026-10-24, output contract revised 2026-10-24
---
Nightly llama.cpp Vulkan changes for the current Europe/Athens date.

1. clock_now once. Let <since> be yesterday's date as YYYY-MM-DD.
2. mcp__web_search__fetch_url once with url https://api.github.com/search/issues?q=repo:ggml-org/llama.cpp+vulkan+updated:%3E%3D<since>&sort=updated&order=desc&per_page=20 and max_chars 60000 (pull requests and issues).
3. mcp__web_search__fetch_url once with url https://api.github.com/search/commits?q=repo:ggml-org/llama.cpp+vulkan+committer-date:%3E%3D<since>&sort=committer-date&order=desc&per_page=20 and max_chars 60000.
4. Keep items that mention Vulkan in the title or message, at most 12, most recent first. Do not comment on GitHub.

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "llama.cpp Vulkan, <YYYY-MM-DD>" with nothing before it. Then one bullet per kept item, each on one line: "- [<title>](<html_url>): <the Vulkan-related change, at most 15 words>". At most 12 bullets, under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when nothing new mentions Vulkan.
C) One line "Error: GitHub search failed: <short error>" when a source failed and you have nothing else to report. Never answer [SILENT] after a failure.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
