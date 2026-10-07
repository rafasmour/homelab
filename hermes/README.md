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
- The Nextcloud, n8n, and draw.io MCP services attached to `hermes-mcp`

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
