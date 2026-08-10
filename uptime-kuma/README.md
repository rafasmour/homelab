# Uptime Kuma and AutoKuma

Uptime monitoring at `https://uptime-kuma.${DOMAIN}` with label-driven monitor creation.

Copy `.env.example` to `.env`, create the Uptime Kuma administrator in the browser, put those same credentials in `.env`, and run `docker compose --env-file .env up -d`. AutoKuma reads `kuma.*` labels and manages monitors through Uptime Kuma. Both containers receive read-only Docker socket mounts; socket access remains highly privileged, so protect the UI.

Back up `.env`, `data`, and `autokuma-data`.
