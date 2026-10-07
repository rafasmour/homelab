# Excalidraw

## Description

Local-first whiteboarding at `https://excalidraw.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. This standalone client has no accounts or server-side collaboration and should be protected upstream if public access is undesirable.

## Backup and important notes

Drawings live in each browser. Export important drawings as `.excalidraw` files and back those exports up separately.
