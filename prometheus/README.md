# Prometheus

Metrics collection and querying at `https://prometheus.${DOMAIN}`.

Ensure `webgateway` exists, copy `.env.example` to `.env`, and run `docker compose --env-file .env up -d`. The tracked configuration scrapes Prometheus itself and `node-exporter:9100` over `webgateway`. Grafana receives this service as its default provisioned data source.

Prometheus has no local authentication in this stack; protect its Traefik route or remove it when only Grafana needs access. Back up `.env`, `prometheus.yml`, and `data`.
