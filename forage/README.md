# Forage

Internal Docker Compose deployment for [Forage](https://github.com/aldemaroc/forage), a lightweight web search and page-extraction backend for Hermes Agent.

Forage is not published through Traefik and has no Homepage entry. It listens on port `3672` only inside the external `webgateway` network, where it calls the existing SearXNG service at `http://searxng:8080`.

## Requirements

- Docker Engine with Docker Compose
- The external `webgateway` Docker network
- The existing SearXNG stack running as container `searxng` on `webgateway`
- Internet access while Docker builds the upstream Forage source

Forage includes Chromium in its image and needs about 1 GB of disk space. It launches browsers on demand for pages that require JavaScript.

SearXNG must allow JSON responses. Merge `json` into the existing user-owned `searxng/config/settings.yml` without replacing its other settings:

```yaml
search:
  formats:
    - html
    - json
```

Then restart SearXNG. This repository deliberately does not edit that ignored runtime configuration automatically.

## Configure and start

Copy the environment template only if a local `.env` does not already exist:

```bash
cp .env.example .env
```

Generate `FORAGE_API_KEY`, then put the same value in `forage/.env` and `hermes/.env`:

```bash
openssl rand -hex 32
```

Build and start Forage before recreating Hermes:

```bash
docker compose --env-file forage/.env -f forage/docker-compose.yml up -d --build
docker compose --env-file searxng/.env -f searxng/docker-compose.yml restart searxng
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

The Hermes API startup script automatically installs the upstream `web/forage` plugin and selects Forage for both web search and extraction.

## Authentication and exposure

Bearer authentication is enabled. The API key is required even though the service is internal-only, because `webgateway` is shared with other containers. There is no administrator account or browser UI.

Do not add a public Traefik route without an additional authentication and rate-limiting review: Forage can fetch arbitrary URLs and start a browser.

## Storage and backups

Forage keeps only in-memory cache state and has no persistent application data to back up. Back up `forage/.env`; the tracked `config.yml` can be restored from Git. The Hermes plugin copy is cached in the existing `hermes-data` volume and can be recreated from upstream.

## Validation

```bash
docker compose --env-file forage/.env -f forage/docker-compose.yml config --quiet
docker compose --env-file forage/.env -f forage/docker-compose.yml ps
docker compose --env-file forage/.env -f forage/docker-compose.yml exec forage \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3672/health').read().decode())"
```

Search requests require `Authorization: Bearer <FORAGE_API_KEY>` on `POST /search`.
