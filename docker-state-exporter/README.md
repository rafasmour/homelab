# Docker state exporter

## Description

A small Prometheus exporter (Python standard library only) for the state of every container, including stopped ones. cAdvisor and node-exporter only see running containers, so an exited, crash-looping or unhealthy container never looked like a problem. Prometheus scrapes `docker-state-exporter:9417` (job `docker-state`) over `webgateway`, and Grafana alerts on it (see `grafana/README.md`).

| Metric | Meaning |
|---|---|
| `docker_container_running{name}` | 1 when running |
| `docker_container_state{name,state}` | 1 for the current state (`running`, `exited`, `restarting`, ...) |
| `docker_container_health_status{name,health}` | 1 for `healthy`, `unhealthy`, `starting` or `none` |
| `docker_container_restart_count{name}` | Docker's restart counter |
| `docker_container_exit_code{name}` | last exit code |
| `docker_container_oom_killed{name}` | 1 when the last stop was an OOM kill |
| `docker_container_restart_policy{name,policy}` | 1 for the container's restart policy |
| `docker_container_started_at_seconds{name}`, `docker_container_finished_at_seconds{name}` | timestamps |
| `docker_state_exporter_up` | 0 when the Docker API is unreachable |

## Setup

Copy `.env.example` to `.env`, set `DOCKER_SOCKET_GID` to `stat -c %g /var/run/docker.sock`, and run `docker compose --env-file .env up -d --build`. The container runs as `nobody` in the socket's group and only sends GET requests.

## Security

Access to the Docker socket is root-equivalent even when mounted read-only. The exporter has no published port and no Traefik route; only containers on `webgateway` can reach `/metrics`, which lists container names and states but no environment or secrets.
