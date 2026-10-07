# Homelab services

Independent Docker Compose stacks for self-hosted applications. Each service folder contains its Compose definition, an environment template, and a README with service-specific setup and backup notes.

Browser-facing services normally use Traefik through the external `webgateway` network. Private databases, caches, workers, and collectors remain unpublished.

## Service catalog

| Service | Description | Public route | Homepage group |
| --- | --- | --- | --- |
| [ChartDB](chartdb/README.md) | Browser-based database diagramming | `chartdb.${DOMAIN}` | Development |
| [draw.io](drawio/README.md) | Browser-based diagram and flowchart editor with Hermes MCP tools | `drawio.${DOMAIN}` | Knowledge |
| [Excalidraw](excalidraw/README.md) | Local-first whiteboarding | `excalidraw.${DOMAIN}` | Knowledge |
| [Firefly III](firefly-iii/README.md) | Personal finance management and data importing | `firefly.${DOMAIN}`, `firefly-importer.${DOMAIN}` | Finance |
| [Forage](forage/README.md) | Internal web search and extraction backend for Hermes | Private only | Not listed |
| [GitLab CE](gitlab/README.md) | Git hosting and CI/CD | `gitlab.${DOMAIN}` | Development |
| [Grafana](grafana/README.md) | Dashboards for metrics and logs | `grafana.${DOMAIN}` | Monitoring |
| [Hermes](hermes/README.md) | Agent dashboard and OpenAI-compatible API | `hermes.${DOMAIN}` | AI |
| [Homepage](homepage/README.md) | Homelab service dashboard | `${DOMAIN}` | Monitoring |
| [Image Generation](image-generation/README.md) | Vulkan Stable Diffusion WebUI and API | `stable-diffusion.${DOMAIN}` | Not configured |
| [Immich](immich/README.md) | Photo and video backup | `immich.${DOMAIN}` | Photos |
| [llama.cpp](llama-cpp/README.md) | Vulkan model router with an OpenAI-compatible API | `ai.${DOMAIN}` | AI |
| [Loki](loki/README.md) | Log aggregation | `loki.${DOMAIN}` | Monitoring |
| [Mealie](mealie/README.md) | Recipe and meal planning | `mealie.${DOMAIN}` | Food |
| [Memos](memos/README.md) | Lightweight notes and knowledge capture | `memos.${DOMAIN}` | Knowledge |
| [n8n](n8n/README.md) | Workflow automation | `n8n.${DOMAIN}` | Automation |
| [Nextcloud](nextcloud/README.md) | File sync and collaboration | `nextcloud.${DOMAIN}` | Cloud |
| [Node Exporter](node-exporter/README.md) | Host metrics for Prometheus | Private only | Not listed |
| [OpenTelemetry Collector](open-telemetry/README.md) | Docker log collection and OTLP ingestion | Private only | Not listed |
| [Open WebUI](openwebui/README.md) | Browser interface for the llama.cpp API | `webui.${DOMAIN}` | AI |
| [Pi-hole](pi-hole/README.md) | Network-wide DNS filtering | `pihole.${DOMAIN}` | Management |
| [Prometheus](prometheus/README.md) | Metrics collection and querying | `prometheus.${DOMAIN}` | Monitoring |
| [Reactive Resume](reactive-resume/README.md) | Resume builder | `resume.${DOMAIN}` | Productivity |
| [SearXNG](searxng/README.md) | Privacy-respecting metasearch | `searxng.${DOMAIN}` | Search |
| [Tandoor Recipes](tandoor-recipes/README.md) | Recipe management | `tandoor.${DOMAIN}` | Food |
| [Unsloth Studio](unsloth-studio/README.md) | GPU-backed model training workspace | `unsloth.${DOMAIN}` | AI |
| [Uptime Kuma](uptime-kuma/README.md) | Uptime monitoring with AutoKuma discovery | `uptime-kuma.${DOMAIN}` | Monitoring |
| [Vaultwarden](vaultwarden/README.md) | Bitwarden-compatible password management | `vaultwarden.${DOMAIN}` | Security |
| [wger](wger/README.md) | Workout and nutrition tracking | `wger.${DOMAIN}` | Food |

Pi-hole publishes DNS only on the LAN and WireGuard addresses from its environment file. Its web interface is routed through Traefik.

## Prerequisites

- Docker Engine with the Docker Compose plugin
- Traefik configured with the `websecure` entrypoint and `myresolver`
- The external Docker network named `webgateway`
- DNS records for the routes listed above

Create the shared network once if it does not already exist:

```sh
docker network inspect webgateway >/dev/null 2>&1 || docker network create webgateway
```

Hardware-accelerated AI services have additional GPU requirements documented in their own READMEs.

For an end-to-end fresh-install sequence, work through [TODO.md](TODO.md).

## Start a service

From the repository root, copy the service's environment template, replace all required placeholders, validate the rendered configuration, and start it. For example:

```sh
cp memos/.env.example memos/.env
docker compose --env-file memos/.env -f memos/docker-compose.yml config --quiet
docker compose --env-file memos/.env -f memos/docker-compose.yml up -d
```

Read the linked service README before starting a stack. It documents first-run account creation, dependencies, security limitations, and backup paths.

## Local data and secrets

Real `.env` files, downloaded models, databases, uploads, logs, caches, and other runtime data are intentionally ignored. Do not commit them. Back up each service's `.env` and persistent bind mounts; use an application-supported dump for databases whenever possible.

## Observability startup order

Compose projects cannot enforce startup ordering across service folders. For a clean observability startup, launch:

1. Loki and Node Exporter.
2. Prometheus and OpenTelemetry Collector.
3. Grafana.

Temporary downstream failures are safe because the long-running containers restart automatically.
