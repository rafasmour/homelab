# Firefly III

## Description

Personal finance management at `https://firefly.${DOMAIN}`, with the Firefly III Data Importer at `https://firefly-importer.${DOMAIN}`. Firefly III uses its experimental v2 layout.

## Setup

Copy `.env.example` to `.env`, set every secret and `SITE_OWNER`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. The first user is created through the browser. A private MariaDB service stores the database and the cron container invokes Firefly III's daily task endpoint.

After creating the owner account, open Firefly III's **Options > OAuth** page at `/profile/oauth` and create a public OAuth client. Use `https://firefly-importer.${DOMAIN}/callback` as its redirect URL and leave **Confidential** unchecked. Put the numeric client ID in `FIREFLY_III_CLIENT_ID`, then rerun `docker compose --env-file .env up -d` to recreate the importer. A Personal Access Token in `FIREFLY_III_ACCESS_TOKEN` is an alternative; configure exactly one method.

The importer has no independent login in front of its workflow. Protect `firefly-importer.${DOMAIN}` with a Traefik authentication middleware or an identity-aware proxy if the hostname is publicly reachable.

Directory auto-import is enabled for `/import`. A file is imported when a JSON mapping with the same name is present, or when `imports/_fallback.json` exists. `AUTO_IMPORT_SECRET` must match the value in `n8n/.env`. The n8n Piraeus workflow writes `imports/piraeus-current.csv` and posts to this endpoint.

## Backup and important notes

Back up `.env`, `database`, `uploads`, and any reusable import configurations in `imports` together. Prefer a consistent MariaDB dump or stop the stack before copying `database`. Bank files placed in `imports` contain sensitive financial data and remain ignored by Git.
