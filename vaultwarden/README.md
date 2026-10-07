# Vaultwarden

## Description

Bitwarden-compatible password management at `https://vaultwarden.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, generate the Argon2 `ADMIN_TOKEN`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the intended vault account through the web UI, then set `SIGNUPS_ALLOWED=false` and recreate the container. The administration page is `/admin` and has no separate username.

## Backup and important notes

Back up `.env` and `data` together. Test restores regularly because this data is security-critical.
