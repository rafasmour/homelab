# Node Exporter

## Description

Private host metrics for Prometheus at `node-exporter:9100` on the shared `webgateway` network.

## Setup

Ensure `webgateway` exists, copy `.env.example` to `.env`, and run `docker compose --env-file .env up -d`. There is no host-published port or Traefik route. Prometheus is preconfigured to scrape this container by name.

## Backup and important notes

The container uses the host PID namespace and a read-only recursive mount of `/`; run it only on a trusted host. It has no persistent data to back up.
