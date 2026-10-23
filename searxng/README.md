# SearXNG

## Description

Privacy-respecting metasearch at `https://searxng.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, replace `SEARXNG_SECRET`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Valkey is private and is used for rate limiting/cache state.

The web-search MCP requires SearXNG's JSON response format. Merge the following into the existing ignored `config/settings.yml`, preserving all other settings, and restart SearXNG:

```yaml
search:
  formats:
    - html
    - json
```

Engines: from this server's IP, DuckDuckGo, Brave and Startpage often answer with CAPTCHAs or 429s and get suspended, and Google, Qwant, Yahoo, Yep and Mojeek are blocked or return nothing. Keep these extra engines enabled and the timeouts raised, so searches still return results (tested 2026-10-23: Bing, mwmbl and Google CSE answered):

```yaml
outgoing:
  request_timeout: 6.0
  max_request_timeout: 15.0

engines:
  - name: bing
    disabled: false
  - name: mwmbl
    disabled: false
  - name: hackernews
    disabled: false
  - name: huggingface
    disabled: false
```

Check which engines respond with `/search?q=test&format=json`; `unresponsive_engines` lists the failing ones.

## Backup and important notes

SearXNG has no local authentication in this stack; protect it upstream if it should not be public. Back up `.env` and `config`; `data` and `valkey` are generally rebuildable cache state.
