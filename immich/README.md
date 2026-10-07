# Immich

## Description

Photo and video backup at `https://immich.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set an alphanumeric database password, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. The first browser account becomes administrator. Set `IMMICH_ALLOW_SETUP=false` afterward and recreate the server. Immich v3 needs an x86-64-v2-capable amd64 CPU and at least 6 GB RAM is recommended.

## Backup and important notes

Back up `.env`, `library`, and `postgres`. `model-cache` and `valkey` are rebuildable. Keep PostgreSQL on a local Unix-compatible filesystem, preferably SSD-backed.
