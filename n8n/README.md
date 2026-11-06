# n8n

## Description

Workflow automation at `https://n8n.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set the database password, keep `TZ=Europe/Athens` (schedule triggers use it) and a permanent `N8N_ENCRYPTION_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the owner account in the browser. Never change the encryption key after credentials have been stored.

To reset a forgotten password (no SMTP is configured, so the "Forgot password" email does not work), run `scripts/reset-n8n-password.sh [EMAIL]` from the repository root. It defaults to the owner account, asks for the new password silently (8-64 characters, at least one number and one capital letter), hashes it with bcrypt inside the `n8n` container, and updates the `user` table in `n8n-database`. Workflows, credentials and API keys are kept.

## Hermes MCP integration

The `mcp` service runs the official [n8n MCP server](https://github.com/czlonkowski/n8n-mcp) with workflow-management tools enabled. Containers on the `hermes-mcp` network use `http://n8n-mcp:3000/mcp`. Traefik also routes `https://n8n-mcp.${DOMAIN}/mcp` to it. There is no host port. Callers must send `Authorization: Bearer <N8N_MCP_AUTH_TOKEN>`.

Create an API key under **Settings > n8n API**, store it as `N8N_API_KEY`, and generate `N8N_MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Put the same MCP token in `hermes/.env`; Hermes uses it as the Bearer token for `http://n8n-mcp:3000/mcp`.

Start the Hermes stack before this stack. Hermes creates the shared network, while this Compose file references it as external:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

The MCP server can create, update, execute, and delete workflows. Back up production workflows and review changes before running them.

## Piraeus monthly statement

`workflows/piraeus-monthly-import.json` is imported into the running n8n container and left inactive. Connect a Gmail OAuth credential on its trigger, set `PIRAEUS_ZIP_PASSWORD`, and set the same `AUTO_IMPORT_SECRET` in this `.env` and `firefly-iii/.env`. Import one normalized CSV through the Firefly data importer UI and save that mapping as `imports/_fallback.json`. The workflow runs `piraeus-import.cjs`, which extracts the password-protected zip with `adm-zip` (BusyBox `unzip` does not support zip passwords), decodes the bank CSV from Windows-1253 to UTF-8 (override with `PIRAEUS_CSV_ENCODING`), writes `imports/piraeus-current.csv`, and asks the importer to load it. Rebuild the `n8n` image after changing `scripts/package.json` (`docker compose --env-file .env build n8n`). A successful import moves that CSV into `firefly-iii/import-archive`. The workflow saves the zip at `/tmp/piraeus-statement.zip`, so Compose sets `N8N_RESTRICT_FILE_ACCESS_TO` to allow `/tmp` alongside `~/.n8n-files`.

## Firefly subscriptions calendar

`workflows/firefly-subscriptions-to-nextcloud.json` runs at 00:30 Europe/Athens and does not use a model. It lists Firefly III bills (`GET /api/v1/bills?start=<today>&end=<today + 366 days>`) and upserts one all-day event per active subscription on the Nextcloud calendar `http://nextcloud/remote.php/dav/calendars/pi.hole/Payments/`. Each event includes the amount, the next date, and the Firefly id. The event is written with `PUT` to the fixed URL `firefly-bill-<id>.ics` with UID `firefly-bill-<id>@homelab`, so every run overwrites the previous event instead of adding one. Bills that are deactivated or deleted in Firefly keep their last event; delete it by hand.

The calendar URL is fixed in the workflow's `Payments calendar` node. There is no CalDAV discovery, because the HTTP Request node in n8n 2.35.7 sends a raw body only with `GET`, `POST`, `PUT` and `PATCH` (`HttpRequestV3.node.js`), never with `PROPFIND` or `REPORT`. A `Check Payments calendar` node sends a body-less `PROPFIND` (Depth 0) and stops the run when the calendar is missing. Create the calendar once with `docker exec -u www-data nextcloud php occ dav:create-calendar pi.hole Payments` (URI and display name `Payments`). If you change the user or calendar URI, edit that node.

Credentials (none are stored in the workflow file):

- `List Firefly bills` uses `Hermes digest – Firefly III token` (`hdFireflyToken01`), created by `scripts/hermes-digests-setup.sh`.
- The CalDAV nodes use `Nextcloud CalDAV – Payments` (`ncCalDavBasic001`, Basic Auth). `scripts/firefly-subscriptions-setup.sh` creates it from `NEXTCLOUD_MCP_USERNAME` and `NEXTCLOUD_MCP_APP_PASSWORD` in `nextcloud/.env`, checks that this user owns the calendar URL, and imports the workflow inactive. Add `--publish` to activate it and restart n8n so the schedule is registered, or `--credentials-only` to update only the credential.

```bash
sh n8n/scripts/firefly-subscriptions-setup.sh             # credential + workflow (inactive)
sh n8n/scripts/firefly-subscriptions-setup.sh --publish   # ... and activate it
```

Until October 2026 the workflow never worked: no credential was attached to any node, so a manual run failed at the first CalDAV request with `NodeOperationError: Credentials not found`, and it was never activated. Its `PROPFIND` discovery (principal, calendar home, calendar list) would then have failed because the request bodies were dropped. The bills request also had no `start` and `end`, and Firefly III 6.6 only calculates `pay_dates` and `next_expected_match` for a date range, so every bill would have been skipped. No Nextcloud calendar named Payments existed either. Unpaid bills are reported separately by the `Hermes digest – payments-unpaid` workflow, which reads Firefly directly.

## Hermes digests

Nine workflows replace the former Hermes cron jobs. They are deterministic: HTTP Request nodes fetch, Code nodes filter, compute dates and format, and at most one LLM call (no tools) writes one-line summaries. Each posts Markdown to the Talk room of its Hermes profile through `POST http://hermes-nextcloud-bridge:8788/deliver`, and posts nothing when there is nothing to report. The files `workflows/hermes-digest-<job>.json` are the source of truth; the workflow id equals the file name.

| Workflow | Athens time | Talk room (profile) | Source | LLM |
| --- | --- | --- | --- | --- |
| Hermes digest – morning-digest | 08:00 | nextcloud | Nextcloud MCP `http://nextcloud-mcp:8000/mcp`: `nc_calendar_list_events` (`personal`, today) and `nc_calendar_search_todos` (all live task lists) | no |
| Hermes digest – payments-unpaid | 08:00 | finance | Firefly III `GET /api/v1/bills?start=<1st of month>&end=<today>`: active bills with more pay dates up to today than `paid_dates` | no |
| Hermes digest – ai-news | 08:02 | ai-news | Reddit Atom feed `r/LocalLLaMA/top/.rss?t=day`, last 24 h, up to 10 posts | one call: "why it matters" per post |
| Hermes digest – selfhosted | 08:06 | selfhosted | Reddit Atom feed `r/selfhosted+homelab/top/.rss?t=day`, last 24 h, up to 5 per subreddit | one call: one line per post |
| Hermes digest – hf-models | 08:10 | hf-models | Hugging Face API, top 50 trending `text-generation` and `gguf`; created today/yesterday and GGUF or >100 downloads; no image/audio/video | no |
| Hermes digest – llamacpp-vulkan | 08:14 | llamacpp-vulkan | GitHub search: issues/PRs updated and commits since yesterday mentioning Vulkan; merged PRs first | one call: change summary per item |
| Hermes digest – llamacpp-rocm | 08:18 | llamacpp-rocm | GitHub search for rocm/hip/hipblas/rocwmma; RDNA3/gfx1100/flash-attention first; merged PRs marked | one call |
| Hermes digest – calories-report | 22:00 | calories | wger MCP `http://wger-mcp:8765/mcp`, `nutrition_summary` for today | no |

Reddit, GitHub, and Hugging Face get a descriptive User-Agent.

The LLM jobs are staggered so only one model call runs at a time. The call goes to `http://llama-server:8080/v1/chat/completions` with model `qwen-3.6-35b-a3b` (a thinking model), temperature 0.2, bounded `max_tokens`, and no tools. Only `choices[0].message.content` is used; the reply is reduced to `<n>. <text>` lines for known item numbers (links, Markdown, and reasoning-looking lines are dropped). If the call fails or fewer than half of the items get a usable line, the message is built from the template alone (Reddit falls back to the post's first sentence).


Entry points of every digest:

- Schedule trigger: delivers.
- Manual trigger in the editor: dry run. The composed message is the output of the `Result` node; nothing is posted.
- `Called by workflow` (Execute Workflow): dry run unless the input has `"dry_run": false`. Optional `"use_llm": false` and `"date": "YYYY-MM-DD"` (replaces today's date for testing).

Each workflow is its own error workflow: when a scheduled run fails (including a failed fetch that would otherwise look like "nothing new"), the `On failure` path posts one line to the room naming the node and the error. Partial failures (one of two searches) are noted in the message footer.

### Credentials

No secret is stored in the workflow files or passed to n8n as an environment variable (`N8N_BLOCK_ENV_ACCESS_IN_NODE` stays at its default). `scripts/hermes-digests-setup.sh` reads the secrets from the other stacks' ignored `.env` files and imports n8n credentials with fixed ids that the workflows reference:

| Credential | Type | Source |
| --- | --- | --- |
| Hermes digest – Talk room `<profile>` (9) | Custom Auth: `Authorization: Bearer <TALK_DELIVER_SECRET>` plus `room_token` merged into the JSON body | `hermes-nextcloud-bridge/.env` (`TALK_DELIVER_SECRET`, `NEXTCLOUD_TALK_PROFILE_ROOMS`) |
| Hermes digest – llama.cpp API key | Header Auth | `llama-cpp/.env` `LLAMA_API_KEY` |
| llama.cpp (local, OpenAI-compatible) | OpenAI | `llama-cpp/.env` `LLAMA_API_KEY`, base URL `http://llama-server:8080/v1`; use it in the OpenAI Chat Model and AI Agent nodes with any router model name (for example `qwen-3.6-35b-a3b`) |
| Hermes digest – Firefly III token | Header Auth | `firefly-iii/.env` `FIREFLY_III_ACCESS_TOKEN` |
| Hermes digest – wger MCP token | Header Auth | `wger/.env` `MCP_STATIC_TOKEN` |

Run it after changing a workflow file or one of those secrets (re-imports the credentials and the nine workflows, publishes them, and restarts n8n):

```bash
sh n8n/scripts/hermes-digests-setup.sh               # credentials + workflows + publish + restart
sh n8n/scripts/hermes-digests-setup.sh --credentials-only
```

The script uses the n8n CLI (`import:credentials`, `import:workflow`, `publish:workflow`), not the public API. Changing a room in `NEXTCLOUD_TALK_PROFILE_ROOMS` only needs `--credentials-only`.

The n8n container joins `hermes-mcp` to reach `nextcloud-mcp` and `wger-mcp`; the bridge, llama-server, and Firefly are reached on `webgateway`.

## Workflow drift check

`scripts/check-workflow-drift.sh` alerts when a live workflow no longer matches git. Anyone with access to the n8n UI or API can edit workflows, and so can the n8n MCP server, which a prompt-injected Hermes `n8n` profile could drive. A changed digest could send data elsewhere or post something else to Talk. The script reads every workflow through the n8n public REST API (`GET /api/v1/workflows`, header `X-N8N-API-KEY`) with a key that has only the `workflow:list` and `workflow:read` scopes. The list returns the saved draft (top-level nodes, connections, settings) and, for active workflows, the published version that runs (`activeVersion`). It normalises both with `jq` and compares them with `workflows/*.json` in the working tree. The comparison covers the name, the nodes (type, version, parameters, credential ids, retry and error settings), the connections and the settings. Node positions, node ids, notes, sticky notes, pinData, staticData, tags and version ids are ignored. It also reports live workflows that have no file in git (archived ones are skipped) and Hermes digests that are not active, since `hermes-digests-setup.sh` publishes them. The expected state of the other workflows is unknown, so it is not checked.

API limitation: `activeVersion` has nodes and connections but no settings, so the published version's settings cannot be compared on their own. The draft settings are used for both comparisons, and a settings change still shows as "draft differs".

It writes `node-exporter/textfile/n8n_drift.prom`, which the node-exporter textfile collector serves. The metrics are `n8n_workflow_drift{workflow}`, `n8n_workflow_untracked`, `n8n_workflow_untracked_info{workflow,name}`, `n8n_workflow_active_mismatch{workflow}`, `n8n_workflow_drift_check_success` and `n8n_workflow_drift_check_timestamp_seconds`. The Grafana rules in `grafana/provisioning/alerting/n8n-drift-rules.yml` (group "Integrity") alert in Talk when a workflow drifts, is untracked or is inactive. The runner sets `N8N_DRIFT_AUTO_EXPORT=1`: a drifted draft is exported over its file (metric `n8n_workflow_exported`), and the Talk alert says so; review with `git diff n8n/workflows` before committing, because an unwanted edit (for example from the n8n MCP server) would land in the file the same way.

There is no cron. The rule "n8n drift check not running" is the scheduler: when the metrics are older than 30 minutes, report a failed read or are missing, Grafana posts to the `n8n-drift-runner` stack (see `../n8n-drift-runner/`), which runs the script. The alert routes only to that webhook (never Talk) and repeats every 30 minutes while it stays firing, so a check runs roughly every 30 to 40 minutes. Setup:

1. In n8n: Settings > n8n API > Create an API key, with only the scopes `workflow:list` and `workflow:read`. Put it in `n8n-drift-runner/.env` as `N8N_DRIFT_API_KEY` (not the full-access `N8N_API_KEY` of the MCP server).
2. Put the same random secret in `n8n-drift-runner/.env` and `grafana/.env` as `N8N_DRIFT_WEBHOOK_SECRET` (`openssl rand -hex 32`).
3. Start the runner (it creates the internal `n8n-drift` network), then recreate n8n and Grafana with the `docker-compose.n8n-drift.yml` overrides so both join it:

```bash
docker compose --env-file n8n-drift-runner/.env -f n8n-drift-runner/docker-compose.yml up -d --build
docker compose --env-file n8n/.env -f n8n/docker-compose.yml -f n8n/docker-compose.n8n-drift.yml up -d
docker compose --env-file grafana/.env -f grafana/docker-compose.yml -f grafana/docker-compose.self-heal.yml -f grafana/docker-compose.n8n-drift.yml up -d
```

Run it by hand for a summary, and use `--diff <id>` for the normalised diff from git to live (the id or file name, for example `hermes-digest-ai-news`). The runner container has the key and the mounts:

```bash
docker exec n8n-drift-runner /app/check-workflow-drift.sh
docker exec n8n-drift-runner /app/check-workflow-drift.sh --diff hermes-digest-ai-news
docker logs n8n-drift-runner
```

To fix a drift, either restore the git versions with `sh n8n/scripts/hermes-digests-setup.sh` (this re-imports and publishes only the Hermes digests; import the other workflows with `n8n import:workflow` by hand), or, if the live change was intended, export the workflow into its file and commit it. The comparison uses the working tree, so a file edited but not yet imported also counts as drift.

## Backup and important notes

Back up `.env`, `data`, and a consistent copy or dump of `postgres`.
