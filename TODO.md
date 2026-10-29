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
- [X] [Memos](memos/README.md): start the service, create the host administrator, and review account creation settings.
- [X] [Nextcloud](nextcloud/README.md): configure database credentials, complete the browser setup wizard, and configure backups.
- [X] [Reactive Resume](reactive-resume/README.md): generate secrets, create the owner, and disable public signups.

## Development and automation

- [X] [ChartDB](chartdb/README.md): configure the optional AI key, deploy it, and protect the accountless interface.
- [ ] [GitLab CE](gitlab/README.md): set the root password and SSH port, allow time for startup, and test Git and web access.
- [X] [n8n](n8n/README.md): set a permanent encryption key, create the owner account, and test database backups.

## Media, food, and finance

- [X] [Firefly III](firefly-iii/README.md): configure secrets and site owner, create the first user, and verify the cron task.
- [X] [Immich](immich/README.md): check CPU and memory requirements, create the administrator, then disable setup mode.
- [ ] [Mealie](mealie/README.md): sign in, immediately replace the initial password, and disable signups when ready.
- [ ] [Tandoor Recipes](tandoor-recipes/README.md): configure secrets, start the stack, and create the administrator with the documented command.

## Search

- [X] [SearXNG](searxng/README.md): generate its secret, deploy the stack, and protect the service upstream if needed.

## Local AI

- [ ] [llama.cpp](llama-cpp/README.md): verify Vulkan and `/dev/dri`, add GGUF models and router presets, build the image, and test `/v1/models`.
- [ ] [Open WebUI](openwebui/README.md): start it after llama.cpp and verify model connectivity. Login is disabled.
- [ ] [Hermes](hermes/README.md): configure the llama.cpp endpoint and provider credentials, then test the API routes.
- [ ] [Image Generation](image-generation/README.md): verify Vulkan access, download the required model files, build the image, and generate a test image.
- [ ] [Unsloth Studio](unsloth-studio/README.md): install the NVIDIA runtime, set the Jupyter password, and verify GPU access inside the container.

## Final verification

- [ ] Validate every enabled stack with `docker compose --env-file SERVICE/.env -f SERVICE/docker-compose.yml config --quiet`.
- [ ] Confirm dependency containers have no Traefik routes or host-published web ports.
- [ ] Confirm every public service has valid TLS and the expected authentication controls.
- [ ] Confirm Homepage entries and Uptime Kuma monitors are present.
- [ ] Run a restore test for critical data, especially Vaultwarden, Nextcloud, Immich, GitLab, and database-backed services.
- [ ] Run `git status --short` and confirm no `.env`, model, database, upload, cache, log, or user-content file is tracked.

## After the 2026-10-24 benchmark run

Do these once `benchmark/reports/full-run-3b.log` ends with `Done.` (check that
`docker exec benchmark pgrep -f main.js` returns nothing and no `chat -q` runs in
`hermes-nextcloud-bridge`). Never print `.env` values while doing them.

- [ ] Drop the interrupted hy-memory `cron-gpu-watch` ERROR row (run 2026-10-24_10-39) from `benchmark/data/benchmark.db`, then re-run `docker compose --env-file benchmark/.env -f benchmark/docker-compose.yml run --rm --no-deps benchmark npm run rescore -- 2026-10-24_10-39`. The runner image is already rebuilt (new tasks, content grader, rubric 15/50/20); the long-running `benchmark` container is recreated in the next step.
- [ ] Recreate the stacks that hold the rotated `LLAMA_API_KEY` together: `llama-cpp`, `hermes`, `hermes-sandboxes`, `openwebui`, `benchmark` (commands from `scripts/rotate-api-keys.sh`), plus `hermes-nextcloud-bridge` (sandbox network and local_only plugin).
- [ ] Re-import the n8n credentials (new llama.cpp key and the new "llama.cpp (local, OpenAI-compatible)" credential): `n8n/scripts/hermes-digests-setup.sh --credentials-only`.
- [ ] Check Hermes after the restart: `hermes -p devops config get terminal.backend` is `sandbox_ssh`, plugins `local_only`/`sandbox_terminal` load, and all 16 `/p/<profile>/v1/models` answer 200 from Open WebUI.
- [ ] Owner tests: devops room "using testbed-docker, restart web-ok-web-1" (`/deny`, then `/approve once`); coding room "create a tiny hello project".
- [ ] Write the full model comparison and the chat/cron model recommendation.
- [ ] Fix the prompts behind the common failures ([SILENT] cases, required headings, size limits, tool names in answers, food-log date/meal) in the benchmark tasks, n8n digest prompts and Hermes SOULs; re-run the affected cases.
- [ ] Owner: rotate `HF_TOKEN` on huggingface.co and update `llama-cpp/.env` and `hermes-sandboxes/.env`; create a new `N8N_API_KEY` in n8n and update `n8n/.env`.
- [ ] Commit the pending work as separate features when asked (domain switch, scripts/, Grafana OOM alerts, gemma presets, local_only, sandboxes and profiles, benchmark UI login and redesign, model-run analysis pages, rescoring and content grader, n8n llama credential).
