# Web search MCP

Private Streamable HTTP MCP server that searches the web or reads a known
URL, fetches pages with curl, extracts the main article, and returns markdown.
Hermes and Open WebUI call `http://web-search-mcp:8000/mcp`. Open WebUI's
built-in web search can also use the REST endpoints `/search` and `/fetch`.
There is no Traefik route and no Homepage entry.

## Tools and endpoints

| Interface | Purpose |
| --- | --- |
| MCP `web_search(query: str, n: int = 0)` | Discover pages: search, read the top `n` hits in parallel, return title, URL, snippet and a short main-text excerpt per hit. |
| MCP `fetch_url(url: str, max_chars: int = 0)` | Read one known URL in full. Returns `# {title}`, `URL: {final_url}`, then markdown. |
| `POST /search` `{"query": str, "count": int}` | Returns `[{"link", "title", "snippet"}]` without fetching pages (at most 20). |
| `POST /fetch` `{"urls": [str]}` | Returns `[{"page_content", "metadata": {"source", "title"}}]` (at most 20 URLs; failed URLs are omitted). |
| `GET /healthz` | Unauthenticated health check. |

HTML is converted to markdown. `text/plain`, `text/markdown` and JSON are
returned as-is. PDFs, images and other binary types return an error.
`fetch_url` and `/fetch` documents are capped at `WEB_FETCH_MAX_CHARS`
(default 20000); `max_chars` can only lower that cap.

`web_search` returns only excerpts, so a model does not receive a page twice
when it later calls `fetch_url`. Each result carries the first
`WEB_SEARCH_EXCERPT_CHARS` (default 1200) characters of its main text, with
link targets and images removed, followed by
`[excerpt — call fetch_url for the full page]`, or by
`[complete page text, links omitted — no need to call fetch_url]` when the
page is that short. `WEB_SEARCH_EXCERPT_CHARS=0` skips reading pages and
returns snippets only.

Latency is bounded. SearXNG is queried with `timeout_limit` (default
`SEARXNG_TIMEOUT_LIMIT=3` seconds), so a hanging or rate-limited engine cannot
hold a search for the full `outgoing.request_timeout`. Result pages are read in
parallel (`WEB_SEARCH_FETCH_WORKERS`, default 8) with a single attempt and a
shared `WEB_SEARCH_FETCH_DEADLINE` (default 4 seconds, redirects included).
A page that misses the deadline is listed with its snippet and
`[page not read: ...]`. A `web_search` call therefore takes at most about
`SEARXNG_TIMEOUT_LIMIT + WEB_SEARCH_FETCH_DEADLINE + 1` seconds. `fetch_url`
and `/fetch` keep the normal `FETCH_MAX_TIME` and `FETCH_RETRY` settings.
`SEARXNG_ENGINES` and `SEARXNG_CATEGORIES` optionally restrict which SearXNG
engines are queried.

### Open WebUI built-in web search

The REST endpoints match Open WebUI's `external` search engine and `external`
web loader. Set in **Admin > Settings > Web Search** (or the equivalent
environment variables):

- Search engine `external`: URL `http://web-search-mcp:8000/search`, API key
  `WEB_SEARCH_MCP_TOKEN`.
- Web loader `external`: URL `http://web-search-mcp:8000/fetch`, API key
  `WEB_SEARCH_MCP_TOKEN`.

Open WebUI must share a Docker network with this container.

The process is not tied to one search engine. A composition root wires
`SearchEngine`, `FetchHeaders`, `FetchWebsite`, `ExtractMainContent`, and
`HTMLToMarkdown` from environment selectors. Missing selectors use SearXNG,
curl recommended headers, curl fetch, trafilatura, and markdownify.

Pages that need JavaScript will fail; this image has no browser.

## Requirements

- Docker Engine with Docker Compose
- The Compose-managed `hermes-mcp` network (start Hermes first)
- The external `webgateway` network
- Nothing for `hermes-websearch`: this stack creates that internal network.
  `pi-sandbox` (module `websearch`, in `~/docker/hermes-sandbox`) joins it to
  reach only this server, with the same bearer token, without seeing the
  other MCP servers on `hermes-mcp`.
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

Engines that keep answering with CAPTCHAs or rate limits are suspended by
SearXNG, but each time a suspension expires the next search waits for them
again (up to `SEARXNG_TIMEOUT_LIMIT`). Check the `unresponsive_engines` field of
`/search?format=json` and add persistent offenders to
`SEARXNG_DISABLED_ENGINES` (default `duckduckgo,brave,startpage,wikidata`),
which turns them off for this service's queries only, or disable them in
`settings.yml`. Every `web_search` call logs one
`search …s, pages …s, n/m pages read` line; `LOG_LEVEL=DEBUG` adds one line per
page read.

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

Hermes discovers the tools as `mcp__web_search__web_search` and
`mcp__web_search__fetch_url` on specialist profiles. Open WebUI's
`hermes-agent` chat stays a dispatcher (`no_mcp`); direct llama.cpp chats use
the `web_search` and `fetch_url` MCP tools. If they do not
appear on an existing Open WebUI database, save **Admin > Integrations** once.

Existing Hermes cron jobs that still say Forage keep that wording until you
recreate them. New jobs and specialist soul templates use the MCP tool.

## Authentication and exposure

Bearer authentication is required even though the service is internal, because
`webgateway` is shared. Callers send `Authorization: Bearer <WEB_SEARCH_MCP_TOKEN>`.
`/healthz` is unauthenticated. Streamable HTTP also allowlists the Docker
`Host` header `web-search-mcp:8000`; without that, Hermes and Open WebUI get
HTTP 421. The Host allowlist applies only to `/mcp`; `/search` and `/fetch`
need only the bearer token. Do not add a public Traefik route without a
separate authentication and rate-limiting review: the tools fetch arbitrary
URLs.

### SSRF guard

The container sits on `hermes-mcp`, `hermes-websearch` and `webgateway`, so it can reach other
internal services. With `FETCH_ALLOW_PRIVATE=false` (the default), every URL
is resolved before fetching and refused if any address is private, loopback,
link-local, CGNAT, multicast, reserved or otherwise not globally routable.
curl does not follow redirects itself: the service follows each redirect hop,
checks it again, and pins curl to the checked address with `--resolve`, so DNS
rebinding cannot swap in an internal address. This applies to `fetch_url`,
`/fetch` and the pages `web_search` reads. SearXNG itself is queried directly
and is not affected. Set `FETCH_ALLOW_PRIVATE=true` only if the tools must
read internal hosts.

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
