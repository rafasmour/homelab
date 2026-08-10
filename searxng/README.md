# SearXNG

Privacy-respecting metasearch at `https://searxng.${DOMAIN}`.

Copy `.env.example` to `.env`, replace `SEARXNG_SECRET`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Valkey is private and is used for rate limiting/cache state.

SearXNG has no local authentication in this stack; protect it upstream if it should not be public. Back up `.env` and `config`; `data` and `valkey` are generally rebuildable cache state.
