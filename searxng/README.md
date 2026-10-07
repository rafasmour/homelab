# SearXNG

## Description

Privacy-respecting metasearch at `https://searxng.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, replace `SEARXNG_SECRET`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Valkey is private and is used for rate limiting/cache state.

Forage requires SearXNG's JSON response format. Merge the following into the existing ignored `config/settings.yml`, preserving all other settings, and restart SearXNG:

```yaml
search:
  formats:
    - html
    - json
```

## Backup and important notes

SearXNG has no local authentication in this stack; protect it upstream if it should not be public. Back up `.env` and `config`; `data` and `valkey` are generally rebuildable cache state.
