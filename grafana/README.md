# Grafana

## Description

Observability dashboards at `https://grafana.${DOMAIN}`.

## Setup

Ensure `webgateway` exists, copy `.env.example` to `.env`, set the admin password, and run `docker compose --env-file .env up -d`. Prometheus and Loki are provisioned automatically as data sources and resolve over `webgateway`; start those stacks to make the data sources healthy.

The provisioned **Homelab / Container Health** dashboard shows every Uptime Kuma Docker monitor and maps its current `monitor_status` value to a color-coded health state.

## Alerting to Nextcloud Talk

Alerts are provisioned from `provisioning/alerting/` and posted by the Hermes bot into the **Grafana alerts** Talk room (🚨, red) through `http://hermes-nextcloud-bridge:8788/deliver`. Grafana and the bridge share the `webgateway` network.

- `talk-contact-point.yml`: the `Nextcloud Talk` webhook contact point (Bearer `TALK_DELIVER_SECRET`, custom JSON payload with `room_token` = `TALK_ALERTS_ROOM`), the message template, and the notification policy. Warnings repeat every 12 hours, critical alerts (stopped, restarting or unhealthy containers included) every hour as reminders, until resolved.
- `homelab-rules.yml`: 25 Grafana-managed rules in the **Homelab alerts** folder.

| Group | Rules |
|---|---|
| Temperatures | CPU Tdie (`k10temp` temp2; the 1800X Tctl reads 20 °C high) > 80 °C warning, > 90 °C critical; any sensor with a hardware critical limit (GPU edge/junction/memory, NVMe) within 15 °C (warning) or 8 °C (critical) of it |
| Storage | free space < 10 % / < 5 %, predicted full within 24 h, inodes < 10 %, filesystem read-only, I/O pressure > 30 % |
| Memory and CPU | available RAM < 10 % / < 5 %, swap > 80 %, any OOM kill, memory pressure > 10 %, 15-minute load > 1.5× threads |
| Containers (from `docker-state-exporter`) | a container with restart policy `always`/`unless-stopped` not running for 2 min, a one-shot container exiting non-zero, more than 2 restarts in 15 min, health check failing for 3 min, last stop was an OOM kill |
| Host and services | host rebooted, clock not NTP-synced, Prometheus target down, Uptime Kuma monitor down |

Not covered: EDAC memory errors and RAID (no such devices), and host network links (node-exporter runs in its own network namespace, so its `eth0` is the container's).

Rules and the contact point are file-provisioned, so they are read-only in the UI; edit the YAML and restart Grafana. Copy `TALK_DELIVER_SECRET` from `hermes-nextcloud-bridge/.env` and the room token into `.env`. To create the room on a new install, see `hermes-nextcloud-bridge/README.md` (one room per profile).

## Backup and important notes

Back up `.env` and `data`. The tracked `provisioning` directory is declarative configuration and belongs in Git.
