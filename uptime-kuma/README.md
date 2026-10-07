# Uptime Kuma and AutoKuma

## Description

Uptime monitoring at `https://uptime-kuma.${DOMAIN}` with label-driven monitor creation.

## Setup

Copy `.env.example` to `.env`, set `UPTIME_KUMA_USERNAME` and `UPTIME_KUMA_PASSWORD`, and run `docker compose --env-file .env up -d`. The one-shot `uptime-kuma-bootstrap` service creates the administrator through Uptime Kuma's setup API on the first launch. On later launches it verifies the configured credentials, then AutoKuma starts with the same account and manages monitors from `kuma.*` labels.

If the data directory already contains an administrator, set the variables to that account's credentials. The bootstrap service deliberately fails instead of changing an existing password. Uptime Kuma and AutoKuma receive read-only Docker socket mounts; socket access remains highly privileged, so protect the UI.

## Backup and important notes

Back up `.env`, `data`, and `autokuma-data`.
