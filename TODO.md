# Homelab setup checklist

Use this checklist for a fresh installation. Complete the shared prerequisites before starting individual stacks. Each service name links to its detailed setup guide.

## Shared infrastructure

- [X] Install Docker Engine and the Docker Compose plugin.
- [X] Configure DNS for `${DOMAIN}` and all service subdomains in the [service catalog](README.md#service-catalog).
- [X] Deploy Traefik with the `websecure` entrypoint and `myresolver` certificate resolver.
- [X] Review each `.env.example`; generate unique secrets and do not reuse `CHANGE_ME` values.
- [ ] Create a backup destination for `.env` files, databases, uploads, and application data.

## Core and management services

- [X] [Homepage](homepage/README.md): configure the dashboard, start its Docker socket proxy, and verify service discovery.
- [X] [Pi-hole](pi-hole/README.md): confirm host ports are free, configure DNS and credentials, then test filtering and the web route.
- [X] [Uptime Kuma and AutoKuma](uptime-kuma/README.md): create the administrator, configure AutoKuma credentials, and verify discovered monitors.
- [x] [Vaultwarden](vaultwarden/README.md): generate the admin token, create the owner vault, disable signups, and test a backup.

## Observability

- [X] [Loki](loki/README.md): start log storage and secure or remove its unauthenticated public route.
- [X] [Node Exporter](node-exporter/README.md): start host metrics collection and confirm it remains private.
- [X] [Prometheus](prometheus/README.md): start metrics collection and verify the Node Exporter target is healthy.
- [X] [OpenTelemetry Collector](open-telemetry/README.md): verify the Docker log path, start the collector, and confirm logs reach Loki.
- [X] [Grafana](grafana/README.md): set the administrator password, start Grafana, and test the provisioned Prometheus and Loki data sources.

## Knowledge and productivity

- [X] [Excalidraw](excalidraw/README.md): deploy the client and add upstream authentication if the route should be private.
- [X] [Nextcloud](nextcloud/README.md): configure database credentials, complete the browser setup wizard, and configure backups.

## Development and automation

- [X] [n8n](n8n/README.md): set a permanent encryption key, create the owner account, and test database backups.

## Media, food, and finance

- [X] [Immich](immich/README.md): check CPU and memory requirements, create the administrator, then disable setup mode.
- [ ] [Mealie](mealie/README.md): sign in, immediately replace the initial password, and disable signups when ready.

## Search

- [X] [SearXNG](searxng/README.md): generate its secret, deploy the stack, and protect the service upstream if needed.

## Local AI

- [ ] [llama.cpp](llama-cpp/README.md): verify Vulkan and `/dev/dri`, add GGUF models and router presets, build the image, and test `/v1/models`.
- [ ] [Hermes](hermes/README.md): configure the llama.cpp endpoint and provider credentials, then test the API routes.

## Final verification

- [ ] Validate every enabled stack with `docker compose --env-file SERVICE/.env -f SERVICE/docker-compose.yml config --quiet`.
- [ ] Confirm dependency containers have no Traefik routes or host-published web ports.
- [ ] Confirm every public service has valid TLS and the expected authentication controls.
- [ ] Confirm Homepage entries and Uptime Kuma monitors are present.
- [ ] Run a restore test for critical data, especially Vaultwarden, Nextcloud, Immich, GitLab, and database-backed services.
- [ ] Run `git status --short` and confirm no `.env`, model, database, upload, cache, log, or user-content file is tracked.
