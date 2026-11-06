# Hindsight

[Hindsight](https://github.com/vectorize-io/hindsight) (Vectorize) agent memory
for the Hermes profiles: facts, entities and consolidated observations in one
shared bank, recalled by semantic + keyword + graph + temporal search.

| Container | Role |
| --- | --- |
| `hindsight` | API (`ghcr.io/vectorize-io/hindsight-api:1.2.0-slim`, port 8888, no UI) |
| `hindsight-db` | PostgreSQL 17 + pgvector 0.8.1, bind mount `./postgres` |
| `hindsight-relay` | nginx egress relay to `llama-server` (:8001) and `llama-classifier` (:8002) |

There is no Traefik route, no Homepage entry and no host port. The API has
**no authentication of its own**; it is reachable only from containers on the
internal `hindsight` network (Hindsight, the relay and `hermes-api`). Do not
publish it without an authentication middleware.

## Privacy and network isolation

* `hindsight` and `hindsight-db` are on `internal: true` networks (`backend`,
  `hindsight`): no default route, no DNS for the internet. Verified with
  `docker exec hindsight python -c "import socket; socket.create_connection(('1.1.1.1',443),4)"`
  (Network is unreachable).
* Only `hindsight-relay` also joins `webgateway`; its `nginx.conf` forwards two
  fixed ports to two fixed upstreams.
* The 1.2.0 server source contains no analytics, crash reporting or update
  check (no PostHog, Sentry, Segment). The only outbound-capable code paths are
  opt-in and are disabled or unused here: OpenTelemetry OTLP export
  (`HINDSIGHT_API_OTEL_TRACES_ENABLED=false`, the default), the Hindsight Cloud
  inference URL (used only for the `hindsight` embeddings/reranker/decision
  providers, none selected), and Hugging Face model downloads (not used by the
  slim image; `HF_HUB_OFFLINE=1`). The local LLM-request log is off
  (`HINDSIGHT_API_LLM_TRACE_ENABLED=false`), so prompts are not stored.
* The server never downloads anything at start: the slim image has no local
  models and the migrations are in the image. Postgres is external, so the
  embedded `pg0` binary download is not used.

## Models

* Embeddings: EmbeddingGemma 2 (`embeddinggemma-2`, 768 dimensions,
  multilingual) on the CPU `llama-classifier`, no authentication. Hindsight
  locks the vector dimension in the schema on first start; to change the
  embedding model, stop the stack and delete `./postgres` (this destroys the
  memories). The variable names carry the provider segment
  (`HINDSIGHT_API_EMBEDDINGS_OPENAI_*`); a misspelled name silently falls back to
  api.openai.com (blocked here, so it would fail loudly).
* Reranker: `rrf` (fusion order only, no model).
* LLM slot: `HINDSIGHT_API_LLM_EXTRA_BODY={"id_slot": 2}` (`HINDSIGHT_LLM_SLOT`) pins every LLM call to llama.cpp slot 2 of Ornith, so Hindsight never evicts the prompt primed in slot 1 for Hermes ai-assistant; a busy slot queues the request.
* LLM (retain, consolidation, reflect): `ornith-1.5-9b-dflash` on `llama-server`
  with `LLAMA_API_KEY`. Only the warm model is requested, with concurrency 1,
  so the GPU router never swaps models. Consolidation runs automatically a few
  seconds after a retain.

## First start

```sh
scripts/setup-env.sh hindsight        # or copy .env.example to .env and fill it in
docker compose up -d                  # from hindsight/
```

There is no administrator account. Hindsight creates banks on first use; Hermes
uses the single bank `hermes`. Health: `docker exec hindsight python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8888/health').read())"`.

## Hermes

`hermes-api` must join the external network `hindsight`:

```yaml
services:
  hermes-api:
    networks:
      - hindsight
networks:
  hindsight:
    external: true
    name: hindsight
```

Per profile, `$HERMES_HOME/hindsight/config.json` selects the shared bank and
tags every memory with its profile:

```json
{"mode": "local_external", "api_url": "http://hindsight:8888", "bank_id": "hermes",
 "retain_tags": "profile:<name>", "retain_every_n_turns": 5, "auto_recall": true,
 "recall_prefetch_method": "recall", "recall_budget": "low",
 "recall_types": "observation,world,experience", "memory_mode": "hybrid"}
```

plus `memory.provider: hindsight` in the profile's `config.yaml`. Hermes is connected (2026-11-03): `hermes/start.sh` writes both for every profile except `devops-diagnose`, `coding`, `devops` and `voice`, with `retain_every_n_turns` 1 and `recall_sync` true (the gateway builds a new agent per message, so a higher N never retains); `HERMES_MEMORY_PROVIDER=` (empty) in `hermes/.env` switches it off. See the Hermes README, section Long-term memory. `DELETE /v1/default/banks/hermes/memories` empties the bank. The built-in
`MEMORY.md`/`USER.md` stays the private per-profile layer.

## Backups and resources

Back up `./postgres` (stop `hindsight-db` or use `pg_dump`):
`docker exec hindsight-db pg_dump -U hindsight hindsight > hindsight.sql`.
Limits: API 1.5 GB (about 0.36 GB used), database 0.75 GB (about 0.06 GB used),
relay 64 MB. `shm_size` 256m for PostgreSQL.
