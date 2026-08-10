# Loki

Log aggregation at `https://loki.${DOMAIN}`; readiness is available at `/ready`.

Ensure `webgateway` exists, copy `.env.example` to `.env`, and run `docker compose --env-file .env up -d`. OpenTelemetry Collector sends logs to Loki over `webgateway`, and Grafana's Loki data source is provisioned automatically.

Loki has no local authentication in this stack. Protect its public Traefik route or remove that route if only Grafana needs access. Back up `.env` and `data`.
