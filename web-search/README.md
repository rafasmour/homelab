# Web search MCP

Private Streamable HTTP MCP server that searches the web, fetches the top
pages with curl, extracts the main article, and returns markdown. Hermes and
Open WebUI call `http://web-search-mcp:8000/mcp`. There is no Traefik route
and no Homepage entry.

The process is not tied to one search engine. A composition root wires
`SearchEngine`, `FetchHeaders`, `FetchWebsite`, `ExtractMainContent`, and
`HTMLToMarkdown` from environment selectors. Missing selectors use SearXNG,
curl recommended headers, curl fetch, trafilatura, and markdownify.

Pages that need JavaScript will fail; this image has no browser.

## Requirements

- Docker Engine with Docker Compose
- The Compose-managed `hermes-mcp` network (start Hermes first)
- The external `webgateway` network
- SearXNG running as container `searxng` on `webgateway`

SearXNG must allow JSON responses. Merge `json` into the existing user-owned
`searxng/config/settings.yml` without replacing its other settings:

```yaml
search:
  formats:
    - html
    - json
```

Then restart SearXNG. This repository does not edit that ignored runtime
configuration automatically.

## Configure and start

Copy the environment template only if a local `.env` does not already exist:

```bash
cp .env.example .env
```

Generate `WEB_SEARCH_MCP_TOKEN` and put the same value in `web-search/.env`,
`hermes/.env`, and `openwebui/.env`:

```bash
openssl rand -hex 32
```

Start Hermes so it creates `hermes-mcp`, then this stack, then recreate Hermes
and Open WebUI:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
docker compose --env-file web-search/.env -f web-search/docker-compose.yml up -d --build
docker compose --env-file searxng/.env -f searxng/docker-compose.yml restart searxng
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
docker compose --env-file openwebui/.env -f openwebui/docker-compose.yml up -d
```

Hermes discovers the tool as `mcp_web_search_web_search` on specialist
profiles. Open WebUI's `hermes-agent` chat stays a dispatcher (`no_mcp`);
direct llama.cpp chats use the `web_search` MCP tool. If that tool does not
appear on an existing Open WebUI database, save **Admin > Integrations** once.

Existing Hermes cron jobs that still say Forage keep that wording until you
recreate them. New jobs and specialist soul templates use the MCP tool.

## Authentication and exposure

Bearer authentication is required even though the service is internal, because
`webgateway` is shared. Callers send `Authorization: Bearer <WEB_SEARCH_MCP_TOKEN>`.
`/healthz` is unauthenticated. Streamable HTTP also allowlists the Docker
`Host` header `web-search-mcp:8000`; without that, Hermes and Open WebUI get
HTTP 421. Do not add a public Traefik route without a
separate authentication and rate-limiting review: the tool fetches arbitrary
URLs.

## Storage and backups

The service keeps no persistent application data. Back up `.env`.

Stop the old Forage stack after this service is up:

```bash
docker compose --env-file forage/.env -f forage/docker-compose.yml down
```

Leave a local ignored `forage/.env` on disk unless you choose to delete it.

## Validation

```bash
docker compose --env-file web-search/.env -f web-search/docker-compose.yml config --quiet
docker compose --env-file web-search/.env -f web-search/docker-compose.yml ps
docker compose --env-file hermes/.env -f hermes/docker-compose.yml exec api \
  hermes mcp test web_search
```
