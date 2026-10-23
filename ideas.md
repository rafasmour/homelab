# Ideas: automation, agentic workflows and services

Collected on 2026-10-23 from a scan of every stack in this repo and from web research. Each idea has a rough **effort / value** and the reason it takes something off your plate. RAM is the real limit on this host (15 GB, about 25 stacks), not the GPU, so new services are listed with a RAM estimate.

Guiding rule for agents on a small local model (Mellum 2.1, 12B MoE): **deterministic steps (n8n, scripts, Paperless workflows) fetch, filter, do dates and maths; the LLM only extracts, classifies or summarises into a fixed schema; a human confirms anything that writes money or deletes data.** Keep each Hermes profile at about 5–10 tools ([over-tooled agents](https://tianpan.co/blog/2026/04/19/over-tooled-agent-problem), [reliable tool calls](https://unified.to/blog/how_to_build_reliable_tool_calls_for_ai_agents)).

## 0. Fix first (risk, not features)

| Idea | Effort / value | Why |
|---|---|---|
| **Backups with Backrest** (`garethgeorge/backrest`, restic, ~50–100 MB) | medium / **critical** | There is no backup system at all: no restic/borg/kopia, no timers. Vaultwarden, Nextcloud, Firefly, n8n, wger, Open WebUI, Hermes volumes and every `.env` exist only on this disk; Immich's DB dump sits next to the originals. Pre-hooks run `pg_dump`/`mariadb-dump` per stack; local copy to `/mnt/htd` (1.3 TB free) plus an off-site, append-only target. ([Backrest](https://newreleases.io/project/github/garethgeorge/backrest/release/v1.14.0), [borgmatic DB hooks](https://torsion.org/borgmatic/how-to/backup-your-databases/) as the alternative) |
| **Backup watchdog + restore test** | low / high | Grafana rule or n8n check: newest snapshot older than 26 h → Talk alert. A quarterly Hermes reminder to restore one stack into a scratch folder (TODO.md has the restore test unchecked). |
| **Revive the Firefly bank import** | low / high | The n8n "Piraeus monthly statement" workflow has not run since 2026-10-13 and the newest Firefly transaction is 2026-09-25. Add a Grafana/n8n "no new transactions for 7 days" alert, then consider **Enable Banking** (free restricted mode, covers Piraeus/NBG/Alpha/Eurobank; GoCardless is closed to new sign-ups) with the data importer's auto-import ([Firefly providers](https://docs.firefly-iii.org/how-to/data-importer/import/third-party-providers/), [Enable Banking GR](https://enablebanking.com/docs/markets/gr/), [auto-import](https://docs.firefly-iii.org/how-to/data-importer/import/automated/)). Consent renews every 90–180 days → a Hermes reminder. |
| **Loki retention** | low / medium | 2.2 GB of logs with no retention configured; set 30 days. |
| **TLS / external reachability monitors** | low / medium | Uptime Kuma has 35 monitors, all `docker` type, and no notification channel. Add HTTP/TLS monitors for the public hostnames (cert expiry) and route Kuma to Talk or ntfy. |

## 1. Paperwork off your desk (biggest win)

| Idea | Effort / value | What it takes off your back |
|---|---|---|
| **Paperless-ngx + paperless-gpt** (~2–4 GB during OCR, then ~2 GB) | medium / **very high** | Greek bills and letters arrive by scan or e-mail (IMAP mail rules by sender) and come out OCR'd (`PAPERLESS_OCR_LANGUAGE=ell+eng`), tagged, with custom fields Amount / Due date / Invoice no. [paperless-gpt](https://github.com/icereed/paperless-gpt) uses llama.cpp (OpenAI-compatible) for titles, tags, correspondent and fields, with a review UI; keep Tesseract as baseline OCR (small vision models can produce gibberish, [thread](https://forum.level1techs.com/t/need-help-with-ai-ocr-for-paperless-ngx/249465)). Avoid paperless-ai (unmaintained). Put paperless-gpt behind Traefik auth. ([Paperless workflows](https://railway.com/deploy/paperless-ngx-workflows--deploy-paperless-ngx-workflow-automation), [mail rules](https://blog.elest.io/using-paperless-to-consume-documents-from-your-email-accounts-2/)) |
| **Bill inbox-zero pipeline** | medium / very high | Paperless webhook → n8n validates amount/date → creates the Firefly bill (via the existing `firefly-mcp` or API) and a Nextcloud to-do on the right task list for the due date → Talk summary in the Finance room. Documents without a due date get a "review" tag. |
| **Bill due reminders without an LLM** | low / high | n8n cron reads Firefly bills (`pay_dates`/`paid_dates`) and Paperless due-date fields → "due in 3 days" in the Finance room. Paperless's date-relative scheduled triggers can do half of it natively. |
| **Receipt photo → Firefly** | medium / high | Photo in the Finance room → `gemma-4-12b-it-qat-vision` extracts `{merchant, date, total, vat}` as strict JSON → n8n matches the bank transaction (same amount, ±1 day) and categorises it; no match → draft + approval. OCR misreads digits (8→6), so always confirm. ([n8n template](https://n8n.io/workflows/11339-record-transactions-and-generate-budget-reports-with-gemini-ai-telegram-and-firefly-iii/), [matching design](https://baerentsen.space/automating_firefly_iii_budgeting/)) |
| **Transaction auto-categoriser** | low / medium | Nightly: uncategorised Firefly transactions → LLM picks from an enum of existing categories → unmatched stay untouched. Firefly currently has 0 categories, budgets and rules, so start by creating ~10 categories. |

## 2. Hermes: new jobs and profiles

Existing: 9 profiles, 8 nightly/daily jobs, one Talk room each. Gaps found in the scan:

| Idea | Effort / value | Notes |
|---|---|---|
| **Morning digest that reads every task list** | low / high | `morning-digest` only reads `personal`, `tasks` and `homelab`; it never shows Personal-1, **Γάμος (14 open to-dos)**, Δουλειά or the parish lists. Read all VTODO lists, add bills due this week (Firefly), backup status and Uptime Kuma state. One LLM call over data n8n or the tools collected. |
| **Weekly review** (Sunday evening, own room or default) | low / medium | Completed vs open tasks per list, Firefly spend vs last week, wger averages vs target, Immich "on this day", next week's calendar. |
| **Wedding planner profile** | low / high (time-bound) | A profile scoped to the Γάμος list and calendar: due-date chasing, weekly countdown digest, vendor contacts. |
| **Homelab ops profile + self-healing with approval** | medium / medium | [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana) with `--disable-write` and `--enabled-tools` (PromQL, LogQL, alerts). Grafana alert → ops room → LLM proposes one of `{restart, ignore, escalate}` → you approve → n8n runs an allowlisted `restart_container(name)` → verify. Never give the agent the Docker socket directly ([pattern](https://piefed.keyboardvagabond.com/post/397656), add the approval gate). |
| **Model manager tool** | low / medium | Wrap the router's native `POST`/`DELETE /models` (now tested) in a small tool: "install Gemma 31B" → pull, then propose a preset following the >64k / f16-or-q8_0 rules. |
| **Fix gpu-watch price-drop alerts** | low / low | The "below last price" comparison relied on the notepad, which is disabled; store the last price in a Nextcloud note or let changedetection.io do it (section 4). |
| **Remove legacy profiles** | low / low | `router` and `digest` still sit on the Hermes volume; the orphaned `hermes_conversation` entry in Home Assistant points at `router`. |

## 3. Home Assistant: make it actually do things

The scan found HA essentially unconfigured: no devices, automations or scripts; Whisper and Piper run but are **not connected** (no Wyoming integration, Assist uses the built-in agent) and are set to English.

| Idea | Effort / value | Notes |
|---|---|---|
| **Greek voice pipeline** | low / medium | Add the Wyoming integrations, switch Whisper to a Greek-capable model (`small`/`medium`) and Piper to the el_GR voice "rapunzelina" ([Piper](https://github.com/tiiuae/piper), [voice](https://tts.ai/voices/piper-rapunzelina-greek/)). |
| **Voice notes from Talk → tasks** | medium / medium | Talk audio → Whisper (Speaches, OpenAI-compatible STT; CPU, since its images are CUDA-only, [speaches](https://github.com/speaches-ai/speaches)) → Hermes creates `{title, due}` to-dos. Cheaper than voice hardware. |
| **HA ↔ Hermes** | medium / medium | HA's built-in MCP server is OAuth-only and admin-scoped ([docs](https://www.home-assistant.io/integrations/mcp_server)); use a community server ([ha-mcp](https://pypi.org/p/ha-mcp-dev)) with only exposed entities, once there are devices worth controlling. The phone's `mobile_app` location could drive "remind me when I get home". |

## 4. New services that take chores away

| Service | RAM | Effort / value | What it does for you |
|---|---|---|---|
| **ntfy** (`binwiederhier/ntfy`) | ~30 MB | low / high | Phone push for Kuma, Grafana, Backrest, HA, n8n, with action buttons for approvals ([docs](https://docs.ntfy.sh/)). Talk stays the agent channel; ntfy for urgent pushes. |
| **changedetection.io** | ~150 MB | low / medium | Watches gov.gr / ΔΕΗ / utility notice pages, prices and restocks; optional LLM "only alert if…" rules; alerts via ntfy or Apprise (`nctalk://` to Talk) ([changedetection](https://www.mintlify.com/dgtlmoon/changedetection.io), [Apprise Talk](https://github.com/caronc/apprise/wiki/Notify_nextcloudtalk)). |
| **Miniflux** (or Karakeep for read-later) | ~80 MB (+Postgres) / ~0.6–1 GB | low / medium | RSS with a full API, so the morning digest can include "top 5 items"; Karakeep adds AI tagging and has an official MCP (`@karakeep/mcp`) so Hermes can "save this link" ([comparison](https://selfhosting.sh/compare/freshrss-vs-miniflux/), [Karakeep MCP](https://glama.ai/mcp/servers/shvyoib0jx)). |
| **Renovate in GitLab CI** (needs GitLab deployed) | CI only | medium / medium | Opens merge requests for image tag bumps across all compose files; Hermes summarises release notes so updates become a 5-minute weekly review ([discussion](https://lemmy.blahaj.zone/post/36135098)). Diun is the notify-only alternative if GitLab stays off. |
| **Homebox** | ~50 MB | low / low–medium | Warranties, receipts and serial numbers, linked to Paperless documents ([wiki](https://wiki.linux-server-admin.com/web-apps/inventory-management/homebox)). |
| **E-mail triage via n8n** | – | medium / high (if you get many mails) | IMAP trigger → sender allowlist → LLM classifies into `{bill, action, newsletter, ignore}` → move to folder + Talk digest. Start read-only ([mcp-imap-server](https://github.com/mattias242/mcp-imap-server)). Inbox Zero is Gmail/Outlook-only. |

Skip: Infisical (≈4 GB RAM; keep secrets in Vaultwarden with a quarterly token-age reminder instead), Actual Budget (Firefly + Enable Banking already covers it), media automation, a Vaultwarden MCP (agents could reveal or delete credentials).

## 5. Use data you already collect

| Idea | Effort / value | Notes |
|---|---|---|
| **Meal plan → grocery list** | medium / medium | Mealie (deploy **one** of Mealie/Tandoor; neither is running) + wger targets → 7-day plan as JSON → shopping list into a Nextcloud task list, with approval ([mealie-mcp](https://glama.ai/mcp/servers/nikopol666/mealie-mcp)). |
| **Photo food logging** | medium / medium | Photo in the Calories room → vision model estimates items and grams → existing wger tools log them after you confirm. |
| **Body weight / training** | low / low–medium | wger has 0 routines, sessions and measurements; a weekly "weight?" prompt in the Calories room would give the 22:00 report a trend. |
| **Immich "on this day" + document photos** | medium / medium | 2,322 photos with faces and 2,190 OCR rows; [ImmichMCP](https://github.com/barryw/ImmichMCP) (avoid the 276-tool `okopok/immich-mcp`). A weekly digest, or forwarding photos of documents to Paperless. Also check the `Photos-00x.zip` archives in `/mnt/htd/Photos` against Immich. |
| **RAG over your notes** | low / medium | Open WebUI has 0 knowledge bases and there is no embedding model; add a small embedding GGUF to the router (e.g. EmbeddingGemma) and index Nextcloud Notes. |
| **Prometheus for llama.cpp and Traefik** | low / low | llama-server already has `--metrics`; scrape it (tokens/s, queue) and Traefik for request errors. |

## 6. Clean-up (less to maintain)

- Pick one of Mealie / Tandoor and delete the other; same for Excalidraw / draw.io (ChartDB is a different tool).
- Remove dead stacks: `unsloth-studio` (needs NVIDIA), `image-generation` (README for an 8 GB card; redo for the 7900 XT or drop), leftovers `forage/`, `deepseek-agent-harness/` data, the `invidious_companion-cache` volume.
- Memos is empty and overlaps Nextcloud Notes, which Hermes already uses.
- Stale docs: the n8n README still describes the old Payments-calendar flow; the Home Assistant README says Hermes was removed; the nextcloud SOUL mentions mail/news/collectives, which are not installed.
- Set `TZ=Europe/Athens` on n8n (only one workflow sets it) and Firefly (runs on UTC, which shifted bill dates).

## Suggested order

1. Backrest + backup watchdog, ntfy, Loki retention, Kuma notifications.
2. Revive the Firefly import (alert first, Enable Banking next).
3. Morning digest over all task lists + weekly review.
4. Paperless-ngx + paperless-gpt → bill inbox-zero → due reminders.
5. Receipt photo → Firefly, transaction categoriser.
6. Homelab ops profile with approval-gated self-healing.
7. Greek voice pipeline, meal planning, Immich digests, RAG.

Expect roughly 3–4 GB of extra RAM for Paperless, Backrest, ntfy, Miniflux and changedetection together; check `docker stats` first.
