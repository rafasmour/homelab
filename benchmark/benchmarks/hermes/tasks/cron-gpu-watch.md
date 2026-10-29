---
case: cron-gpu-watch
kind: cron
job: gpu-watch
profile: gpu-watch
order: 5
heading: "GPU prices"
research: true
toolsets: cron  # platform_toolsets.cron of the profile, read from hermes-api at run time
schedule: "30 2 * * *"  # reference only: the former Hermes cron schedule
source: hermes/start.sh ensure_cron_job gpu-watch gpu-watch, CRON_RULES expanded, watchlist from hermes/gpu-watchlist.example.yml; frozen 2026-10-24, output contract revised 2026-10-24
---
Nightly Greek GPU prices for the current Europe/Athens date. Watchlist:

- RTX 5070 Ti
- RTX 5080 Ti
- RTX 5090 Ti
- RTX 5060 Ti
- RX 9070
- RX 9060

If the watchlist is "(none)", call no tools; the final response is exactly "[SILENT]".

1. clock_now once for today's date (YYYY-MM-DD).
For each product, at most one call of each step:
2. mcp__web_search__fetch_url with url https://www.skroutz.gr/search?keyphrase=<product name, URL-encoded> and max_chars 40000.
3. If that fails or shows no in-stock offer: mcp__web_search__web_search with query "<product name> τιμή", then mcp__web_search__fetch_url on one bestprice.gr, public.gr, plaisio.gr, or kotsovolos.gr result from it.
4. Note the lowest in-stock EUR price, the shop, and the link. Ignore out-of-stock offers, listings without a shippable price, shops outside Greece, and different models (for example a 5070 when the product is 5070 Ti).

Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Never call a tool twice with the same arguments: reuse the result you already have, and never retry a failed call unchanged. Report only what a tool result in this run shows, and drop duplicates (same link or same title). A tool result that starts with "Could not fetch" or "Could not extract", or that reports an HTTP error, is a failure, not an empty result.

Final response: exactly one of A, B or C, and nothing else.
A) The digest. The first line is "GPU prices, <YYYY-MM-DD>" with nothing before it. Then one bullet per product that has an in-stock offer, each on one line: "- <product>: <lowest price> € at <shop>, [<offer title>](<link>)". Prefix a bullet with "ALERT " when the product has a target_price and today's lowest price is below it. Leave out products without an offer. Under 3000 characters in total.
B) Exactly [SILENT] (nothing before or after it) when at least one shop page was read and no product has an in-stock offer, even if other shop pages failed.
C) One line "Error: no shop page could be read: <short error, such as skroutz.gr 403>" when every shop page you tried failed.

Your final response is posted to the Talk room exactly as you write it, so it is the message itself and nothing else: never your plan, your reasoning, the steps you took, tool names, notes about these instructions, or a sentence explaining why there is nothing to report.
