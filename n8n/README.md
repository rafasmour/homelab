# n8n

## Description

Workflow automation at `https://n8n.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set the database password and a permanent `N8N_ENCRYPTION_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the owner account in the browser. Never change the encryption key after credentials have been stored.

## Hermes MCP integration

The `mcp` service runs the official [n8n MCP server](https://github.com/czlonkowski/n8n-mcp) with workflow-management tools enabled. Containers on the `hermes-mcp` network use `http://n8n-mcp:3000/mcp`. Traefik also routes `https://n8n-mcp.${DOMAIN}/mcp` to it. There is no host port. Callers must send `Authorization: Bearer <N8N_MCP_AUTH_TOKEN>`.

Create an API key under **Settings > n8n API**, store it as `N8N_API_KEY`, and generate `N8N_MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Put the same MCP token in `hermes/.env`; Hermes uses it as the Bearer token for `http://n8n-mcp:3000/mcp`.

Start the Hermes stack before this stack. Hermes creates the shared network, while this Compose file references it as external:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

The MCP server can create, update, execute, and delete workflows. Back up production workflows and review changes before running them.

## Piraeus monthly statement

`workflows/piraeus-monthly-import.json` is imported into the running n8n container and left inactive. Connect a Gmail OAuth credential on its trigger, set `PIRAEUS_ZIP_PASSWORD`, and set the same `AUTO_IMPORT_SECRET` in this `.env` and `firefly-iii/.env`. Import one normalized CSV through the Firefly data importer UI and save that mapping as `imports/_fallback.json`. The workflow then unzips the statement, writes `imports/piraeus-current.csv`, and asks the importer to load it. A successful import moves that CSV into `firefly-iii/import-archive`. The workflow saves the zip at `/tmp/piraeus-statement.zip`, so Compose sets `N8N_RESTRICT_FILE_ACCESS_TO` to allow `/tmp` alongside `~/.n8n-files`.

## Firefly subscriptions calendar

`workflows/firefly-subscriptions-to-nextcloud.json` runs at 00:30 Europe/Athens and does not use a model. It lists Firefly III bills and upserts one all-day event per active subscription on the Nextcloud calendar named Payments. Each event includes the amount, the next date, and the Firefly id. Import it inactive. On the Firefly request, attach a Header Auth credential whose header is `Authorization` and whose value is `Bearer` plus a Firefly personal access token. On the CalDAV requests, attach a Basic Auth credential with the Nextcloud username and a CalDAV app password. No credentials are stored in the workflow file. Create the Payments calendar in Nextcloud before the first run. Hermes reads the Payments calendar at 03:30 and only unpaid items become tasks at 07:00.

## Backup and important notes

Back up `.env`, `data`, and a consistent copy or dump of `postgres`.
