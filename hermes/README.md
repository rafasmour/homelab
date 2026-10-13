# Hermes

Docker Compose deployment for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) OpenAI-compatible API.

- API: `https://hermes.<DOMAIN>` (port 8642 inside the container)
- Inference: the existing `llama-cpp:8080` OpenAI-compatible service on `webgateway`
- Web search: the web-search MCP at `http://web-search-mcp:8000/mcp` on `hermes-mcp` and `webgateway`
- Tool and MCP call deadlines: 3600 seconds (one hour) on the default profile and on each specialist

## Requirements

- Docker Engine with Docker Compose
- The external `webgateway` Docker network and Traefik
- A `llama-cpp` container reachable as `llama-cpp:8080` on `webgateway`
- The web-search MCP reachable as `web-search-mcp:8000` on `hermes-mcp`
- The Compose-managed `hermes-mcp` Docker network
- The Nextcloud, n8n, draw.io, wger, and web-search MCP services attached to `hermes-mcp`

## Configure and start

Copy the environment template only if a local `.env` does not already exist:

```bash
cp .env.example .env
```

Replace all `CHANGE_ME` values. `API_SERVER_KEY` must contain at least 16 characters and is the key clients send to the public API. `WEB_SEARCH_MCP_TOKEN` must match the value in `web-search/.env`.

The Hermes stack creates the shared `hermes-mcp` network automatically. Start Hermes before the Nextcloud and n8n MCP services, which reference this network as external. Set `N8N_MCP_AUTH_TOKEN` to the same generated value used by `n8n/.env`:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d
docker compose logs -f api
```

The API startup script disables the old Forage plugin if it is still on the volume, registers the web-search MCP server, configures llama.cpp as Hermes' custom OpenAI-compatible inference provider, and then launches the gateway. The resulting `config.yaml` is stored in the persistent `hermes-data` volume. Regular container recreation therefore retains it, while a new empty volume is configured automatically.

At every API startup Hermes queries `${HERMES_INFERENCE_BASE_URL}/models`. When `HERMES_MODEL` is empty, it selects the first model returned by llama.cpp; this follows the order of the llama.cpp router catalog and automatically adapts when that catalog changes. Set `HERMES_MODEL` to a model ID from the catalog when a fixed default is preferable. Other discovered models remain available through Hermes' `/model custom:<model-id>` command.

The same startup sets `model.context_length` to `262144` on the default profile and on each specialist profile. That matches the llama.cpp router `ctx-size` and stops Hermes from capping requests below it. The selected model is unchanged.

The startup script also registers the private Nextcloud, n8n, draw.io, and web-search MCP endpoints on the default profile. Hermes discovers their tools automatically as `mcp_nextcloud_*`, `mcp_n8n_*`, `mcp_drawio_*`, and `mcp_web_search_*`. The Nextcloud credentials remain in `nextcloud/.env`; the shared n8n and web-search MCP Bearer tokens are passed into Hermes. Open WebUI's `hermes-agent` chat stays `kanban` plus `no_mcp`, so search runs on specialist profiles, not on the dispatcher.

The same startup creates a `nextcloud` profile when it is missing. That profile uses the same llama.cpp model and only the Nextcloud MCP server, with a soul limited to Nextcloud files, shares, notes, calendars, contacts, collectives, news, mail, and Talk. Its cron store holds `morning-digest`. Run `hermes -p nextcloud` inside the API container. Recreate the API after the MCP services are started so Compose applies the network and environment changes:

```bash
docker compose up -d api
docker compose exec api hermes mcp test nextcloud
docker compose exec api hermes mcp test n8n
docker compose exec api hermes mcp test drawio
docker compose exec api hermes mcp test web_search
docker compose exec api hermes -p nextcloud mcp test nextcloud
```

`WEB_SEARCH_MCP_TOKEN` must match `web-search/.env`. Existing cron job prompts that still mention Forage keep that wording until those jobs are recreated. New jobs use `mcp_web_search_web_search`.

## Specialist profiles

Open WebUI's `hermes-agent` model is the default profile, and that chat is only a dispatcher. Its API toolset is `kanban` plus `no_mcp`, so it cannot call Nextcloud, n8n, draw.io, wger, or the shell. It files one Kanban card and names the specialist. The gateway dispatcher spawns that profile. `kanban.max_in_progress` and `kanban.max_spawn` are 4, so up to four specialist runs can be in flight at once; only one local llama.cpp model can actually infer, so extra workers queue on the GPU. `delegate_task` is not used: that would run the dispatcher and the specialist at the same time.

Nightly jobs run on the specialist profiles below. `hermes cron` has no `--profile` flag: a job is stored in the active profile home, so create and list them with `hermes -p <profile> cron`. The default gateway is the only one that stays up. `gateway.multiplex_profiles` is true, so that gateway ticks every profile cron store and runs each job with that profile's SOUL, MCP servers, and model. Specialist gateways stay stopped (`s6-svc -d`); only one local llama.cpp model can run. Open WebUI's `hermes-agent` stays the default dispatcher (`kanban` plus `no_mcp`). A new Open WebUI chat picks up the dispatcher tools; an existing chat keeps the tool list it opened with.

Chat profiles are selected with `hermes -p <name>` inside the API container. Each specialist profile carries the same instructions in `SOUL.md`. Specialists must verify that the report target exists via an MCP or notepad read before claiming success or completing a Kanban card.

Every profile below uses the same llama.cpp model as `nextcloud`: `gemma-4-12b-it-qat` via `http://llama-cpp:8080/v1` in `chat_completions` mode. They were created with `--no-skills`.

| Profile | MCP | Web search | Role |
| --- | --- | --- | --- |
| nextcloud | Nextcloud | none | Nextcloud files and calendars; cron job `morning-digest` |
| finance | Nextcloud, n8n | none | Payments calendar; cron job `payments-unpaid` |
| ai-news | web-search | web-search MCP | Hot posts from r/LocalLLaMA; cron job `ai-news` |
| hf-models | web-search | web-search MCP | New Hugging Face text models with a GGUF or more than 100 downloads in 24 hours; cron job `hf-models` |
| llamacpp-vulkan | web-search | web-search MCP | `ggml-org/llama.cpp` commits and pull requests that mention Vulkan; cron job `llamacpp-vulkan` |
| gpu-watch | web-search | web-search MCP | Greek GPU prices from the watchlist; cron job `gpu-watch` |
| selfhosted | web-search | web-search MCP | Top posts from r/selfhosted and r/homelab; cron job `selfhosted` |
| calories | wger, Nextcloud, web-search | web-search MCP | Log foods; cron job `calories-report` reads wger and creates a Nextcloud task |

`finance` has no web-search MCP entry. Specialist souls that still mention Forage are rewritten on API start.

The wger MCP server is `http://wger-mcp:8765/mcp`. Its `Authorization` header is `Bearer` plus `MCP_STATIC_TOKEN` from `wger/.env`, expanded into the Hermes config. It is registered on the default profile and on `calories`. `calories` also has the Nextcloud MCP server, because the 22:00 `calories-report` job runs on that profile and creates a Nextcloud task. `hermes mcp test wger` discovers the nutrition tools, including `log_ingredient` (`plan_id`, `ingredient_id`, `amount_g`, optional `when`, `meal_id`, `weight_unit_id`) and `nutrition_summary` (the day's kcal and macros). `WGER_API_KEY` may still be a placeholder. Diary calls stay unauthorized until a real key is set and only `wger-mcp` is recreated.

`start.sh` creates these profiles, the wger and calories Nextcloud MCP entries, the web-search MCP entries, the GPU watchlist, and each profile's cron job when it is missing. A job that still lives in the default store is moved, with its notepad rows, into the profile store. An existing profile, MCP entry, or cron name is left in place, so a later API start does not duplicate the jobs already on this volume. Specialist `platforms.api_server.enabled` and `gateway.enabled` stay false so multiplex does not try to bind a second API port.

## Nightly schedule

The container clock is UTC. `hermes cron` has no timezone flag, so these jobs are stored in UTC. The intended wall times are Europe/Athens during EEST, a fixed offset of UTC+3. Each expression is that EEST time minus 3 hours. This is not a zoneinfo DST calendar: the expressions stay on UTC+3 and are not switched to EET (UTC+2) in winter. The Hermes container stays on UTC. Jobs at 01:00–02:30 EEST run on the previous UTC date. Each prompt says the intended wall time is Athens/EEST, and "today" means that EEST calendar date.

| Job | Profile | EEST (UTC+3) | UTC cron | Behavior |
| --- | --- | --- | --- | --- |
| ai-news | ai-news | 01:00 | `0 22 * * *` | r/LocalLLaMA hot posts, `--continuity` |
| hf-models | hf-models | 01:30 | `30 22 * * *` | New Hugging Face text models, `--continuity` |
| llamacpp-vulkan | llamacpp-vulkan | 02:00 | `0 23 * * *` | llama.cpp Vulkan commits and pull requests, `--continuity` |
| gpu-watch | gpu-watch | 02:30 | `30 23 * * *` | Greek GPU prices, `--continuity` |
| selfhosted | selfhosted | 03:00 | `0 0 * * *` | r/selfhosted and r/homelab, `--continuity` |
| payments-unpaid | finance | 03:30 | `30 0 * * *` | Payments events due today with no matching Firefly transaction in the current Athens month |
| morning-digest | nextcloud | 07:00 | `0 4 * * *` | Read the other profiles' notepads and create Nextcloud tasks due at 07:00 Athens |
| calories-report | calories | 22:00 | `0 19 * * *` | wger `nutrition_summary` as a Nextcloud task due at 22:00 Athens |

The 00:30 EEST Firefly subscription sync is an n8n workflow, not a Hermes cron.

The night jobs store their text in that profile's cron notepad (`hermes cron notepad <id> set digest ...` while the job is running in its own profile home). They leave Nextcloud tasks and Talk alone. Delivery is `local`. `--continuity` is on for the five scrape jobs, stored as `context_from: [self]`, so each run can drop items already reported. `payments-unpaid` replaces the full unpaid list every run and does not use `--continuity`, so an item that is still unpaid stays in the notepad. The 07:00 job, on `nextcloud`, reads the other profiles with `hermes -p <profile> cron list` and `hermes -p <profile> cron notepad <id> get digest`, then turns each non-empty digest into a Nextcloud task due at 07:00 Athens (EEST). After the task exists it sets that profile's digest to `published`. Talk is not used, because a Talk message sent as the same user does not notify you.

GPU watch stays silent until product names exist. The tracked template `hermes/gpu-watchlist.example.yml` is empty of real product names. The job reads `/home/hermes/.hermes/gpu-watchlist.yml` inside `hermes-api`. On a fresh volume the startup script copies the mounted example to that path when the file is missing. Add product names in the live file. The tracked example stays empty. Shops are skroutz.gr, public.gr, and plaisio.gr, plus the web-search MCP / SearXNG for other Greek shops such as kotsovolos.gr and bestprice.gr. The job alerts when today's lowest in-stock price is below the last price stored in that job's notepad. Optional `target_price` on a product alerts only under that price. The first observation is stored and does not alert.

List the jobs with:

```bash
docker exec hermes-api hermes -p ai-news cron list
docker exec hermes-api hermes -p finance cron list
docker exec hermes-api hermes -p nextcloud cron list
docker exec hermes-api hermes -p calories cron list
```

`hermes cron list` without `-p` is the default profile. These eight jobs are not stored there.

Leave the jobs for the scheduler. Running one now would occupy the local llama.cpp model.

## Operations and troubleshooting

If Kanban cards stay in `ready` and gateway logs say another gateway holds the dispatcher lock, an orphaned `kanban/.dispatcher.lock` can block dispatch after an unclean restart; API startup removes that file when it is empty or not held by a live `fcntl` lock (and the gateway is not running).

## Storage and backups

Back up these Docker volumes:

- `hermes-data`: configuration, sessions, memory, and skills
- `hermes-agent-src`: agent source mounted at `/opt/hermes` in the API container

When upgrading the Hermes Agent image, recreate `hermes-agent-src` so it is seeded from the new image. This does not remove `hermes-data`:

```bash
docker compose down
docker volume rm hermes_hermes-agent-src
docker compose pull
docker compose up -d
```

Confirm the actual project-prefixed volume name with `docker volume ls` before removing it.

## Architecture and security

The API uses the internal `backend` network, the shared `hermes-mcp` network, and `webgateway`. `webgateway` reaches Traefik, the existing llama.cpp service, and the web-search MCP. No host ports are published. Traefik routes `Host(hermes.<DOMAIN>)` to container port 8642.

Tools launched from the API run inside the API container.

## Validation

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose ps
docker compose exec api hermes plugins list
curl -fsS https://hermes.example.com/health
```

Replace the example hostname with the configured domain.

## Upstream documentation

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
