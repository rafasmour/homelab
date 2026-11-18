# Grafana

## Description

Observability dashboards at `https://grafana.${DOMAIN}`.

## Setup

Ensure `webgateway` exists, copy `.env.example` to `.env`, set the admin password, and run `docker compose --env-file .env up -d`. Prometheus and Loki are provisioned automatically as data sources and resolve over `webgateway`; start those stacks to make the data sources healthy.

The provisioned **Homelab / Container Health** dashboard shows every Uptime Kuma Docker monitor and maps its current `monitor_status` value to a color-coded health state.

## Alerting

Alerts are provisioned from `provisioning/alerting/`. **No notification channel is provisioned:** the Nextcloud Talk contact point was removed together with the Talk bridge, so alerts are evaluated and shown in the Grafana UI but notify nobody. The root notification policy uses Grafana's built-in `grafana-default-email` contact point (no address set). Add a contact point of your choice in `provisioning/alerting/` and point the root policy at it to be notified.

- `n8n-drift-contact-point.yml`: the `n8n drift runner` webhook contact point (Bearer `N8N_DRIFT_WEBHOOK_SECRET`) and the notification policy: rules labelled `n8n_drift_run="true"` go only there, everything else goes to the root receiver. The previously provisioned `Nextcloud Talk` and `Self-heal` contact points stay in Grafana's database until you delete them in the UI or API; nothing routes to them any more.
- `homelab-rules.yml`: 28 Grafana-managed rules in the **Homelab alerts** folder.

| Group | Rules |
|---|---|
| Temperatures | CPU Tdie (`k10temp` temp2; the 1800X Tctl reads 20 °C high) > 80 °C warning, > 90 °C critical; any sensor with a hardware critical limit (GPU edge/junction/memory, NVMe) within 15 °C (warning) or 8 °C (critical) of it |
| Storage | free space < 10 % / < 5 %, predicted full within 24 h, inodes < 10 %, filesystem read-only, I/O pressure > 30 % |
| Memory and CPU | available RAM < 10 % / < 5 %, swap > 80 %, any OOM kill, memory pressure > 10 %, 15-minute load > 1.5× threads |
| Containers (from `docker-state-exporter`) | a container with restart policy `always`/`unless-stopped` not running for 2 min, a one-shot container exiting non-zero, more than 2 restarts in 15 min, health check failing for 3 min, last stop was an OOM kill |
| Host and services | host rebooted, clock not NTP-synced, Prometheus target down, Uptime Kuma monitor down |
| AI services (Loki) | `llama-server` logs `Could not establish connection` more than twice in 10 min for 5 min: the router is proxying to a dead model instance (critical); Hermes cron jobs failing (`ERROR cron.scheduler: Job … failed`, > 5 lines in 1 h, i.e. at least two failed runs; warning) |

Not covered: EDAC memory errors and RAID (no such devices), and host network links (node-exporter runs in its own network namespace, so its `eth0` is the container's).

Rules and the contact point are file-provisioned, so they are read-only in the UI; edit the YAML and restart Grafana.

## Backup and important notes

Back up `.env` and `data`. The tracked `provisioning` directory is declarative configuration and belongs in Git.
