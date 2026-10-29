# Homelab services

Independent Docker Compose stacks for self-hosted applications. Each service folder contains its Compose definition, an environment template, and a README with service-specific setup and backup notes.

Browser-facing services normally use Traefik through the external `webgateway` network. Private databases, caches, workers, and collectors remain unpublished.

## Service catalog

| Service | Description | Public route | Homepage group |
| --- | --- | --- | --- |
| [Benchmark](benchmark/README.md) | Compares llama.cpp models as the brain of the Hermes profiles (runner with Docker socket and job API; MCP server for the Hermes `models` profile; SQLite results browser behind a login page) | `benchmark.${DOMAIN}` | AI |
| [ChartDB](chartdb/README.md) | Browser-based database diagramming | `chartdb.${DOMAIN}` | Development |
| [Docker state exporter](docker-state-exporter/README.md) | Prometheus metrics for container state, health and restarts | Private only | Not listed |
| [draw.io](drawio/README.md) | Browser-based diagram and flowchart editor with Hermes MCP tools | `drawio.${DOMAIN}` | Knowledge |
| [Excalidraw](excalidraw/README.md) | Local-first whiteboarding | `excalidraw.${DOMAIN}` | Knowledge |
| [Firefly III](firefly-iii/README.md) | Personal finance management and data importing | `firefly.${DOMAIN}`, `firefly-importer.${DOMAIN}` | Finance |
| [Web search MCP](web-search/README.md) | SearXNG-backed crawl-to-markdown MCP for Hermes and Open WebUI | Private only | Not listed |
| [GitLab CE](gitlab/README.md) | Git hosting and CI/CD | `gitlab.${DOMAIN}` | Development |
| [Grafana](grafana/README.md) | Dashboards for metrics and logs | `grafana.${DOMAIN}` | Monitoring |
| [Hermes](hermes/README.md) | OpenAI-compatible API for the Hermes agent profiles | `hermes.${DOMAIN}` | AI |
| [Hermes Nextcloud Talk bridge](hermes-nextcloud-bridge/README.md) | Nextcloud Talk bot and delivery endpoint for Hermes | Private only | Not listed |
| [Hermes sandboxes](hermes-sandboxes/README.md) | Per-profile SSH sandboxes for the API profiles' terminal/file tools, a restart-only Docker proxy and a Docker-in-Docker agent testbed | Private only | Not listed |
| [Home Assistant](home-assistant/README.md) | Assist voice pipeline: Whisper, Hermes `voice` agent, Kokoro TTS (Android wake word via the Companion app) | `home-assistant.${DOMAIN}` | Home |
| [Homepage](homepage/README.md) | Homelab service dashboard | `${DOMAIN}` | Monitoring |
| [Image Generation](image-generation/README.md) | Vulkan Stable Diffusion WebUI and API | `stable-diffusion.${DOMAIN}` | Not configured |
| [Immich](immich/README.md) | Photo and video backup | `immich.${DOMAIN}` | Photos |
| [llama.cpp](llama-cpp/README.md) | Vulkan model router with an OpenAI-compatible API, plus a Hugging Face GGUF download UI | `ai.${DOMAIN}`, `models.${DOMAIN}` | AI |
| [llama.cpp classifiers](llama-cpp-classifier/README.md) | CPU router for decision models | `classify.${DOMAIN}` | AI |
| [Loki](loki/README.md) | Log aggregation | `loki.${DOMAIN}` | Monitoring |
| [Maps](maps/README.md) | Greece-only maps: vector tiles + web map, Valhalla routing, lean Pelias search (backend for Cardinal / Murena Maps search and directions) | `maps.${DOMAIN}` | Home |
| [Mealie](mealie/README.md) | Recipe and meal planning | `mealie.${DOMAIN}` | Food |
| [Memos](memos/README.md) | Lightweight notes and knowledge capture | `memos.${DOMAIN}` | Knowledge |
| [n8n](n8n/README.md) | Workflow automation; runs the scheduled Hermes Talk digests | `n8n.${DOMAIN}` | Automation |
| [n8n drift runner](n8n-drift-runner/README.md) | Webhook runner that Grafana triggers to check n8n workflows against git (no cron, no Docker socket) | Private only (internal `n8n-drift` network) | Not listed |
| [Nextcloud](nextcloud/README.md) | File sync and collaboration | `nextcloud.${DOMAIN}` | Cloud |
| [Paperless-ngx](paperless/README.md) | Document management (Greek+English OCR, tags, full-text search) fed from Nextcloud `Scans/`, with paperless-gpt LLM suggestions (no login; VPN only) | `paperless.${DOMAIN}`, `paperless-gpt.${DOMAIN}` | Cloud |
| [Node Exporter](node-exporter/README.md) | Host metrics for Prometheus | Private only | Not listed |
| [OpenTelemetry Collector](open-telemetry/README.md) | Docker log collection and OTLP ingestion | Private only | Not listed |
| [Open WebUI](openwebui/README.md) | Browser interface for the llama.cpp API | `webui.${DOMAIN}` | AI |
| [Pi-hole](pi-hole/README.md) | Network-wide DNS filtering | `pihole.${DOMAIN}` | Management |
| [Prometheus](prometheus/README.md) | Metrics collection and querying | `prometheus.${DOMAIN}` | Monitoring |
| [Reactive Resume](reactive-resume/README.md) | Resume builder | `resume.${DOMAIN}` | Productivity |
| [SearXNG](searxng/README.md) | Privacy-respecting metasearch | `searxng.${DOMAIN}` | Search |
| [Self-heal](self-heal/README.md) | Grafana alerts diagnosed by the read-only Hermes `devops-diagnose` profile (host, container, metric and log tools); container restarts only after approval in Talk (`fix`, optional TOTP) | Private only | Not listed |
| [Tandoor Recipes](tandoor-recipes/README.md) | Recipe management | `tandoor.${DOMAIN}` | Food |
| [Unsloth Studio](unsloth-studio/README.md) | GPU-backed model training workspace | `unsloth.${DOMAIN}` | AI |
| [Uptime Kuma](uptime-kuma/README.md) | Uptime monitoring with AutoKuma discovery | `uptime-kuma.${DOMAIN}` | Monitoring |
| [Vaultwarden](vaultwarden/README.md) | Bitwarden-compatible password management | `vaultwarden.${DOMAIN}` | Security |
| [wger](wger/README.md) | Workout and nutrition tracking | `wger.${DOMAIN}` | Food |

**Projects and the Hermes sandbox:** `~/docker/projects` holds normal projects (each its own git repository and Compose stack, served at `<name>.${DOMAIN}`); `~/docker/hermes-sandbox` is the global sandbox launcher (`hermes-sandbox [coder|devops]`) for the CLI-only Hermes coding and devops profiles. Neither is part of this repository; see their READMEs.

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

## Scripts

- `scripts/update-domain.sh DOMAIN` sets `DOMAIN=` in every stack `.env` and `.env.example`.
- `scripts/setup-env.sh [--dry-run] [--root DIR] [FOLDER ...]` creates or
  completes each stack's `.env` from its `.env.example` (mode 600). It
  generates API tokens, secret keys and internal passwords in the format the
  example documents (default `openssl rand -hex 32`), keeps secrets that must
  match across stacks identical (for example `LLAMA_API_KEY`, the `SELF_HEAL_*`
  secrets, `TALK_DELIVER_SECRET`, `N8N_MCP_AUTH_TOKEN`), and asks for
  usernames, e-mail addresses, login passwords (empty answer generates one) and
  the tokens only an application UI can issue (Enter skips; a hint says where
  to create each). It never changes a value that is already set (anything but
  empty or `CHANGE_ME*`), appends keys missing from an existing `.env`, saves
  `.env.bak.<timestamp>` before changing one, never prints a value, and a second
  run changes nothing. `--dry-run` lists what would be generated, copied,
  prompted or skipped. Without a terminal it skips prompts and lists those keys
  as unresolved; re-run it later in a terminal. Rerun it after creating UI
  tokens or adding stacks.
- `scripts/reset-n8n-password.sh [EMAIL]` sets a new n8n password (owner by
  default) straight in its database; the password is read silently and never
  printed.
- `scripts/rotate-api-keys.sh [--dry-run] [--restart] [KEY ...]` replaces the
  self-generated API keys and shared bearer tokens (`--list` shows them) with
  new random hex values in every stack `.env` that holds them, without printing
  any value, then prints (or with `--restart` runs) the stack recreates and the
  n8n credential re-import. Keys issued by other services (`HF_TOKEN`,
  `N8N_API_KEY`, Firefly and wger tokens, the Nextcloud app password, the Talk
  bot secret) and stateful secrets (database passwords, encryption keys) are
  rotated by hand.

## Observability startup order

Compose projects cannot enforce startup ordering across service folders. For a clean observability startup, launch:

1. Loki and Node Exporter.
2. Prometheus and OpenTelemetry Collector.
3. Grafana.

Temporary downstream failures are safe because the long-running containers restart automatically.
