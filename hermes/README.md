# Hermes

Docker Compose deployment for [Hermes Agent](https://github.com/NousResearch/hermes-agent) using [Hermes WebUI](https://github.com/nesquena/hermes-webui) as its browser frontend.

- WebUI: `https://hermes.<DOMAIN>`
- OpenAI-compatible API: `https://hermes.<DOMAIN>/v1`
- Inference: the existing `llama-cpp:8080` OpenAI-compatible service on `webgateway`
- Web search: the Forage API at `http://forage:3672` on `webgateway`

## Requirements

- Docker Engine with Docker Compose
- The external `webgateway` Docker network and Traefik
- A `llama-cpp` container reachable as `llama-cpp:8080` on `webgateway`
- The Forage stack reachable as `forage:3672` on `webgateway`
- The Compose-managed `hermes-mcp` Docker network
- The Nextcloud, n8n, draw.io, and wger MCP services attached to `hermes-mcp`

## Configure and start

Copy the environment template only if a local `.env` does not already exist:

```bash
cp .env.example .env
```

Replace all `CHANGE_ME` values. `API_SERVER_KEY` must contain at least 16 characters. `FORAGE_API_KEY` must match the value in `forage/.env`. The WebUI password is mandatory because this deployment routes the command-capable interface through Traefik.

The Hermes stack creates the shared `hermes-mcp` network automatically. Start Hermes before the Nextcloud and n8n MCP services, which reference this network as external. Set `N8N_MCP_AUTH_TOKEN` to the same generated value used by `n8n/.env`:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d
docker compose logs -f webui api
```

The WebUI uses application-level password authentication. There is no separate administrator account: enter `HERMES_WEBUI_PASSWORD` when first opening the site.

The API startup script automatically installs and enables the upstream `web/forage` plugin when it is missing, sets both `web.search_backend` and `web.extract_backend` to `forage`, configures llama.cpp as Hermes' custom OpenAI-compatible inference provider, and then launches the gateway. The plugin and resulting `config.yaml` are stored in the persistent `hermes-data` volume. Regular container recreation therefore retains them, while a new empty volume is configured automatically.

At every API startup Hermes queries `${HERMES_INFERENCE_BASE_URL}/models`. When `HERMES_MODEL` is empty, it selects the first model returned by llama.cpp; this follows the order of the llama.cpp router catalog and automatically adapts when that catalog changes. Set `HERMES_MODEL` to a model ID from the catalog when a fixed default is preferable. Other discovered models remain available through Hermes' `/model custom:<model-id>` command.

The startup script also registers the private Nextcloud, n8n, and draw.io MCP endpoints on the default profile. Hermes discovers their tools automatically as `mcp_nextcloud_*`, `mcp_n8n_*`, and `mcp_drawio_*`. The Nextcloud credentials remain in `nextcloud/.env`; only the shared n8n MCP Bearer token is passed into Hermes.

The same startup creates a `nextcloud` profile when it is missing. That profile uses the same llama.cpp model and only the Nextcloud MCP server, with a soul limited to Nextcloud files, shares, notes, calendars, contacts, collectives, news, mail, and Talk. Select it from the WebUI profile switcher, or run `hermes -p nextcloud` inside the API container. Recreate the API after the MCP services are started so Compose applies the network and environment changes:

```bash
docker compose up -d api
docker compose exec api hermes mcp test nextcloud
docker compose exec api hermes mcp test n8n
docker compose exec api hermes mcp test drawio
docker compose exec api hermes -p nextcloud mcp test nextcloud
```

`FORAGE_URL` remains `http://forage:3672`, the internal address on `webgateway`. Set `FORAGE_PLUGIN_REF` to a full commit SHA to pin the downloaded plugin. The Hermes Compose stack does not define a separate Forage service or installer container.

## Specialist profiles

Chat profiles are selected with `hermes -p <name>` inside the API container. The running gateway stays on the default profile. `hermes cron` has no profile flag, so the nightly jobs are created on the default profile with self-contained prompts. Each specialist profile carries the same instructions in `SOUL.md`.

Every profile below uses the same llama.cpp model as `nextcloud`: `gemma-4-12b-it-qat` via `http://llama-cpp:8080/v1` in `chat_completions` mode. They were created with `--no-skills`.

| Profile | MCP | Web search | Role |
| --- | --- | --- | --- |
| finance | Nextcloud, n8n | none | Payments calendar and the unpaid check |
| ai-news | none | Forage | Hot posts from r/LocalLLaMA |
| hf-models | none | Forage | New Hugging Face text models with a GGUF or more than 100 downloads in 24 hours |
| llamacpp-vulkan | none | Forage | `ggml-org/llama.cpp` commits and pull requests that mention Vulkan |
| gpu-watch | none | Forage | Greek GPU prices from the watchlist |
| selfhosted | none | Forage | Top posts from r/selfhosted and r/homelab |
| calories | wger | Forage | Log foods; Forage when wger has no match |

Forage on those profiles is a symlink to the default profile's `plugins/web/forage` directory, so the plugin is not cloned again. `finance` has no Forage plugin.

The wger MCP server is `http://wger-mcp:8765/mcp`. Its `Authorization` header is `Bearer` plus `MCP_STATIC_TOKEN` from `wger/.env`, expanded into the Hermes config. It is registered on the default profile, for the 22:00 cron job, and on `calories`, for chat. That registration was a config write on the running container. The API was not restarted. `hermes mcp test wger` then discovered the nutrition tools, including `log_ingredient` (`plan_id`, `ingredient_id`, `amount_g`, optional `when`, `meal_id`, `weight_unit_id`) and `nutrition_summary` (the day's kcal and macros). `WGER_API_KEY` may still be a placeholder. Diary calls stay unauthorized until a real key is set and only `wger-mcp` is recreated.

## Nightly schedule

The container clock is UTC. `hermes cron` has no timezone flag, so these jobs are stored in UTC. The intended wall times are Europe/Athens during EEST, a fixed offset of UTC+3. Each expression is that EEST time minus 3 hours. This is not a zoneinfo DST calendar: the expressions stay on UTC+3 and are not switched to EET (UTC+2) in winter. The Hermes container stays on UTC. Jobs at 01:00–02:30 EEST run on the previous UTC date. Each prompt says the intended wall time is Athens/EEST, and "today" means that EEST calendar date.

| Job | EEST (UTC+3) | UTC cron | Behavior |
| --- | --- | --- | --- |
| ai-news | 01:00 | `0 22 * * *` | r/LocalLLaMA hot posts, `--continuity` |
| hf-models | 01:30 | `30 22 * * *` | New Hugging Face text models, `--continuity` |
| llamacpp-vulkan | 02:00 | `0 23 * * *` | llama.cpp Vulkan commits and pull requests, `--continuity` |
| gpu-watch | 02:30 | `30 23 * * *` | Greek GPU prices, `--continuity` |
| selfhosted | 03:00 | `0 0 * * *` | r/selfhosted and r/homelab, `--continuity` |
| payments-unpaid | 03:30 | `30 0 * * *` | Payments events due today with no matching Firefly transaction in the current Athens month |
| morning-digest | 07:00 | `0 4 * * *` | Read the night notepads and create Nextcloud tasks due at 07:00 Athens |
| calories-report | 22:00 | `0 19 * * *` | wger `nutrition_summary` as a Nextcloud task due at 22:00 Athens |

The 00:30 EEST Firefly subscription sync is an n8n workflow, not a Hermes cron.

The night jobs store their text in the cron notepad (`hermes cron notepad <id> set digest ...`). They leave Nextcloud tasks and Talk alone. Delivery is `local`. `--continuity` is on for the five scrape jobs, stored as `context_from: [self]`, so each run can drop items already reported. `payments-unpaid` replaces the full unpaid list every run and does not use `--continuity`, so an item that is still unpaid stays in the notepad. The 07:00 job turns each non-empty digest into a Nextcloud task due at 07:00 Athens (EEST). Talk is not used, because a Talk message sent as the same user does not notify you.

GPU watch stays silent until product names exist. The tracked template `hermes/gpu-watchlist.example.yml` is empty of real product names. The job reads `/home/hermes/.hermes/gpu-watchlist.yml` inside `hermes-api`. On a fresh volume the startup script copies the mounted example to that path when the file is missing. Add product names in the live file. The tracked example stays empty. Shops are skroutz.gr, public.gr, and plaisio.gr, plus Forage/SearXNG for other Greek shops such as kotsovolos.gr and bestprice.gr. The job alerts when today's lowest in-stock price is below the last price stored in that job's notepad. Optional `target_price` on a product alerts only under that price. The first observation is stored and does not alert.

List the jobs with:

```bash
docker exec hermes-api hermes cron list
```

Leave the jobs for the scheduler. Running one now would occupy the local llama.cpp model.

## Storage and backups

Back up these Docker volumes:

- `hermes-data`: configuration, sessions, memory, skills, and WebUI state
- `hermes-agent-src`: agent source consumed by the WebUI

The bind-mounted `./workspace` directory contains files created or edited through the WebUI and should also be backed up. It is runtime/user content and remains ignored by Git.

When upgrading the Hermes Agent image, recreate `hermes-agent-src` so it is seeded from the new image. This does not remove `hermes-data`:

```bash
docker compose down
docker volume rm hermes_hermes-agent-src
docker compose pull
docker compose up -d
```

Confirm the actual project-prefixed volume name with `docker volume ls` before removing it.

## Architecture and security

The API and WebUI share Hermes state and communicate on the internal `backend` network. They also use `webgateway` for the existing llama.cpp service and the internal Forage API; no host ports are published. HTTPS-aware cookies, allowed origins, and trusted Traefik forwarding headers are configured for the public URL.

Tools launched from the WebUI run inside the WebUI container, an upstream limitation of the multi-container layout. Its `/workspace` path maps to `./workspace` in this folder.

## Validation

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose ps
docker compose exec api hermes plugins list
curl -fsS https://hermes.example.com/health
```

Replace the example hostname with the configured domain.

## Upstream documentation

- [Hermes WebUI Docker guide](https://github.com/nesquena/hermes-webui/blob/master/docs/docker.md)
- [Hermes WebUI multi-container Compose](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.two-container.yml)
