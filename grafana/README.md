# Grafana

## Description

Observability dashboards at `https://grafana.${DOMAIN}`.

## Setup

Ensure `webgateway` exists, copy `.env.example` to `.env`, set the admin password, and run `docker compose --env-file .env up -d`. Prometheus and Loki are provisioned automatically as data sources and resolve over `webgateway`; start those stacks to make the data sources healthy.

The provisioned **Homelab / Container Health** dashboard shows every Uptime Kuma Docker monitor and maps its current `monitor_status` value to a color-coded health state.

## Backup and important notes

Back up `.env` and `data`. The tracked `provisioning` directory is declarative configuration and belongs in Git.
