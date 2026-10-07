# n8n

## Description

Workflow automation at `https://n8n.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set the database password and a permanent `N8N_ENCRYPTION_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the owner account in the browser. Never change the encryption key after credentials have been stored.

## Hermes MCP integration

The `mcp` service runs the official [n8n MCP server](https://github.com/czlonkowski/n8n-mcp) with workflow-management tools enabled. It is reachable only by containers attached to the `hermes-mcp` network and has no host port or Traefik route.

Create an API key under **Settings > n8n API**, store it as `N8N_API_KEY`, and generate `N8N_MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Put the same MCP token in `hermes/.env`; Hermes uses it as the Bearer token for `http://n8n-mcp:3000/mcp`.

Start the Hermes stack before this stack. Hermes creates the shared network, while this Compose file references it as external:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

The MCP server can create, update, execute, and delete workflows. Back up production workflows and review changes before running them.

## Backup and important notes

Back up `.env`, `data`, and a consistent copy or dump of `postgres`.
