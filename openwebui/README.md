# Open WebUI

Open WebUI provides a browser interface for the OpenAI-compatible APIs exposed
by [`llama-cpp`](../llama-cpp/README.md),
[`llama-cpp-classifier`](../llama-cpp-classifier/README.md), and every
[Hermes](../hermes/README.md) profile. It also connects to the MCP tool servers
on the `hermes-mcp` network and uses the web-search service for its built-in
web search. Traefik publishes it at `https://webui.<DOMAIN>`.

## Requirements

- Docker Engine with Docker Compose
- The external Docker networks `webgateway` and `hermes-mcp`
- `llama-server:8080` and `llama-classifier:8080` on `webgateway`
- The Hermes API at `hermes-api:8642` on `webgateway`
- The MCP servers on `hermes-mcp`: `web-search-mcp`, `nextcloud-mcp`,
  `wger-mcp`, `n8n-mcp`, and `drawio-mcp`
- Traefik configured to route `webui.<DOMAIN>`

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Creates the Traefik host rule `webui.<DOMAIN>` |
| `OPEN_WEBUI_IMAGE_TAG` | Open WebUI image tag; pin a release such as `v0.11.4` |
| `OPENAI_API_KEY` | Sent to the llama.cpp and classifier backends; any non-empty value |
| `HERMES_API_KEY` | Must match `hermes/.env` `API_SERVER_KEY`; used for every Hermes profile |
| `ENABLE_SIGNUP` | `false`; set `true` only while creating the first admin |
| `ENABLE_PERSISTENT_CONFIG` | `false` makes `docker-compose.yml` authoritative (see below) |
| `WEB_SEARCH_MCP_TOKEN` | Must match `web-search/.env` `WEB_SEARCH_MCP_TOKEN` |
| `WGER_MCP_TOKEN` | Must match `wger/.env` `MCP_STATIC_TOKEN` |
| `N8N_MCP_TOKEN` | Must match `n8n/.env` `N8N_MCP_AUTH_TOKEN` |

The MCP tokens are embedded in a JSON string. Use only letters, digits and
`-._~+/=`. Hex output from `openssl rand -hex 32` is safe.

## Authentication and the first admin

Login is always on (`WEBUI_AUTH=true`), and signup is off by default.

- **Empty database:** set `ENABLE_SIGNUP=true` in `.env` and run
  `docker compose up -d`. Register at `https://webui.<DOMAIN>`; the first
  account becomes the admin. Then set `ENABLE_SIGNUP=false` and run
  `docker compose up -d` again.
- **Database from the earlier no-login setup:** when login was disabled,
  Open WebUI created the admin `admin@localhost` with the password `admin`.
  Sign in with those credentials right away. Under **Settings > Account**,
  change the email and set a strong password.

Login must stay on. The Nextcloud MCP uses the Nextcloud admin app password,
the n8n MCP can run workflows, and the Hermes profiles can act on your
services. Anyone who can use the UI can reach all of these.

Tool servers have no access grants, so Open WebUI makes them admin-only. To
let other users call a tool server, grant access under
**Admin > Settings > Integrations**.

## Models

Open WebUI registers these OpenAI-compatible connections:

| Index | URL | Models shown as |
| --- | --- | --- |
| 0 | `http://llama-server:8080/v1` | the router's model ids (no prefix) |
| 1 | `http://llama-classifier:8080/v1` | the classifier's model ids (no prefix) |
| 2 | `http://hermes-api:8642/v1` | `hermes.hermes-agent` |
| 3-10 | `http://hermes-api:8642/p/<profile>/v1` | `hermes.<profile>` |

The Hermes specialist models are `hermes.nextcloud`, `hermes.finance`,
`hermes.calories`, `hermes.ai-news`, `hermes.hf-models`,
`hermes.llamacpp-vulkan`, `hermes.gpu-watch` and `hermes.selfhosted`.
`OPENAI_API_CONFIGS` gives each Hermes connection the prefix `hermes` and the
tag `hermes`. Open WebUI removes the prefix before it forwards a request. To
add a Hermes profile, add its URL to `OPENAI_API_BASE_URLS`, add
`HERMES_API_KEY` to `OPENAI_API_KEYS` at the same position, and add a matching
index entry to `OPENAI_API_CONFIGS`.

The chat UI uses `/v1/models` and `/v1/chat/completions`. The classifier's
native `POST /v1/systemone` endpoint is not used.

## MCP tool servers

`TOOL_SERVER_CONNECTIONS` registers these streamable-HTTP MCP servers over
`hermes-mcp`:

| ID | URL | Auth |
| --- | --- | --- |
| `web-search` | `http://web-search-mcp:8000/mcp` | Bearer `WEB_SEARCH_MCP_TOKEN` |
| `nextcloud` | `http://nextcloud-mcp:8000/mcp` | none |
| `wger` | `http://wger-mcp:8765/mcp` | Bearer `WGER_MCP_TOKEN` |
| `n8n` | `http://n8n-mcp:3000/mcp` | Bearer `N8N_MCP_TOKEN` |
| `drawio` | `http://drawio-mcp:8000/mcp` | none |

Direct llama.cpp chats can call these tools. The Hermes models use their own
tools inside Hermes.

## Built-in web search

The built-in web search uses the web-search service's REST endpoints:

- search: `WEB_SEARCH_ENGINE=external`, `EXTERNAL_WEB_SEARCH_URL=http://web-search-mcp:8000/search`
- page loading: `WEB_LOADER_ENGINE=external`, `EXTERNAL_WEB_LOADER_URL=http://web-search-mcp:8000/fetch`

Both send `WEB_SEARCH_MCP_TOKEN` as a bearer token.

## Persistent configuration

Open WebUI keeps most settings in the `config` table of `data/webui.db`. With
`ENABLE_PERSISTENT_CONFIG=true` (the upstream default), stored values override
environment variables. The connections, tool servers, web search and signup
settings in `docker-compose.yml` would then be ignored on a database that
already holds them.

This stack sets `ENABLE_PERSISTENT_CONFIG=false`, so `docker-compose.yml` is
the source of truth. Settings changed under **Admin > Settings** apply only
until the next restart; put lasting changes in `docker-compose.yml` or `.env`.
Accounts, chats, models' custom settings, knowledge, and tools are not affected.

If you set `ENABLE_PERSISTENT_CONFIG=true`, the values in the database take
over again. Settings saved before this change are still in the database.

## Start the service

Create the external networks once if they do not already exist:

```bash
docker network create webgateway
docker network create hermes-mcp
```

Validate and start:

```bash
docker compose config --quiet
docker compose up -d
docker compose logs -f open-webui
```

## Backup

Back up `openwebui/data/`, which holds accounts, settings and chat history,
together with the local `.env`. Stop the service or use an application-aware
SQLite backup to get a consistent copy.
