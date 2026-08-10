# OpenTelemetry Collector

Private Docker log collection and OTLP ingestion for Loki.

Ensure `webgateway` exists, copy `.env.example` to `.env`, verify `DOCKER_LOG_ROOT` against `docker info`, and run `docker compose --env-file .env up -d`. A GET-only socket proxy discovers containers. The collector tails Docker `json-file` logs and exports them to `http://loki:3100/otlp` over `webgateway`.

There is no public route. Back up `.env` and `data` if preserving file offsets and the persistent export queue matters. Applications attached to `webgateway` may submit OTLP on ports 4317 or 4318 by container name `otel-collector`.
