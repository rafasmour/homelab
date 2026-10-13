# Open WebUI

Open WebUI provides a browser interface for the OpenAI-compatible APIs exposed
by [`llama-cpp`](../llama-cpp/README.md),
[`llama-cpp-classifier`](../llama-cpp-classifier/README.md), and the
[Hermes API](../hermes/README.md). In this repository it reaches
`llama-server`, `llama-classifier`, and `hermes-api` over the shared
`webgateway` Docker network and is published by Traefik at
`https://webui.<DOMAIN>`.

## Requirements

- Docker Engine with Docker Compose
- The external Docker network `webgateway`
- A running `llama-cpp` stack reachable as `llama-server:8080`
- A running `llama-cpp-classifier` stack reachable as `llama-classifier:8080`
- A running Hermes API reachable as `hermes-api:8642` on `webgateway`
- The web-search MCP reachable as `web-search-mcp:8000` on `webgateway`
- Traefik configured to route `webui.<DOMAIN>`

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

Set the following variables:

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Creates the Traefik host rule `webui.<DOMAIN>` |
| `OPENAI_API_KEY` | Value sent to the llama.cpp and classifier backends |
| `HERMES_API_KEY` | Must match Hermes `API_SERVER_KEY` |
| `OPEN_WEBUI_IMAGE_TAG` | Open WebUI image tag; pin a release such as `v0.11.4` |
| `WEB_SEARCH_MCP_TOKEN` | Bearer token for the web-search MCP; must match `web-search/.env` |

Neither llama.cpp router enforces authentication by default, but Open WebUI
still expects an API key field for each OpenAI provider. Any non-empty
placeholder is sufficient unless an upstream API is later protected.
`HERMES_API_KEY` must match Hermes `API_SERVER_KEY`.
`WEB_SEARCH_MCP_TOKEN` must match `web-search/.env`.

Open WebUI registers three connections:

- `http://llama-server:8080/v1` for GPU chat models
- `http://llama-classifier:8080/v1` for CPU decision models such as Laya
- `http://hermes-api:8642/v1` for the Hermes API on `webgateway`

The chat UI uses `/v1/models` and `/v1/chat/completions`. The classifier's
native `POST /v1/systemone` endpoint is not used by Open WebUI.

Open WebUI also connects to the private web-search MCP at
`http://web-search-mcp:8000/mcp` over `webgateway` (`ENABLE_TOOL_SERVERS` and
`TOOL_SERVER_CONNECTIONS`). Direct llama.cpp chats can call `web_search`. The
`hermes-agent` model stays a dispatcher and does not call MCP tools. If the
tool does not appear on an existing `openwebui/data` database, save
**Admin > Integrations** once.

Open WebUI login is disabled (`WEBUI_AUTH=false`). Anyone who can reach
`https://webui.<DOMAIN>` has full use of the UI and its backends. Add a Traefik
authentication middleware or an identity-aware proxy if that hostname is
reachable beyond trusted users.

Open WebUI only allows turning authentication off on a database with no
registered users. If login was enabled earlier, stop the stack, move
`openwebui/data/webui.db` aside, and start again.

## Start the service

Create the external network once if it does not already exist:

```bash
docker network create webgateway
```

Start the UI:

```bash
docker compose up -d
docker compose logs -f open-webui
```

Check the rendered Compose configuration with:

```bash
docker compose config
```

## Access the UI

Open:

```text
https://webui.example.com
```

Replace `example.com` with the configured domain. Both router model lists
should appear in the model picker.

## Backup

Back up `openwebui/data/`, which contains accounts, settings, and chat history,
together with the local `.env`. Stop the service or use an application-aware
database backup method to obtain a consistent copy.
