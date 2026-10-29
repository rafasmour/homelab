# Self-heal

Approval-gated remediation for Grafana alerts. An alert that carries the label `self_heal="true"` is diagnosed by the Hermes profile `devops-diagnose` with read-only tools; the controller posts the diagnosis and a proposed action to a dedicated Talk room, and the owner approves it by replying `fix` in that room (optionally also with an authenticator code, see `SELF_HEAL_REQUIRE_TOTP`). The only action is restarting an allowlisted container. Nothing in this stack is published on the host or routed by Traefik.

| Container | Role | Port | Networks |
| --- | --- | --- | --- |
| `self-heal` | controller (Python standard library), the only container that can act | 8790 | `self-heal-ingress`, `self-heal-agent`, `self-heal-exec` |
| `self-heal-diagnose-mcp` | read-only MCP server for `devops-diagnose` (`/mcp`) | 8791 | `self-heal-agent`, `self-heal-diag` |
| `self-heal-docker-ro-proxy` | HAProxy: GET-only Docker API (list, version, logs of `DIAG_LOG_CONTAINERS`) | 2375 | `self-heal-diag` |
| `self-heal-query-proxy` | HAProxy: GET-only Prometheus/Loki query endpoints | 8080 | `self-heal-diag`, `webgateway` (to reach `prometheus` and `loki`; no Traefik route) |
| `self-heal-restart-proxy` | HAProxy: `POST /containers/<allowed>/restart` and `GET /_ping` only | 2375 | `self-heal-exec` |
| `self-heal-host-probe` | fixed host memory/swap/PSI/cgroup/GPU snapshots | 8792 | `self-heal-diag` |

Every container runs with a read-only root filesystem, no capabilities, `no-new-privileges`, and CPU, memory and PID limits. Only the two Docker proxies mount the Docker socket; only `self-heal-host-probe` mounts host `/proc` and `/sys`. All four networks are internal (no internet).

## Flow and trust boundaries

```text
 grafana ──POST /grafana (webhook secret)──┐
   ▲  GET alerts by fingerprint (Viewer)   │          network self-heal-ingress (internal)
   └───────────────────────────────────────┤
 hermes-nextcloud-bridge ◄──POST /deliver──┤          Talk room: owner + Hermes bot only
   └──POST /approve (approve secret)──────►│
                                     ┌─────┴──────┐
                                     │ self-heal  │  allowlist, (TOTP secret), state in ./data
                                     └──┬──────┬──┘
     network self-heal-agent (internal) │      │ network self-heal-exec (internal)
                                        ▼      ▼
   hermes-api (/p/devops-diagnose, own key)   self-heal-restart-proxy ──► docker.sock
        │ MCP, DIAGNOSE_MCP_TOKEN              (POST restart of SELF_HEAL_RESTART_ALLOWLIST only)
        ▼
   self-heal-diagnose-mcp ── parses model-controlled arguments; no socket, no host mounts
        │ network self-heal-diag (internal)
        ├──► self-heal-docker-ro-proxy ──► docker.sock (GET list/version/logs of DIAG_LOG_CONTAINERS)
        ├──► self-heal-query-proxy ──webgateway──► prometheus:9090, loki:3100 (GET queries)
        └──► self-heal-host-probe (HOST_PROBE_TOKEN) ── host /proc, /sys read-only, uid 65534
```

1. Grafana sends the webhook to `POST /grafana`. The controller answers 202 at once and only takes each alert's fingerprint from the payload: it re-fetches the alert from Grafana's Alertmanager API and drops it unless it is still active and labelled `self_heal="true"`.
2. Per alert fingerprint at most one diagnosis per `SELF_HEAL_COOLDOWN_SECONDS` (1 h), at most `SELF_HEAL_MAX_RUNS_PER_HOUR` (4) diagnoses per hour, one at a time, at most 5 queued; everything else is dropped and logged.
3. The controller calls `devops-diagnose` with the alert's labels and annotations, marked as untrusted data. The profile has only the `diagnose` MCP tools (and `clock`): `container_list`, `container_logs`, `prom_query`, `loki_query`, `compose_file`, `host_overview`, `host_memory`, `host_processes`, `host_cgroups`, `host_gpu`. It must answer with one JSON object (`summary`, `evidence`, `proposed_action`, `confidence`).
4. The controller validates the answer strictly (keys, types, lengths, enums). Anything invalid becomes "no action". A `restart_container` whose target does not fully match `SELF_HEAL_RESTART_ALLOWLIST` is downgraded to "no action" with a note.
5. The report goes to the Talk room through the bridge's `/deliver`, sanitized: secret-shaped strings are redacted; URLs, markdown links and images, HTML, mentions, control and bidi characters and anything resembling a `/heal` command are removed; lengths are capped. A proposed restart gets a 6-character run id.
6. The owner replies `fix` (or `fix <code>` with TOTP on, or `deny`). The bridge forwards the command to `POST /approve`; the controller resolves the single open run, checks the room, the owner's actor id, the run's state and expiry and, when `SELF_HEAL_REQUIRE_TOTP=1`, the TOTP code, then calls the restart proxy and posts the outcome.

## Threat model

The model is treated as fully prompt-injected: logs, alert annotations and metric labels can be written by an attacker. n8n, Nextcloud, the bridge and `hermes-api` may be compromised. Safety comes from what each component can reach, not from the model behaving.

| Compromised component | What the attacker gets |
| --- | --- |
| n8n | Nothing: n8n shares no network with the controller and holds none of its secrets. |
| Grafana, or the webhook secret | Diagnoses of alerts that really are active and labelled `self_heal` (the controller re-fetches them), within the rate limits; approval requests in the Talk room. With TOTP on, no action without the owner's code; with TOTP off, no action without a message from the owner's Talk actor in the room. |
| Prompt-injected model (`devops-diagnose`) | Reads what the read-only tools allow (container list, logs of `DIAG_LOG_CONTAINERS`, Prometheus/Loki queries, committed compose files, fixed host statistics); proposes a catalog action. It cannot run anything, and its proposal still needs the owner's approval. It cannot approve: its Talk posts carry a bot actor (rejected by the bridge and the controller), and it does not hold the bot secret that signs `/hook` webhooks. |
| Nextcloud, the bridge, or `hermes-api` | Spam in the Talk room; with `SELF_HEAL_REQUIRE_TOTP=1` forged `/approve` calls fail without a valid, unused TOTP code (three wrong codes lock the run). **With `SELF_HEAL_REQUIRE_TOTP=0` (chat-only approval), anyone who controls the owner's Nextcloud account, the bridge, or the Talk bot secret can approve a proposed restart of an allowlisted container.** They still cannot choose the action or target: the controller only acts on runs it created itself from an alert it re-fetched from Grafana, and the restart proxy enforces the allowlist. `hermes-api` can query the diagnose tools like the model can. |
| `self-heal-host-probe` | Fixed host statistics (memory, swap, PSI, per-container memory, GPU). As uid 65534 without capabilities it cannot read other users' process environments; the Docker socket and network egress are absent. |
| `self-heal-diagnose-mcp` | The GET-only proxies and host-probe: container list and allowed logs, metrics and log queries, host statistics. No inspect (container environments), no exec, no writes. |
| `self-heal` (controller) | Restarts of containers in `SELF_HEAL_RESTART_ALLOWLIST` (enforced again by `self-heal-restart-proxy`), Talk messages in the self-heal room, read access to active alerts in Grafana. |

Secrets that grant more than read access exist in one place each: the TOTP secret (used only with `SELF_HEAL_REQUIRE_TOTP=1`) only in `self-heal/.env` and the owner's authenticator; the Docker socket only in the two proxies, which permit fixed request shapes.

## Host diagnostics

Some problems are only visible on the host, for example swap filling up while llama.cpp loads a model, or the OOM killer stopping a container. `self-heal-host-probe` reads host `/proc` and `/sys` (both read-only) and answers five fixed GET endpoints (`/overview`, `/memory`, `/processes`, `/cgroups`, `/gpu`) with selected fields: meminfo, swap devices and zram, pressure stall information, swap-in/out and major-fault rates, the top processes by RSS plus swap (command name only, mapped to a container), per-container memory, swap, limits and OOM events, and AMD GPU VRAM/GTT use. It never reads command lines, environments, memory maps or file descriptors, because command lines carry secrets (`llama-server --api-key`).

The host mounts live only in host-probe, never in the MCP server: the MCP server parses arguments chosen by the model, and a path or parsing bug there must not reach the host's `/proc`. host-probe takes no parameters at all. The MCP tools `host_*` call it with `HOST_PROBE_TOKEN` and add container names from the read-only Docker proxy.

## Setup

1. **Talk room.** Create a conversation in Nextcloud Talk that contains only you and the Hermes bot, and note its token (the part after `/call/` in the room URL). Nobody else may be a participant: the room is where approvals are given.

2. **Environment.** Create `.env` and the state folder:

   ```sh
   cp self-heal/.env.example self-heal/.env
   mkdir -p self-heal/data   # must be writable by SELF_HEAL_UID (default 1000)
   ```

   Generate each `CHANGE_ME` secret with `openssl rand -hex 32` and copy the shared ones into the other stacks (same name, same value):

   | Variable | Also in |
   | --- | --- |
   | `SELF_HEAL_WEBHOOK_SECRET` | `grafana/.env` |
   | `SELF_HEAL_APPROVE_SECRET` | `hermes-nextcloud-bridge/.env` |
   | `SELF_HEAL_HERMES_KEY` | `hermes/.env` |
   | `DIAGNOSE_MCP_TOKEN` | `hermes/.env` |
   | `TALK_DELIVER_SECRET` | `hermes-nextcloud-bridge/.env` (existing value) |
   | `TALK_SELF_HEAL_ROOM` (room token) | `hermes-nextcloud-bridge/.env` |

   `HOST_PROBE_TOKEN` and `SELF_HEAL_TOTP_SECRET` stay in `self-heal/.env` only. Set `SELF_HEAL_OWNER_ACTOR` to `users/<your Nextcloud user id>`, and review `DIAG_LOG_CONTAINERS` and `SELF_HEAL_RESTART_ALLOWLIST` against `docker ps --format '{{.Names}}'`. Both are required regex alternations and are matched against the whole container name.

3. **Approval factor.** `SELF_HEAL_REQUIRE_TOTP=0` (the example default) means a reply of `fix` in the self-heal room is enough; the room, the owner's actor id (`SELF_HEAL_OWNER_ACTOR`), the run's state and expiry and the allowlist are still enforced. For a second factor set `SELF_HEAL_REQUIRE_TOTP=1`, generate a secret, put it in `SELF_HEAL_TOTP_SECRET` (the variable must be set in both modes) and add it to an authenticator app (SHA1, 30 seconds, 6 digits). Do not paste the secret into shared terminals or screenshots:

   ```sh
   python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode())'
   ```

4. **Grafana service account.** In Grafana, Administration → Users and access → Service accounts, create `self-heal` with the **Viewer** role, add a token and put it in `SELF_HEAL_GRAFANA_TOKEN`. The controller only reads alerts with it.

5. **Start self-heal first.** The stack creates the `self-heal-ingress` and `self-heal-agent` networks, which `grafana`, `hermes-api` and `hermes-nextcloud-bridge` join only through their opt-in `docker-compose.self-heal.yml` overrides (without the override those stacks run fine, just without self-heal):

   ```sh
   docker compose --env-file self-heal/.env -f self-heal/docker-compose.yml build
   docker compose --env-file self-heal/.env -f self-heal/docker-compose.yml up -d
   ```

   Then recreate the three stacks with their override:

   ```sh
   for s in grafana hermes hermes-nextcloud-bridge; do
     docker compose --env-file $s/.env -f $s/docker-compose.yml -f $s/docker-compose.self-heal.yml up -d
   done
   ```

   Always pass the override for these stacks from then on, or they drop off the self-heal networks.

## Using it

A proposed restart looks like this in the room (TOTP off):

```text
Self-heal: Container restart loop (run K7Q2MX)
...
Proposed action: restart container drawio
Reply fix to restart drawio, or deny. Valid for 15 minutes. (Run K7Q2MX; with several open runs use /heal approve K7Q2MX.)
```

- `fix`, `yes`, `approve` or `/heal approve` approves the single open run; `deny`, `no` or `/heal deny` denies it. The controller restarts the container through the restart proxy and posts the result. A run can be decided once.
- With TOTP on (`SELF_HEAL_REQUIRE_TOTP=1`) the reply carries the code: `fix 123456` (also `approve 123456` or `/heal 123456`). It is checked for the current 30-second step ± 1; each code works once (used steps are stored), and three wrong codes lock the run.
- With more than one open run the controller answers with the open run IDs and their targets; use `/heal approve K7Q2MX` (plus the code with TOTP on) or `/heal deny K7Q2MX`. The explicit form always works.
- The bridge forwards only these exact patterns, only from the self-heal room, only from human (non-bot) actors. Any other message in that room is not forwarded and never reaches a Hermes profile; it only gets a one-line usage hint. The controller checks room, owner actor, run state and expiry on every request, whatever form was used.
- Runs expire after `SELF_HEAL_APPROVAL_TTL_SECONDS` (15 minutes); the controller posts a notice.
- A diagnosis with no action (or an invalid answer, or a target outside the allowlist) is posted as a report only.

**Kill switch:** set `SELF_HEAL_ENABLED=0` and recreate `self-heal`. Alerts are then only logged, and approvals are refused (`/heal deny` still works).

**Audit log:** the controller writes one JSON line per event to stdout (`alert_received`, `alert_queued`, `alert_dropped` with a reason, `diagnosis_started`, `diagnosis_done`, `diagnosis_failed`, `approval_rejected` with a reason, `approval_accepted`, `run_denied`, `run_locked`, `run_expired`, `action_executed`, `action_failed`). Codes and secrets are never logged.

```sh
docker logs self-heal
```

## Testing the flow

`docker-compose.test.yml` is an opt-in busybox container, `self-heal-test` (no network, read-only, no capabilities, tmpfs `/tmp`), listed in `SELF_HEAL_RESTART_ALLOWLIST`. Its health check fails while `/tmp/broken` exists, so `container-unhealthy` (3 minutes) fires a real alert; a restart clears the tmpfs.

```sh
docker compose -f self-heal/docker-compose.test.yml up -d
docker exec self-heal-test touch /tmp/broken     # break it
# wait ~4-6 minutes for the alert and the diagnosis in the Talk room, then reply: fix
docker compose -f self-heal/docker-compose.test.yml down   # clean up
```

The controller re-fetches alerts from Grafana, so a hand-made webhook is dropped by design; break the container instead. After cleaning up, remove `self-heal-test` from `SELF_HEAL_RESTART_ALLOWLIST` and recreate `self-heal` and `self-heal-restart-proxy`.

## Backups

`self-heal/data/state.json` holds the runs of the last 14 days, recently used TOTP time steps and the rate-limit counters. It contains no secrets. Losing it only drops pending approvals.

## Limitations

- `compose_file` reads compose files from the repository's Git objects (`../.git`, read-only), so the agent sees committed files only, not uncommitted changes.
- `restart_container` is the only action. Anything else (config changes, pruning, recreating stacks) stays manual.
- The model is untrusted. Its diagnosis can be wrong or manipulated; read the evidence before approving.
- The restart proxy cannot tell why it is called: with the controller compromised, any container in `SELF_HEAL_RESTART_ALLOWLIST` can be restarted without approval. The default allows every container except the self-heal stack, so the worst case is restarts (downtime), never data access or code execution; narrow it to an alternation of names to limit that.
- `PYTHON_VERSION` sets the controller's base image; `diagnose-mcp` and `host-probe` pin theirs in their Dockerfiles.
