# Hermes

Docker Compose deployment for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) OpenAI-compatible API, its specialist profiles, and their nightly cron jobs.

- API: `https://hermes.<DOMAIN>` (port 8642 inside the container), one route per profile under `/p/<profile>/v1`
- Inference: the `llama-cpp:8080` OpenAI-compatible router on `webgateway`
- Model: `HERMES_MODEL` (default `mellum-2.1-12b-a2.5b`) for chat, Kanban workers, and every cron job
- Time zone: `HERMES_TIMEZONE` (default `Europe/Athens`) for the Hermes clock and the cron scheduler
- Nextcloud Talk: through [hermes-nextcloud-bridge](../hermes-nextcloud-bridge/README.md)
- Tool and MCP call deadlines: 3600 seconds

## Requirements

- Docker Engine with Docker Compose, the external `webgateway` network, and Traefik
- A `llama-cpp` container reachable as `llama-cpp:8080` on `webgateway`, serving the `HERMES_MODEL` alias
- The Nextcloud, n8n, draw.io, wger, and web-search MCP services on `hermes-mcp` (this stack creates that network)
- `hermes-nextcloud-bridge` for Talk delivery

## Configure and start

Copy the environment template only if a local `.env` does not already exist, then replace every `CHANGE_ME`:

```bash
cp .env.example .env
```

- `API_SERVER_KEY`: at least 16 characters (`openssl rand -hex 32`); clients send it as the Bearer token on every route, including `/p/<profile>/v1`.
- `WEB_SEARCH_MCP_TOKEN`, `N8N_MCP_AUTH_TOKEN`, `MCP_STATIC_TOKEN`: the same values as `web-search/.env`, `n8n/.env`, and `wger/.env`.
- `NEXTCLOUD_TALK_DELIVER_SECRET` and `NEXTCLOUD_TALK_HOME_ROOM`: the same values as `TALK_DELIVER_SECRET` and `NEXTCLOUD_TALK_HOME_ROOM` in `hermes-nextcloud-bridge/.env`.

```bash
docker compose up -d
docker compose logs -f api
```

Start Hermes before the Nextcloud, n8n, wger, and web-search stacks, which reference `hermes-mcp` as external. Recreate `hermes-api` after those MCP services are healthy.

## What start.sh manages on every start

`start.sh` runs before the gateway and rewrites the managed state in the `hermes-data` volume, so changes to the script reach the live profiles on the next restart:

- Creates any missing profile: `nextcloud`, `finance`, `ai-news`, `hf-models`, `llamacpp-vulkan`, `gpu-watch`, `selfhosted`, `calories`. The legacy `router` and `digest` profiles stay on the volume but are no longer configured, served, or ticked.
- Writes each profile's model (`HERMES_MODEL`, provider `custom`, `chat_completions`, context 262144), `timezone`, timeouts, MCP servers, toolsets, and plugins. MCP Bearer tokens are read from the environment inside the script and never passed on a command line.
- Rewrites every `SOUL.md` it owns. The file starts with a `<!-- managed by start.sh ... -->` marker; everything under a `## Local notes` heading in the live file is kept.
- Installs two Hermes user plugins into every profile home:
  - `talk_send` (tracked in `hermes/plugins/talk_send`, mounted read-only): the agent tool that posts to the Talk home room.
  - `nextcloud_talk-platform`, the bridge repository's cron delivery platform, downloaded at the pinned bridge commit and verified by SHA-256 (cached under `plugin-src/` in the volume).
- Writes `API_SERVER_KEY` into each specialist's `<profile>/.env`. Under multiplexing a `/p/<profile>/` request is authenticated against that profile's own secrets and fails closed without a key.
- Creates or updates the eight cron jobs (below).
- Disables the old Forage plugin.

`/opt/hermes` is not writable by the `hermes` user, so the plugins live in the profile homes and are enabled through `plugins.enabled`.

## The core rule: work through the MCP tools

Every SOUL starts with the same rule. A task is done only when the matching tool returned success in that run: calendar events with `mcp__nextcloud__nc_calendar_create_event`, to-dos and reminders with `mcp__nextcloud__nc_calendar_create_todo`, notes with `mcp__nextcloud__nc_notes_create_note`, food with `mcp__wger__search_ingredients` then `mcp__wger__log_ingredient`, research with `mcp__web_search__web_search` and `mcp__web_search__fetch_url`, and Talk notifications with `talk_send`. The rule is also enforced by configuration: every profile disables `memory`, `todo`, `session_search`, `cronjob` (which carries the cron notepad), `messaging`, the shell, files, the browser, the built-in web toolset, skills, and delegation. Kanban workers may call `kanban_complete` only with the created object's id (event UID, todo UID, wger log id); otherwise they call `kanban_block`.

## Profiles

All profiles use `HERMES_MODEL`. Each platform toolset list names only `kanban`, `clarify`, `talk`, and that profile's MCP servers; naming MCP servers makes the list an allowlist. `cron` never gets `clarify` (Hermes removes it for cron runs).

| Profile | MCP servers in its toolsets | cli and api_server | cron | Role |
| --- | --- | --- | --- | --- |
| default | nextcloud, wger, web_search | kanban, nextcloud, wger, web_search, talk, clarify | nextcloud, wger, web_search, talk | Personal assistant for Open WebUI and Talk |
| nextcloud | nextcloud, web_search | kanban, nextcloud, web_search, talk, clarify | nextcloud, web_search, talk | Calendars, to-dos, notes, files; `morning-digest` |
| finance | nextcloud, n8n | kanban, nextcloud, n8n, talk, clarify | nextcloud, n8n, talk | Payments calendar versus Firefly; `payments-unpaid` |
| ai-news | web_search | kanban, web_search, talk, clarify | web_search, talk | r/LocalLLaMA; `ai-news` |
| hf-models | web_search | kanban, web_search, talk, clarify | web_search, talk | New Hugging Face text models; `hf-models` |
| llamacpp-vulkan | web_search | kanban, web_search, talk, clarify | web_search, talk | llama.cpp Vulkan changes; `llamacpp-vulkan` |
| gpu-watch | web_search | kanban, web_search, talk, clarify | web_search, talk | Greek GPU prices; `gpu-watch` |
| selfhosted | web_search | kanban, web_search, talk, clarify | web_search, talk | r/selfhosted and r/homelab; `selfhosted` |
| calories | wger, nextcloud, web_search | kanban, wger, nextcloud, web_search, talk, clarify | wger, nextcloud, talk | Food log; `calories-report` |

The default profile also has the n8n and draw.io MCP servers registered, but they are not in its toolset lists.

### The default profile is the assistant

The default profile treats every message as a task. It classifies the message (food, appointment, to-do, workout, question, or long specialist work), asks one short follow-up for whatever is missing (food: what, amount, meal, time; events: title, date, time, duration; to-dos: title and due), then calls the tool itself and replies with the created object's id. A workout becomes a completed to-do, because the wger MCP has no workout logging. Long specialist work (news, models, GPU prices, payments) is still filed as a Kanban card; a card for the `nextcloud` profile must carry the full structured request (title, date and time with time zone, duration, calendar URI, VEVENT or VTODO). The calendar URIs come from [nextcloud/README.md](../nextcloud/README.md#calendars-and-tasks).

### Sending to Nextcloud Talk

Agents send Talk messages with the `talk_send` tool (toolset `talk`). It takes one argument, `message`, and posts it to `NEXTCLOUD_TALK_HOME_ROOM` as the Hermes bot through the bridge's `/deliver` endpoint. The URL, secret, and room come from the container environment and are not visible to the model. Hermes' own `send_message` tool is not registered as an agent tool in this release, and `mcp__nextcloud__talk_send_message` posts as the Nextcloud user without a notification, so the SOULs point the model at `talk_send`.

The gateway connects the `nextcloud_talk` platform on every profile (it has no inbound side) and does not post restart notices into the room (`platforms.nextcloud_talk.gateway_restart_notification: false`).

## OpenAI-compatible API per profile

`gateway.multiplex_profiles` is on, so the default gateway serves every profile in `gateway.multiplex_profile_allowlist` on one listener. Specialists keep `platforms.api_server.enabled: false`; the multiplexer refuses to start if a secondary profile enables a port-binding platform.

| Profile | Base URL inside Docker | `/v1/models` id |
| --- | --- | --- |
| default | `http://hermes-api:8642/v1` or `http://hermes-api:8642/p/default/v1` | `hermes-agent` (`API_SERVER_MODEL_NAME`) |
| any specialist | `http://hermes-api:8642/p/<profile>/v1` | the profile name, for example `nextcloud` |

The public equivalents are `https://hermes.<DOMAIN>/v1` and `https://hermes.<DOMAIN>/p/<profile>/v1`. Hermes 0.20.5 derives a specialist's advertised model id from the profile name and has no setting to rename it; use the client's prefix option (for example Open WebUI `prefix_id`) for names such as `hermes-<profile>`. The requested model name does not change the inference model: every profile runs `HERMES_MODEL`.

## Cron jobs

`hermes_time` and the cron scheduler use `HERMES_TIMEZONE`, so the expressions are Athens wall-clock times and follow the EEST/EET change automatically. Every job uses `HERMES_MODEL` (provider `custom`), has no `--continuity`, and delivers its final response to the Talk home room with `--deliver nextcloud_talk`. The prompts name the exact MCP tools and forbid the shell, files, memory, the cron notepad, and Kanban. `start.sh` creates a missing job and edits an existing one with `hermes cron edit` when its prompt, schedule, delivery, model, or continuity differ.

| Job | Profile | Athens time | Cron | Tools | Output |
| --- | --- | --- | --- | --- | --- |
| ai-news | ai-news | 01:00 | `0 1 * * *` | web_search, fetch_url | Top r/LocalLLaMA posts of the day |
| hf-models | hf-models | 01:30 | `30 1 * * *` | fetch_url (Hugging Face API) | New text models with a GGUF or more than 100 downloads |
| llamacpp-vulkan | llamacpp-vulkan | 02:00 | `0 2 * * *` | fetch_url (GitHub search API) | Vulkan pull requests and commits since yesterday |
| gpu-watch | gpu-watch | 02:30 | `30 2 * * *` | fetch_url, web_search | Lowest in-stock price per watched GPU; `ALERT` under `target_price` |
| selfhosted | selfhosted | 03:00 | `0 3 * * *` | fetch_url, web_search | Top r/selfhosted and r/homelab posts |
| payments-unpaid | finance | 03:30 | `30 3 * * *` | Nextcloud, n8n | Payments events due today without a Firefly match |
| morning-digest | nextcloud | 07:00 | `0 7 * * *` | Nextcloud | Today's events, open to-dos, pointer to the night digests |
| calories-report | calories | 22:00 | `0 22 * * *` | wger, Nextcloud | Day totals, plus a `Calories <date>` to-do due 22:00 on `tasks` |

The night jobs no longer store digests in a cron notepad for a morning publisher; each posts its own short digest to Talk. Without continuity, a job only removes duplicates within the run and limits itself to the last 24 hours.

GPU watch: `start.sh` reads `/home/hermes/.hermes/gpu-watchlist.yml` and embeds its products (and optional `target_price`) in the job prompt. When the live file is missing or has no products, it is seeded from the tracked `gpu-watchlist.example.yml`. Edit the live file and restart `hermes-api` to change the list.

List jobs per profile (`hermes cron` without `-p` is the default profile, which has no jobs):

```bash
docker exec hermes-api hermes -p ai-news cron list
```

Force a run on the next scheduler tick (this occupies the local model):

```bash
docker exec hermes-api hermes -p <profile> cron run <job-id>
```

Outputs are written to `profiles/<profile>/cron/output/<job-id>/` in the volume.

## Operations and troubleshooting

If Kanban cards stay in `ready` and gateway logs say another gateway holds the dispatcher lock, an orphaned `kanban/.dispatcher.lock` can block dispatch after an unclean restart; API startup removes that file when it is not held by a live `fcntl` lock.

`hermes -p <profile> cron list` warns that the gateway is not running. That is expected: the default gateway ticks every profile store.

## Storage and backups

Back up these Docker volumes:

- `hermes-data`: configuration, SOULs, sessions, Kanban, cron jobs and outputs, and the profile `.env` files
- `hermes-agent-src`: agent source mounted at `/opt/hermes`

When upgrading the Hermes Agent image, recreate `hermes-agent-src` so it is seeded from the new image, and rebuild `hermes-nextcloud-bridge` with the same `HERMES_AGENT_VERSION`:

```bash
docker compose down
docker volume rm hermes_hermes-agent-src
docker compose pull
docker compose up -d
```

Confirm the project-prefixed volume name with `docker volume ls` before removing it.

## Architecture and security

The API uses the internal `backend` network, `hermes-mcp`, and `webgateway`. No host ports are published. Traefik routes `Host(hermes.<DOMAIN>)` to port 8642, including the `/p/<profile>/` routes, all behind `API_SERVER_KEY`. Tools run inside the API container, but the shell, file, and code-execution toolsets are disabled on every profile.

## Validation

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose ps
docker exec hermes-api sh -c 'curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/p/nextcloud/v1/models'
docker exec hermes-api hermes -p calories config get model.default
```

## Upstream documentation

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [nextcloud-talk-hermes-bridge](https://github.com/robertlmann02/nextcloud-talk-hermes-bridge)
