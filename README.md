# Self-hosted services

Independent Docker Compose stacks for applications hosted behind Traefik. Browser-facing and cross-stack observability containers join the external `webgateway` network. Private dependencies remain isolated on per-stack backend networks. Homepage and AutoKuma discover services from their Docker labels.

## Service catalog

| Service | Public hostname | Homepage group |
| --- | --- | --- |
| [AFFiNE](affine/README.md) | `affine.${DOMAIN}` | Knowledge |
| [ChartDB](chartdb/README.md) | `chartdb.${DOMAIN}` | Development |
| [Excalidraw](excalidraw/README.md) | `excalidraw.${DOMAIN}` | Knowledge |
| [Firefly III](firefly-iii/README.md) | `firefly.${DOMAIN}` | Finance |
| [GitLab CE](gitlab/README.md) | `gitlab.${DOMAIN}` | Development |
| [Grafana](grafana/README.md) | `grafana.${DOMAIN}` | Monitoring |
| [Homepage](homepage/README.md) | `${DOMAIN}` | Monitoring |
| [Immich](immich/README.md) | `immich.${DOMAIN}` | Photos |
| [Invidious](invidious/README.md) | `invidious.${DOMAIN}` | Media |
| [Loki](loki/README.md) | `loki.${DOMAIN}` | Monitoring |
| [Mealie](mealie/README.md) | `mealie.${DOMAIN}` | Food |
| [Memos](memos/README.md) | `memos.${DOMAIN}` | Knowledge |
| [n8n](n8n/README.md) | `n8n.${DOMAIN}` | Automation |
| [Nextcloud](nextcloud/README.md) | `nextcloud.${DOMAIN}` | Cloud |
| [Node Exporter](node-exporter/README.md) | Private metrics only | Not listed |
| [OpenTelemetry Collector](open-telemetry/README.md) | Private collector only | Not listed |
| [Pi-hole](pi-hole/README.md) | `pihole.${DOMAIN}` | Management |
| [Prometheus](prometheus/README.md) | `prometheus.${DOMAIN}` | Monitoring |
| [Reactive Resume](reactive-resume/README.md) | `resume.${DOMAIN}` | Productivity |
| [SearXNG](searxng/README.md) | `searxng.${DOMAIN}` | Search |
| [Tandoor Recipes](tandoor-recipes/README.md) | `tandoor.${DOMAIN}` | Food |
| [Unsloth Studio](unsloth-studio/README.md) | `unsloth.${DOMAIN}` | AI |
| [Uptime Kuma](uptime-kuma/README.md) | `uptime-kuma.${DOMAIN}` | Monitoring |
| [Vaultwarden](vaultwarden/README.md) | `vaultwarden.${DOMAIN}` | Security |

Pi-hole uses host networking rather than Traefik labels; its DNS and web listeners must be routed at the host/network level.

## Shared prerequisites

Traefik must already be running and its external network must exist:

```sh
docker network inspect webgateway
```

Each stack is an independent Compose project, so Compose cannot enforce startup ordering between folders. Start observability in this order:

1. Loki and Node Exporter.
2. Prometheus and OpenTelemetry Collector.
3. Grafana.

The containers restart automatically, so a temporary downstream outage during a different start order is safe. On `webgateway`, Prometheus scrapes `node-exporter:9100`, the collector exports to `loki:3100`, and Grafana uses `prometheus:9090` and `loki:3100`. These connections use Docker DNS directly and do not traverse Traefik.

Homepage discovers every web application carrying `homepage.*` labels through its private GET-only socket proxy. AutoKuma discovers `kuma.*` labels and creates Docker monitors through Uptime Kuma. Both mechanisms work across Compose projects and do not require a shared application network.

## Starting a stack

From the repository root, copy the tracked template, replace every `CHANGE_ME`, validate the rendered configuration, and start it:

```sh
cp memos/.env.example memos/.env
docker compose --env-file memos/.env -f memos/docker-compose.yml config --quiet
docker compose --env-file memos/.env -f memos/docker-compose.yml up -d
```

Real `.env` files and runtime directories are ignored and must not be committed. Commands for generating specially formatted secrets and first-run account instructions are documented in each stack's `.env.example` and README.

## Authentication and public exposure

ChartDB, Excalidraw, Homepage, Loki, Prometheus, and SearXNG have no local authentication in these stacks. Put a Traefik authentication middleware or identity-aware proxy in front of them, or remove their public route when browser access is unnecessary. Loki and Prometheus remain reachable to Grafana on `webgateway` if their Traefik labels are removed.

Disable open registration after creating the owner account where the corresponding `.env.example` provides a switch: Immich uses `IMMICH_ALLOW_SETUP`, Mealie uses `ALLOW_SIGNUP`, Reactive Resume uses `FLAG_DISABLE_SIGNUPS`, and Vaultwarden uses `SIGNUPS_ALLOWED`.

Docker socket access is security-sensitive even when the mount is read-only. Homepage limits API access through a socket proxy, while Uptime Kuma and AutoKuma currently mount the socket directly for Docker monitoring. Protect those administrative interfaces and run only trusted images.

## Backups

Back up each stack's ignored `.env` and persistent bind mounts. For database-backed services, use the application's documented dump/backup procedure or stop the stack before copying database files. Important non-obvious paths include:

- Immich: `library` and `postgres` are critical; `model-cache` and `valkey` are rebuildable.
- Nextcloud: `html` plus a consistent MariaDB backup.
- OpenTelemetry Collector: `data` holds file-tail offsets and the persistent Loki export queue.
- Excalidraw and ChartDB: export browser-local documents explicitly.
- Homepage: `config`; only `config/docker.yaml` is tracked.

Docker may create missing bind-mount directories as root. If a service reports permissions errors, create its data directory first and give it to the UID/GID configured in that stack without broadening permissions unnecessarily.

## Validation

Validate every stack after changing Compose or environment templates:

```sh
for compose in */docker-compose.yml; do
  directory=${compose%/*}
  docker compose --env-file "$directory/.env.example" -f "$compose" config --quiet
done

docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  prom/prometheus:latest check config /etc/prometheus/prometheus.yml
docker run --rm \
  -v "$PWD/loki/loki-config.yml:/etc/loki/config.yml:ro" \
  grafana/loki:latest -config.file=/etc/loki/config.yml -verify-config=true
docker run --rm -e HOST_NAME=docker-host \
  -v "$PWD/open-telemetry/otel-collector-config.yml:/etc/otelcol-contrib/config.yml:ro" \
  otel/opentelemetry-collector-contrib:0.157.0 validate \
  --config=/etc/otelcol-contrib/config.yml
git diff --check
git status --short
```

Confirm that no `.env`, database, cache, upload, log, model, or user-content file appears in Git status.

The SilverBullet Compose definition was removed previously. Its ignored local `silverbullet/space` data remains untouched.
