# Prometheus

## Description

Metrics collection and querying at `https://prometheus.${DOMAIN}`.

## Setup

Ensure `webgateway` exists, copy `.env.example` to `.env`, and set `UPTIME_KUMA_API_KEY` to an API key generated under Uptime Kuma's **Settings > Security > API Keys**. Run `docker compose --env-file .env up -d`. The API key is mounted as a Compose secret; it is not stored in `prometheus.yml` or exposed as a container environment variable.

The tracked configuration scrapes Prometheus itself, `node-exporter:9100`, and Uptime Kuma's authenticated `/metrics` endpoint over `webgateway`. Uptime Kuma provides monitor status, response-time, and certificate metrics. Grafana receives Prometheus as its default provisioned data source.

## Backup and important notes

Prometheus has no local authentication in this stack; protect its Traefik route or remove it when only Grafana needs access. Back up `.env`, `prometheus.yml`, and `data`.
