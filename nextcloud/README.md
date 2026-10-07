# Nextcloud

## Description

File sync and collaboration at `https://nextcloud.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, replace both database passwords, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the administrator in the first-run browser wizard. The private MariaDB and Redis services must be healthy before Nextcloud starts; the cron service handles background jobs.

## Hermes MCP integration

The `mcp` service runs the official [Nextcloud MCP Server](https://github.com/cbcoutinho/nextcloud-mcp-server) in single-user mode. It is reachable only by containers attached to the `hermes-mcp` network and has no host port or Traefik route.

Create a dedicated Nextcloud account with access only to the content Hermes should manage. While signed in as that account, create an app password under **Settings > Security > Devices & sessions**, then set `NEXTCLOUD_MCP_USERNAME` and `NEXTCLOUD_MCP_APP_PASSWORD` in the ignored `.env`. Do not use the account's normal login password.

Start the Hermes stack before this stack. Hermes creates the shared network, while this Compose file references it as external:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

Hermes connects to `http://nextcloud-mcp:8000/mcp` from the default profile and from the dedicated `nextcloud` profile. Recreate `hermes-api` after this service is healthy so the new network attachment is applied and Hermes discovers the tools.

## Backup and important notes

Back up `.env`, `html`, `mcp-data`, and a consistent MariaDB dump or stopped copy of `database`. `redis` is a cache and is not a substitute for the database backup.
