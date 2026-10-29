# n8n drift runner

Tiny webhook runner for `n8n/scripts/check-workflow-drift.sh`, replacing cron. Grafana's rule "n8n drift check not running" (`grafana/provisioning/alerting/n8n-drift-rules.yml`) posts to `http://n8n-drift-runner:8791/run`; the runner executes the script, which reads n8n through its REST API and rewrites `node-exporter/textfile/n8n_drift.prom`. Setup, metrics and manual use are in `../n8n/README.md` ("Workflow drift check").

- Auto-export (`N8N_DRIFT_AUTO_EXPORT=1`, default): when a workflow's saved draft in n8n differs from its file, the script writes the n8n version over `n8n/workflows/<file>.json` (working tree only, nothing is committed). That run still reports the drift, so Grafana posts one Talk alert saying it was exported; review with `git diff n8n/workflows`, then commit, or revert the file and re-import it. Untracked and missing workflows are never written. Check exported files for secrets typed directly into node parameters before committing.
- No Docker socket. Mounts: `n8n/scripts/check-workflow-drift.sh` read-only, `n8n/workflows` and `node-exporter/textfile` read-write. Read-only root filesystem, no capabilities.
- Only network: internal `n8n-drift` (created here; n8n and Grafana join through their `docker-compose.n8n-drift.yml` overrides). Not routed by Traefik, nothing published on the host.
- Authentication: `Authorization: Bearer $N8N_DRIFT_WEBHOOK_SECRET` is required. The request body is ignored, so no input reaches the script.
- One run at a time, at least 5 minutes between runs (`N8N_DRIFT_MIN_INTERVAL`, seconds); extra requests get HTTP 200 and are skipped. One log line per run: `docker logs n8n-drift-runner`.
- n8n API key: only `workflow:list` and `workflow:read`. It is the only credential in `.env` besides the webhook secret.
- No administrator account and no state to back up; the output file is regenerated on every run.
