# After the benchmarks

Everything that is built (or decided) but waits until the llama.cpp model
benchmarks are finished. The benchmark run holds the GPU, `hermes-api` and
the WireGuard uplink, and the host has a marginal 600 W PSU, so these steps
run one at a time afterwards. The main session works through this list with
subagents; tick items off here as they land.

Started 2026-10-27. Progress of the benchmarks themselves:
[`llama-cpp/models/model-eval.md`](llama-cpp/models/model-eval.md).

Legend: **Owner** is the subagent role that does the work. **You** marks a
step only the owner of the homelab can do (sudo, physical, UI, phone,
secrets).

## 0. Gate: benchmarks finished

- [x] Download/benchmark agent reported "ALL BENCHMARKS DONE" (2026-10-27
  16:37 UTC). Ornith 1.5 35B-A3B and Spark-X2.6 stay blocked (see 6).
  All tok/s figures are pre-power-limit; re-measure after section 1 with
  `bash /tmp/claude-1000/-home-tom-docker-homelab/a18606f3-3829-413f-8326-28937325aeca/scratchpad/bin/measure.sh ornith-1.5-9b 1,3 3`.
- [x] Router idle, no run lock.

## 1. Host safety (first, before any other heavy step)

Owner: you (sudo / physical), then the main session verifies.

- [x] Run the CPU/GPU power-limit installer (applied 2026-10-28, verified):
  `sudo sh /tmp/claude-1000/-home-tom-docker-homelab/a18606f3-3829-413f-8326-28937325aeca/scratchpad/hw/install.sh`
  (GPU 231 W cap + 2300 MHz max clock, CPU boost off + 3.2 GHz, re-applied
  every 2 min by `hw-limits.timer`).
- [x] Grow swap from 4 GiB to 16 GiB (or add zram) and install `earlyoom`. Done 2026-10-28 (/swapfile 16G, earlyoom active).
- [ ] Reseat the SATA power and data cables of `sdc` (`/mnt/htd`, link resets
  since the GPU swap on 2026-10-22).
- [ ] BIOS: "Power Supply Idle Control = Typical Current Idle"; consider an
  update.
- [ ] Optional: `kernel.softlockup_panic=1`, `kernel.hardlockup_panic=1`,
  `kernel.panic=10` so a hang leaves a kdump and reboots.
- [ ] Later: a 750-850 W ATX 3.x PSU (the real fix).

Details: crash report in the scratchpad (`crash-report.md`).

## 2. Restarts that pick up finished work

Owner: main session (compose commands below, one at a time, logs checked
after each).
  (2026-10-27: no NUL bytes left in any listed json log; nothing more to do. Hermes now runs `ornith-1.5-9b`, 64k.)

- [x] Benchmark runner with the mock Talk room (`BENCHMARK_TALK_ROOM` is
  already in `benchmark/.env`):
  `docker compose --env-file benchmark/.env -f benchmark/docker-compose.yml up -d --build benchmark`
- [x] Hermes (Qwen 3.6 35B-A3B as `HERMES_MODEL`, `voice` profile with its own
  key, `talk_send` benchmark mode; no self-heal override yet):
  `docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d`
  (2026-10-27: gateway up, `voice` served and 401 without key,
  devops-diagnose not served as expected.)
  Recreated again: now `HERMES_MODEL=ornith-1.5-9b`, context 65536 (digest/router keep lfm-2.5-2.6b).
- [x] Home Assistant (update to 2026.10+, Kokoro TTS, Whisper `base.en` with
  the offline download job):
  `docker compose --env-file home-assistant/.env -f home-assistant/docker-compose.yml pull`
  then `... up -d`
- [x] node-exporter (textfile collector for the n8n drift metrics):
  `docker compose --env-file node-exporter/.env -f node-exporter/docker-compose.yml up -d --force-recreate`
- [x] Grafana (n8n drift rules, `self_heal` labels, Self-heal contact point;
  webhook errors for `self_heal` alerts are expected until 4):
  `docker compose --env-file grafana/.env -f grafana/docker-compose.yml up -d`
- [x] Recreate the containers whose Docker logs were corrupted by the crash
  (llama-server, uptime-kuma, n8n-mcp, sbx-socket-proxy,
  homepage-docker-proxy, wger, loki, grafana, wger-database, excalidraw,
  otel-docker-proxy, otel-collector, nextcloud, wger-mcp), at a quiet time.
  2026-10-27: no NUL bytes in any listed json log (LogPath is under /data/docker); nothing left to recreate.

## 3. Voice assistant (Home Assistant + Hermes `voice`)

Owner: HA voice agent (done: server side). Remaining steps are yours; full
text in [`home-assistant/README.md`](home-assistant/README.md).

- [ ] You: install HACS, add the Wyoming integrations (whisper 10300,
  kokoro 10300, piper 10200), install Extended OpenAI Conversation
  (base URL `http://hermes-api:8642/p/voice/v1`, model `voice`, key
  `HERMES_VOICE_KEY` from `hermes/.env`, functions `[]`).
- [ ] You: create the "Hermes" Assist pipeline (English, faster-whisper,
  Kokoro `af_heart`), set it preferred.
- [ ] You (phone): Companion app as default assistant, wake word
  ("Okay Nabu" / "Hey Jarvis" / "Hey Mycroft"), battery Unrestricted.

## 4. Self-heal (alert → diagnosis → TOTP-approved restart)

Owner: self-heal agents (done: stack, diagnose MCP, host probe, integration).
Also a to-do in Nextcloud ("Homelab" list). Full steps:
[`self-heal/README.md`](self-heal/README.md).

- [x] You: `self-heal/.env` (secrets, TOTP enrolment, `SELF_HEAL_OWNER_ACTOR=users/pi.hole`),
  Grafana Viewer service-account token, private Talk room with the Hermes bot.
  Done by agent: `self-heal/.env`, Viewer token (service account `self-heal`), room `ieyp5baa` (pi.hole + Hermes bot). TOTP QR: scratchpad `self-heal-totp.png`; you must scan it, then delete it.
- [x] Copy the shared secrets into `hermes/.env`, `grafana/.env`,
  `hermes-nextcloud-bridge/.env`.
- [x] `mkdir -p self-heal/data` and start the stack (`up -d --build`).
  Six containers healthy.
- [x] Recreate grafana, hermes and hermes-nextcloud-bridge **with**
  `-f docker-compose.self-heal.yml` (the bridge also needs `--build` for the
  `/heal` patch).
  devops-diagnose served (401 without key); bridge has heal_forward and the uid-1000 passwd fix.
- [ ] Review together: test alert → diagnosis in Talk → `/heal deny`.

## 5. n8n workflows

Owner: n8n agent (done: drift check, Firefly fix).

- [ ] You: set up the drift check (no cron; a Grafana alert triggers it). Create an
  n8n API key with only `workflow:list` + `workflow:read`, put it as
  `N8N_DRIFT_API_KEY` and a shared `N8N_DRIFT_WEBHOOK_SECRET` (`openssl rand -hex 32`)
  in `n8n-drift-runner/.env`, the secret also in `grafana/.env`, then bring up
  the runner and recreate n8n and Grafana with their `docker-compose.n8n-drift.yml`
  overrides (commands in `n8n/README.md`, "Workflow drift check").
- [x] Re-import the Hermes digests (git is ahead of n8n, and four now use
  the new model): `sh n8n/scripts/hermes-digests-setup.sh` (restarts n8n).
  Done 2026-10-27; drift now only Piraeus.
- [ ] Piraeus workflow drift: compare `--diff 7f3a9c2e-…`, keep live or git.
  Note: Live draft has an extra Gmail "Get a message" node after the trigger (credential attached) and different trigger filters; git lacks it. Decision still yours.
- [ ] Firefly → Payments calendar: credential + test run
  (`sh n8n/scripts/firefly-subscriptions-setup.sh`, then
  `docker exec -e N8N_RUNNERS_BROKER_PORT=5699 n8n n8n execute --id=6c2e9b14-8d57-4a31-b0f6-3e8a1d5c7b92`
  twice), then `--publish`.
  Note: Credential + workflow imported (inactive). `n8n execute` fails: "Missing node to start execution" (schedule trigger only), so no test run; needs a manual trigger or a publish first.

## 6. llama.cpp follow-ups

Owner: download/benchmark agent, then a llama.cpp config agent.

- [ ] You: pick the Hermes model from the results (baseline Qwen 3.6 35B-A3B:
  79.0, 1 slot). `qwen-3.5-9b` 90.0 and `ornith-1.5-9b` 88.0, each 3 × 64k,
  ~60 tok/s single and ~107-110 tok/s total; `ling-3.0-tiny` 75.8 but
  8 × 128k and 393 tok/s total. Also set `PRODUCTION_MODEL` in
  `benchmark/.env` to the chosen model (it still names the deleted Mellum).
- [ ] Then `--models-max 2` (agent model + a small second model) once VRAM
  allows; lower `cache-ram`; a `mem_limit` on llama-server.
- [ ] Blocked until swap is enlarged: Ornith 1.5 35B-A3B (experts in RAM).
- [ ] Blocked on llama.cpp build: Spark-X2.6 (`spark2_5` arch needs the
  patched build); EmbeddingGemma 2 runs on the CPU router meanwhile.
- [ ] Research candidates not yet requested (Nemotron 3.5 Bolt E4B,
  Qwen3.5-4B, Nanbeige4.2-3B, ...): see the tracker.
- [ ] Unlimited OCR 2: not now (needs a llama.cpp patch).
- [ ] Benchmark MCP for the Hermes `models` profile: `BENCH_API_TOKEN` and
  `BENCHMARK_MCP_TOKEN` are in `benchmark/.env`, the latter also in
  `hermes/.env`. Run `docker compose -f benchmark/docker-compose.yml up -d
  --build benchmark benchmark-mcp`, then recreate hermes (README of
  `benchmark`, "Benchmark MCP"). Never while a benchmark runs by hand: the
  runner restarts and the lock only covers live runs.

## 7. Documents

Owner: Paperless agent (done: stack, `paperless/.env` generated).
OCR is deferred by choice ("can wait").

- [ ] Create Nextcloud `Scans/`, start `paperless-ngx`, create the API token
  for paperless-gpt, start the rest, add the `occ files:scan` cron, create
  the tagging workflow. Steps: [`paperless/README.md`](paperless/README.md).
- [ ] Later: `doc-search` (Paperless text → EmbeddingGemma 2 on the CPU
  router → pgvector → MCP tool for Hermes).
- [ ] Google Drive → Nextcloud with rclone; Google Photos → Immich with
  immich-go (dedupe via checksums + duplicate review).

## 8. Maps (Greece, Cardinal)

Owner: maps agent (stack running since 2026-10-29, Greece extract 2026-10-28).

- [x] Build the Greece data at a quiet time (or on the laptop and copy it):
  `maps/build/build-greece.sh`.
- [x] Start `maps` and check the measured RAM against the estimate
  (measured about 1.2 GB idle, 2026-10-29).
- [ ] You (phone): install Cardinal, point it at `https://maps.<DOMAIN>`
  over WireGuard; CoMaps or OsmAnd with Greece as the offline fallback.
- [ ] Later: Hermes MCP tool for travel times (Valhalla + Pelias).

## 9. Network and Pi-hole

Owner: network agent.

- [ ] Throttle or schedule large downloads; optionally
  `tc qdisc replace dev wg0 root cake bandwidth 40mbit` (you, sudo).
  Ready-to-run commands, persistence, undo steps and `hf` limits are in
  `pi-hole/README.md`. Shaping the download direction needs the VPS end.
- [ ] Consider split-tunnelling the host so bulk downloads skip the VPS.
- [ ] Fallback DNS in the WireGuard client configs (you). Steps and the
  trade-off (fallback queries are unfiltered) are in `pi-hole/README.md`.
- [x] Pi-hole: `oom_score_adj: -500` and a small memory reservation, renew
  the TLS certificate, update to FTL v6.8 / core v6.5. Done 2026-10-27:
  image `2026.10.0` (Core v6.5, Web v6.6.1, FTL v6.8); the certificate was
  reissued and now expires 2026-12-13.
- [ ] Traefik publishes its dashboard port 8080 on a random host port
  (`32768`); remove or bind to 127.0.0.1 if unused. Checked: `api.insecure`
  is off, so nothing listens on 8080. The dashboard is served through
  `traefik.${DOMAIN}` with basic auth, and nothing uses the port. Remove
  `- "8080"` from `/home/tom/docker/traefik/docker-compose.prod.yml`
  (outside this repository), then `docker compose -f docker-compose.prod.yml
  up -d` there.

## 10. Housekeeping

- [ ] n8n's Postgres 16 is outside n8n's supported range; upgrade to 17+
  (not urgent).
- [ ] Commit the work of this session in reviewable chunks (nothing is
  committed yet).
