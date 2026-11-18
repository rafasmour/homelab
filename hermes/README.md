# Hermes

Docker Compose deployment for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) OpenAI-compatible API, and its specialist profiles. The former nightly cron jobs now run as n8n workflows (see [Scheduled digests](#scheduled-digests-moved-to-n8n)).

- API: `https://hermes.<DOMAIN>/v1` (port 8642 inside the container), one route per profile under `/p/<profile>/v1`; the full API server (for the Hermes-Relay app) at `https://hermes-api.<DOMAIN>`
- Hermes Desktop (browser webapp): `https://hermes.<DOMAIN>` (the hostname root, port 9120 in the same `hermes` container), see [Hermes Desktop](#hermes-desktop-webapp)
- Hermes-Relay (Android app): web dashboard `https://hermes-dash.<DOMAIN>` (port 9119) and relay `wss://hermes-relay.<DOMAIN>` (port 8767), see [Connecting Hermes-Relay](#connecting-hermes-relay)
- Inference: the `llama-cpp:8080` OpenAI-compatible router on `webgateway`
- Model: `HERMES_MODEL` (default `qwen-3.6-35b-a3b`, a thinking model) for chat
- Time zone: `HERMES_TIMEZONE` (default `Europe/Athens`) for the Hermes clock
- Terminal and file tools: only the CLI-only `coding` and `devops` profiles, inside a throwaway `hermes-sandbox` container (`~/docker/hermes-sandbox`)
- State: the bind-mounted `data/` folder (`/home/hermes/.hermes`), shared with the `hermes-sandbox` CLI
- Tool and MCP call deadlines: 3600 seconds

## Requirements

- Docker Engine with Docker Compose, the external `webgateway` network, and Traefik
- A `llama-cpp` container reachable as `llama-cpp:8080` on `webgateway`, serving the `HERMES_MODEL` alias
- The Nextcloud, n8n, wger, and web-search MCP services on `hermes-mcp` (this stack creates that network)

## Configure and start

Copy the environment template only if a local `.env` does not already exist, then replace every `CHANGE_ME`:

```bash
cp .env.example .env
```

- `API_SERVER_KEY`: at least 16 characters (`openssl rand -hex 32`); clients send it as the Bearer token on every route, including `/p/<profile>/v1`.
- `WEB_SEARCH_MCP_TOKEN`, `N8N_MCP_AUTH_TOKEN`, `MCP_STATIC_TOKEN`: the same values as `web-search/.env`, `n8n/.env`, and `wger/.env`.

```bash
mkdir -p data
docker compose up -d
docker compose logs -f api
```

`data/` must belong to `HERMES_UID:HERMES_GID` (1000:1000 by default). Create it as that user before the first start; Docker would otherwise create it as root.

`HERMES_TRUSTED_PROXIES` (default `172.20.1.0/24`) is the `webgateway` subnet the Webapp trusts for forwarding headers; check it with `docker network inspect webgateway --format '{{(index .IPAM.Config 0).Subnet}}'`.

### One-time migration from the `hermes-data` volume

Earlier versions kept the state in the named volume `hermes_hermes-data`. Copy it into `data/` once, from the repository root:

```bash
docker stop hermes
mkdir -p hermes/data
docker run --rm -v hermes_hermes-data:/from -v "$PWD/hermes/data:/to" alpine cp -a /from/. /to/
ls -ln hermes/data | head            # files owned by 1000:1000
docker compose -f hermes/docker-compose.yml up -d --force-recreate
docker exec hermes ls /home/hermes/.hermes/profiles   # same profiles as before
```

The old volume is not used any more and stays as a backup; remove it with `docker volume rm hermes_hermes-data` only after the new setup has run fine for a while.

Start Hermes before the Nextcloud, n8n, wger, and web-search stacks, which reference `hermes-mcp` as external. Recreate `hermes` after those MCP services are healthy.

## What start.sh manages on every start

`start.sh` runs before the gateway and rewrites the managed state in `data/`, so changes to the script reach the live profiles on the next restart:

- Creates any missing profile: `nextcloud`, `ai-news`, `hf-models`, `llamacpp-vulkan`, `llamacpp-rocm`, `selfhosted`, `calories`, `models`, `planner`, `n8n`, `web-search`, and the CLI-only `coding` and `devops` (see [CLI-only profiles](#cli-only-profiles-coding-and-devops)). The `voice` profile (Home Assistant Assist agent) was removed on 2026-11-06 because Home Assistant is retired; its old `data/profiles/voice` folder is kept as a backup and is no longer configured, served or ticked. The legacy `router` and `digest` profiles stay in `data/` but are no longer configured, served, or ticked.
- Writes each profile's model (`HERMES_MODEL`, provider `custom`, `chat_completions`, context 131072: one slot of the `qwen-3.6-35b-a3b` preset), `timezone`, timeouts, MCP servers, toolsets, and plugins. MCP Bearer tokens are read from the environment inside the script and never passed on a command line.
- Rewrites every `SOUL.md` it owns. The file starts with a `<!-- managed by start.sh ... -->` marker; everything under a `## Local notes` heading in the live file is kept.
- Installs these Hermes user plugins into every profile home:
  - `clock` (`hermes/plugins/clock`): `clock_now` and `clock_to_utc`. `clock_to_utc` resolves `add_days` plus `time` (`HH:MM`) against the current Athens date, so the model never types the date for today or tomorrow (added after it filed "tomorrow 11:00" on the day after tomorrow), or takes `local_datetime` for a named date; every result has `relative` (`today`, `tomorrow`, `in 2 days`, ...) and `in_past`, and the SOULs tell the model to check `relative` against what the user said. On every profile except default, `pre_tool_call` blocks a new to-do, event or wger log (`create_todo`, `create_event`, `log_ingredient`) whose datetime (to the minute) the session has not seen from `clock_to_utc`, `clock_now` or an earlier calendar/wger result; an `end_datetime` up to 24 hours after a checked `start_datetime` of the same call passes, and updates of existing items (past dates included) are never blocked; the model gets `BLOCKED: ... did not come from clock_to_utc` and retries through the tool, and each block is logged at INFO as `clock: blocked ...`. On every profile except default it also hooks Nextcloud and wger calls: `pre_tool_call` rewrites the datetime arguments of to-do/event writes (`due`, `dtstart`, `start_datetime`, `end_datetime`) and wger `log_ingredient`/`update_log_item` (`when`) to UTC `...Z` (a naive value that matches a `clock_to_utc` result of the session just gets its `Z`, any other naive value is read as Athens time, a non-UTC offset is converted; date-only values, all-day events and calls with a `timezone` argument are untouched; the same hook repairs `reminders` of to-do/event writes so each item keeps exactly one of `trigger_at`, `minutes_before`, `trigger` in that priority, because the model sends `minutes_before` and `trigger` together and the Nextcloud MCP rejects that; items with none are dropped, other keys stay, and every repair is logged at INFO as `clock: ... reminders ... -> ...`), and `transform_tool_result` appends an `Athens times:` line to calendar and wger-log results. The default profile is excluded and behaves as before.
  - Local models only (no plugin since the custom plugins were removed). Hermes' auxiliary client walks a built-in provider chain (OpenRouter, Nous, API-key providers) after a timeout or payment error regardless of per-task settings; the only defence now is that no provider key is configured in Hermes. Every profile also sets `fallback_providers: []`, `auxiliary.free_only: true`, and `auxiliary.title_generation.enabled: false` (a timed-out title call used to load the default model over a running one). `start.sh` also pins every auxiliary task (`vision`, `compression`, `skills_hub`, `approval`, `review`, `mcp`, `title_generation`, `memory_query_rewrite`, `tts_audio_tags`, `triage_specifier`, `kanban_decomposer`, `kanban_estimator`, `profile_describer`, `goal_judge`, `curator`, `monitor`, `background_review`, `moa_reference`, `moa_aggregator`, `session_search`, `web_extract`, `video`, `flush_memories`) to `provider: custom` with the profile's own `base_url`, `api_key` and model and an empty `fallback_chain`, so the "auto" chain is never walked. `vision` uses the profile model rather than a vision preset because loading `gemma-4-31b-it-vision` would evict the served model; image input to the text model fails loudly. `delegation` and Hindsight (`api_url` on the hindsight network, no LLM key in Hermes) stay local. The ai-assistant SOUL calls the owner Rafael and has no role-play persona.
- Writes `API_SERVER_KEY` into each served specialist's `<profile>/.env`. Under multiplexing a `/p/<profile>/` request is authenticated against that profile's own secrets and fails closed without a key. The CLI-only profiles get no key, and an existing `API_SERVER_KEY=` line is removed from theirs.
- Leaves the profile cron stores alone: jobs that profiles schedule with the `cronjob` tool (or `hermes [-p <profile>] cron create`) survive restarts.
- Writes each SOUL from its profile's own text plus shared blocks. default keeps the long core rule and the "Whose task is it" section (Nextcloud to-dos and events are the user's tasks, the Hermes Kanban is Hermes's work queue, timed work is a cron job, `delegate_task` is for short side jobs). Every other profile gets a short "Rules" block (do the work with tools, retry once, never claim what no tool result shows, one question listing everything missing, answer only) and a short "Working with other profiles" block (to-dos versus Kanban, `kanban_create`). The profiles that write datetimes (`nextcloud`, `planner`, `calories`) also get a short "Dates and times" block (Europe/Athens, `clock_now`, `clock_to_utc`). `ai-assistant` has a complete SOUL of their own and get none of these blocks.
- Sampling: every profile except default gets `temperature` (`HERMES_SAMPLING_TEMPERATURE`, 0.6) and `presence_penalty` (`HERMES_SAMPLING_PRESENCE_PENALTY`, 0) in the `extra_body` of its `custom_providers` entry, next to `id_slot`. Hermes 0.20.5 has no per-profile sampling setting, so the request body carries them and they replace the model preset's own values (presence-penalty 1.5 in a preset made small models drop repeated tool arguments). An empty variable keeps the preset's value; default is never changed.
- Disables the old Forage plugin.

`/opt/hermes` is not writable by the `hermes` user, so the plugins live in the profile homes and are enabled through `plugins.enabled`.

## The core rule: work through the MCP tools

default's SOUL includes this rule in full (`SOUL_CORE`); every other profile except `ai-assistant` has the short "Rules" block with the same intent, and `ai-assistant` has a spoken-reply version of it. A task is done only when the matching tool returned success in that run: calendar events with `mcp__nextcloud__nc_calendar_create_event`, to-dos and reminders with `mcp__nextcloud__nc_calendar_create_todo`, notes with `mcp__nextcloud__nc_notes_create_note`, food with `mcp__wger__search_ingredients` then `mcp__wger__log_ingredient`, research with `mcp__web_search__web_search` and `mcp__web_search__fetch_url`. The rule is also enforced by configuration: every profile disables `todo`, `session_search`, `messaging`, code execution, the browser, the built-in web toolset and skills (`cronjob` and `delegation` are enabled on default only); `memory` is enabled everywhere; the shell (`terminal`) and `file` toolsets are disabled on every profile except the CLI-only `coding` and `devops`.

## Profiles

All profiles use `HERMES_MODEL`. Each profile gets only the tools its job needs: its MCP servers (with per-server tool allowlists), `clock`, `terminal` and `file` (CLI-only `coding` and `devops` only). `configure_profile` adds to the lists below: `kanban` to every profile except `ai-assistant`; `cronjob`, `delegation` (`delegate_task`) and `web_search` to default only. Every other profile lists `web_search` itself where its job needs it (the `web_search` MCP is still registered for all profiles but the CLI-only ones, whose sandbox cannot reach `hermes-mcp`); cron lists get `kanban` and `web_search`. `clarify` is disabled everywhere: follow-up questions go in the reply. default is the orchestrator: all MCP servers, the Kanban as its own work queue and `delegate_task` subagents (see [Kanban and subagents](#kanban-and-subagents)). Skills, the built-in web, browser and code tools stay disabled. Hermes runs no cron jobs (the digests are n8n workflows); the `cron` lists name only the tools a profile's own cron jobs need, or just `clock`.

| Profile | MCP servers in its toolsets | cli and api_server | cron | Role |
| --- | --- | --- | --- | --- |
| default | nextcloud, wger, web_search, huggingface, n8n | same, plus clock | clock | Personal assistant and orchestrator for Open WebUI |
| nextcloud | nextcloud (29 tools by explicit name: calendar and to-do read/create/update/delete, notes create/search/get/append/update, 8 WebDAV, 3 contacts) | nextcloud, clock | nextcloud, clock | Calendars, to-dos, notes, files; `morning-digest` |
| ai-news | web_search | web_search, clock | web_search, clock | r/LocalLLaMA; `ai-news` |
| hf-models | huggingface (`hub_repo_search`, `hub_repo_details`) | huggingface, clock | huggingface, clock | New Hugging Face text models; estimates the memory a model needs from the file sizes (no access to the server's files); always passes an integer `limit` to `hub_repo_search`; `hf-models` |
| llamacpp-vulkan | web_search | web_search, clock | web_search, clock | llama.cpp Vulkan changes; `llamacpp-vulkan` |
| llamacpp-rocm | web_search | web_search, clock | web_search, clock | llama.cpp ROCm/HIP changes (this server's backend), researched on GitHub through web search; `llamacpp-rocm` |
| selfhosted | web_search | web_search, clock | web_search, clock | r/selfhosted and r/homelab; `selfhosted` |
| calories | wger (10 tools), web_search (`web_search` only, to identify an unknown food) | wger, web_search, clock | wger, clock | Food log and day totals; never creates to-dos; `calories-report` |
| coding (CLI only) | none | terminal, file, clock | clock | `hermes-sandbox coder`: Docker Compose projects in the mounted folder (typically `~/docker/projects/<name>`), run through the scoped compose proxy at `<name>.<DOMAIN>`; git per milestone, tests, README |
| devops (CLI only) | none | terminal, file, clock | clock | `hermes-sandbox devops`: Compose stacks in the folder `hermes-sandbox` ran in, following its `AGENTS.md`; host Docker and git only with those modules; risky commands need approval |
| models | huggingface (`hub_repo_search`, `hub_repo_details`), web_search | huggingface, web_search, clock | clock | Model advisor: finds GGUF quants and judges whether they fit; it cannot download, edit presets or restart anything |
| planner | nextcloud (11 calendar/to-do tools, no deletes), wger (`nutrition_summary`, `list_log_items`, `list_nutrition_plans`) | nextcloud, wger, clock | clock | Weekly review, wedding (Γάμος) countdown and chasing, meal and week planning, to-do priorities; asks before creating anything |
| n8n | n8n (11 of 28 tools: nodes, validate, list/get/create/test workflows, executions, health; no update, autofix, delete, credentials, data tables, templates, versions) | n8n, clock | clock | Builds new n8n workflows (created inactive): deterministic nodes first, at most one tool-less LLM step. It cannot change, activate or deactivate existing workflows; it describes changes or creates a corrected copy for the owner to swap in the n8n UI |
| web-search | web_search (`web_search`, `fetch_url`) | web_search, clock | clock | Research assistant: searches, reads 2-4 sources fully, answers with numbered citations and a Sources list |
| ai-assistant | nextcloud (`nextcloud_assistant`: 14 calendar, to-do and note tools, including edits and deletes; no files or contacts), web_search (`web_search`, `fetch_url`) | nextcloud_assistant, web_search, clock | clock | The owner's everyday assistant for Hermes-Relay chat and voice (see [The ai-assistant profile](#the-ai-assistant-profile)): spoken-style answers, Nextcloud itself, quick web facts, and it names the profile that handles anything else (no `kanban` toolset, no Kanban guidance in its prompt); thinking budget 1024 tokens; its own llama.cpp slot |

The n8n MCP authenticates to n8n with `N8N_API_KEY` from `n8n/.env`; when that key expires, every n8n workflow call fails with 401 until a new key is created in n8n (Settings, n8n API).

### The default profile is the assistant

The default profile treats every message as a task. It classifies the message (food, appointment, to-do, workout, question, or long specialist work), asks one short follow-up for whatever is missing (food: what, amount, meal, time; events: title, date, time, duration; to-dos: title and due), then calls the tool itself and replies with the created object's id. A workout becomes a completed to-do, because the wger MCP has no workout logging. For long specialist work (news, models) it plans a Kanban card for the profile that handles it. It picks the Nextcloud to-do list by topic (listing the lists first) and names the list it used. The calendar URIs come from [nextcloud/README.md](../nextcloud/README.md#calendars-and-tasks).

### The ai-assistant profile

The owner's everyday assistant: phone voice through Hermes-Relay, and chat. It is a normal served specialist (`/p/ai-assistant/v1`, the shared `API_SERVER_KEY`, no extra key) with the smallest toolset that does the job.

- **Tools:** `mcp__nextcloud_assistant__*` (14: `nc_calendar_list_calendars`, `get_upcoming_events`, `list_events`, `create_event`, `update_event`, `delete_event`, `search_todos`, `create_todo`, `update_todo`, `complete_todo`, `delete_todo`, `nc_notes_create_note`, `search_notes`, `append_content`), `web_search` and `fetch_url`, `memory` (built-in plus Hindsight), `clock_now`, `clock_to_utc`. A second registration of the Nextcloud MCP under its own name is needed because the multiplexed gateway applies only default's tool filters (the multiplexed gateway reads only default's `mcp_servers`); both filter lists must stay identical. No `delegate_task`, no cron, terminal, file, code or browser tools, no contacts or files.
- **Other profiles:** it has no food, money, file, contact, n8n or model tools and cannot reach the other profiles; it says so and names the profile that handles the request. It has no `kanban` toolset (its 14 schemas are about 23k characters and Hermes adds about 6.6k characters of Kanban guidance whenever `kanban_show` is available).
- **SOUL (about 5.8k characters, no character role-play; since 2026-11-06 the reply language is just "the language of his latest message", and the to-do lists, the Forbidden-means-wrong-calendar rule, no unrequested alarms and the `clock_to_utc` worked example are spelled out):** answers in the language of the latest message, plain spoken sentences as long as the answer needs (no sentence limit), no Markdown, URLs, ids, ISO dates or UTC times; confirms only what a tool result in the turn shows, with the item's title and spoken day and time (never "Done" alone); creates new items without asking and asks before changing, completing or deleting an existing one; the to-do list map, the clock rules, quick web facts through its own tools, naming the profile that handles what it cannot do, food always to `calories`, no tool call for dictated text or noise, memory only for lasting facts. It has no shared core rule (own rules instead of the core rule).
- **Thinking budget 1024 tokens** (`HERMES_AI_ASSISTANT_THINK_BUDGET`, since 2026-11-05; about 16 s at 63 tok/s; it was capped at 200 tokens until 2026-11-04). It is sent as `reasoning_budget_tokens` in the profile's `custom_providers` `extra_body`, together with `id_slot` and the sampling values; every other profile thinks without a limit.
- `agent.max_turns` 12, approvals strict, no terminal or file tools.
- **Prompt size:** about 18.6-20.8k tokens on the first call before the 2026-11-06 trim (the 14 Kanban tools alone are ~25k characters and cannot be trimmed per tool); removing `cronjob`, `delegation` and the role-play lowers it, the real figure is in the llama.cpp log.

#### Hermes-Relay: chat, voice and wake word

The app pairs once with the Hermes dashboard (see [Pairing the app](#pairing-the-app)); the profile is a per-chat and per-voice setting in the app, not a second pairing.

1. Pair the app as described below if it is not yet paired. The profile list comes from the server, so `ai-assistant` appears after `docker compose up -d --force-recreate api`.
2. Chat: select the profile `ai-assistant` in the app's profile selector (the relay passes `profile` with every chat message); new chats then run as that profile.
3. Voice: select the same profile for voice mode (the relay's voice routes take a `profile` too and read that profile's STT and TTS config: `auto` and `assistant`/Jarvis through speech-gateway, so English and Greek switch by themselves).
   Streaming voice output: `start.sh` writes a `voice_output` section into the ai-assistant profile (provider `openai_tts`, model/voice `assistant`, codec `pcm`, 24 kHz) and patches the relay's `voice_lab/providers/openai_tts.py` (idempotent, warns and continues if upstream drifted) to read its endpoint from `HERMES_RELAY_OPENAI_TTS_URL` and key from `HERMES_RELAY_OPENAI_TTS_KEY` (compose: speech-gateway, placeholder key; never api.openai.com). The relay's `/voice/output/session` then streams the speech gateway's sentence-by-sentence PCM (Jarvis) to the phone, so speech starts after the first sentence (about 1.6 s) instead of after the whole reply (about 3 s plus). If the app instead uses the legacy `/voice/synthesize` path it still works, just slower.
4. Wake word: enable it after choosing the profile; it starts the voice mode, which uses the selected profile.
5. Not verified here (no phone): the exact menu names, and that the wake word follows the selected profile. The relay sends the app's chat to the gateway's own API server (`RELAY_WEBAPI_URL`, port 8642), so those turns are API-server calls like any other.

## Long-term memory (Hindsight)

Every profile except the excluded ones uses the self-hosted [Hindsight](../hindsight/README.md) server as its Hermes memory provider (`memory.provider: hindsight`), next to the built-in `MEMORY.md`/`USER.md` (still on, still private per profile). Start the `hindsight` stack first: it creates the external `hindsight` network that `hermes` joins (internal network, no internet; Hindsight itself has no authentication and is reachable only from `hermes`).

- **One shared bank `hermes`.** Every retained memory carries the tag `profile:<name>` (plus `session:<id>`), but recall is not filtered by tag, so a fact told to `ai-assistant` is recalled in `default` and the other profiles, in any language (EmbeddingGemma 2 is multilingual).
- **Per-profile file.** `start.sh` writes `data/profiles/<name>/hindsight/config.json` (`data/hindsight/config.json` for default) on every start: `mode: local_external`, `api_url: http://hindsight:8888`, `retain_every_n_turns` from `HERMES_HINDSIGHT_RETAIN_EVERY` (1), `recall_budget: mid`, `recall_max_tokens: 800`, **`auto_retain: false`** (saving only through `hindsight_retain`, see the ai-assistant SOUL "Memory" rule), `recall_types: observation,world,experience`, **`memory_mode: tools`** with `auto_recall: false`, plus `bank_mission` and a strict `bank_retain_mission` (only lasting facts the owner states; never the assistant's claims, changing status, stories or garbled speech).
- **Tools mode since 2026-11-04 (factory reset).** With the default `hybrid` mode every turn got recalled memories injected under Hermes' fixed note "Treat as authoritative reference data" plus the plugin's "Do not call tools to look up information that is already present here". Stale status ("X is overdue"), the assistant's own wrong answers and garbled transcripts were stored, recalled as authoritative and repeated instead of checked. Now nothing is injected: the model calls `hindsight_recall` / `hindsight_reflect` when it needs the past, and turns are still retained. On 2026-11-04 the bank, every profile's sessions (`state.db`, `sessions/`, `webui/sessions/`) and built-in memories (`memories/`) were deleted; backups are in `data/backups/factory-reset-20261104/` (`hermes-sessions-memories.tar.gz`, `webui-sessions.tar.gz`, `hindsight-db.dump` as `pg_dump -Fc`). The plugin ignores every `HINDSIGHT_*` variable once this file exists, so no cloud mode or API key can be selected by accident; no data leaves the machine.
- **Why retain every turn.** The gateway builds a new agent (and plugin instance) per message and the plugin's turn counter lives in it, so `retain_every_n_turns` above 1 never fires in the API/gateway path. Each turn is retained asynchronously; the extraction and consolidation calls run on Ornith through `hindsight-relay` (a few seconds each, off the reply path).
- **Where recall went (hybrid mode, before 2026-11-04).** With `recall_sync` the recall for the current message (0.05-0.2 s, a few hundred tokens) is injected into that turn's *user message* inside a `<memory-context>` block, never into the system prompt. The system prompt only gains a fixed three-line `# Hindsight Memory` block and the tool list gains `hindsight_retain`, `hindsight_recall` and `hindsight_reflect`, so the prompt prefix stays stable. A plain "remember that ..." is usually answered with the built-in `memory` tool (private, that profile only); the Hindsight copy is made by the automatic retain of the turn.
- **Switch.** `HERMES_MEMORY_PROVIDER` in `hermes/.env` (unset or `hindsight` = on, empty = built-in memory only), then `docker compose up -d hermes`. Off removes `memory.provider: hindsight` from the profiles; the config files and the bank stay. `HERMES_MEMORY_EXCLUDE` (default `coding devops`) lists profiles that never use it: `coding` and `devops` run in throwaway sandbox containers that cannot reach the `hindsight` network. Remove a name from the list to include it.
- **Cron runs.** A cron job is one turn per run (no per-platform setting exists in the plugin), so with the default it is recalled into but retained only if the job itself calls `hindsight_retain`.
- **Inspecting and deleting.** The API has no UI: `docker exec hindsight python -c ...` against `http://127.0.0.1:8888/v1/default/banks/hermes/memories/list`; `DELETE /v1/default/banks/hermes/memories` empties the bank.
- **Backup.** `hindsight/postgres` (see the Hindsight README).

## Slot reservation and compaction

**llama.cpp slot reservation.** `ornith-1.5-9b-dflash` has 3 slots of 64k. llama.cpp picks a slot by longest-common-prefix similarity unless the request carries `id_slot`; before the reservation other prompts (f_sim 0.68-0.73) landed in the ai-assistant slot and evicted its cached prompt. Now every client is pinned (b11957: the router forwards `id_slot` to the child, log `selected slot by id (N)`; a request for a busy slot is deferred and queued, not rejected, and never spills to another slot):

| Slot | Traffic | Where it is set |
|---|---|---|
| 0 | the ai-assistant profile | `HERMES_SLOT_PRIMED` (start.sh writes `id_slot` into that profile's `custom_providers` `extra_body`, next to its reasoning budget) |
| 2 | every other Hermes profile (default, specialists, cron, Kanban workers) | `HERMES_SLOT_OTHERS` (same mechanism) |
| 1 | Hindsight retain, consolidation and reflect | `HINDSIGHT_API_LLM_EXTRA_BODY={"id_slot": 1}` in `hindsight/docker-compose.yml` |

Trade-off: other profiles now share slot 2, so two concurrent non-ai-assistant requests queue (Kanban runs at most 2 workers, so a second worker waits for the first request, not for a whole task) and a profile switch on slot 2 re-evaluates its prompt (default ~39k tokens, ~30 s) instead of finding a slot with a similar prefix. Slot 1 is used only by Hindsight, whose calls are serial (`MAX_CONCURRENT=1`). `HERMES_SLOT_OTHERS=-1` removes the pinning of all other profiles (they then fall back to similarity selection and can evict slot 0 again). Not pinned: Open WebUI talking to llama-server directly and the n8n digest workflows (see llama-cpp/README.md); they use LCP selection and can still take slot 0 if it is the closest match or the least recently used.

**Recovery after restarts (measured 2026-11-03, Ornith DFlash).** All containers are `restart: unless-stopped`; the `hindsight` network is created by the hindsight stack, so start hindsight (and speech, llama-cpp) before hermes after a cold boot; Hermes itself needs no ordering against speech/llama-cpp because both warmers retry.

| Event | What reloads | Time |
| --- | --- | --- |
| `hermes` recreated | nothing to load; the first ai-assistant request evaluates its prompt cold | none |
| `audiocpp-tts` restarted | speech-gateway warmer (15 s loop) loads Jarvis | about 25 s |
| `llama-server` restarted | router loads Ornith (`load-on-startup`) in about 7 s; Jarvis stays loaded | model 7 s |
| another llama model used (e.g. paperless) | warmer parks audio.cpp on Phonon; when that model sleeps (default `sleep-idle-seconds` 300) or unloads, the warmer reloads Ornith within 15 s, then Jarvis | model about 5 min after the other model's last request; this path was reasoned from the warmer code, not triggered |

**Compaction.** `start.sh` sets `compression.enabled: true` and `compression.threshold` from `HERMES_COMPRESSION_THRESHOLD` (default 0.8) in every profile. The threshold is a fraction of `model.context_length` (65536, one slot) compared with the whole request (system prompt, tools, messages): 0.8 is ~52k tokens, leaving ~13k for the reply and tool output. Hermes' 0.5 default (32,768) is below the default profile's first call; Hermes itself floors models under 512k context at 0.75. `target_ratio` (0.2) and `protect_last_n` (20) are unchanged.

## OpenAI-compatible API per profile

`gateway.multiplex_profiles` is on, so the default gateway serves every profile in `gateway.multiplex_profile_allowlist` on one listener. Specialists keep `platforms.api_server.enabled: false`; the multiplexer refuses to start if a secondary profile enables a port-binding platform.

| Profile | Base URL inside Docker | `/v1/models` id |
| --- | --- | --- |
| default | `http://hermes:8642/v1` or `http://hermes:8642/p/default/v1` | `hermes-agent` (`API_SERVER_MODEL_NAME`) |
| any specialist | `http://hermes:8642/p/<profile>/v1` | the profile name, for example `nextcloud` |

`coding` and `devops` are not in the allowlist and have no `API_SERVER_KEY`, so `/p/coding/v1` and `/p/devops/v1` are not served.

The public equivalents are `https://hermes.<DOMAIN>/v1` and `https://hermes.<DOMAIN>/p/<profile>/v1`. Hermes 0.20.5 derives a specialist's advertised model id from the profile name and has no setting to rename it; use the client's prefix option (for example Open WebUI `prefix_id`) for names such as `hermes-<profile>`. The requested model name does not change the inference model: every profile runs `HERMES_MODEL`.

## Hermes Desktop (Webapp)

The Desktop is the browser-hosted agent UI (all profiles, sessions, Kanban, cron, skills). Since v0.23 the gateway serves it itself on port 9120, so it runs in the `hermes` container next to the API, the dashboard and the relay, on the same `data/` home: the Desktop sees every profile and the llama.cpp provider directly, with no remote-gateway setup.

- **Routing on `hermes.<DOMAIN>`:** `/v1` and `/p/<profile>/v1` go to the API server (`hermes-openai` router, priority 100). Every other path, including the Webapp's own `/api/*`, `/api/ws` and `/login`, goes to 9120 (`hermes-desktop` router). The full API surface (`/health`, `/api/sessions`, `/api/jobs`, ...) that the Hermes-Relay app needs is on `https://hermes-api.<DOMAIN>`, because those paths collide with the Webapp's.
- **Sign-in:** the dashboard login (`HERMES_DASHBOARD_USERNAME`/`HERMES_DASHBOARD_PASSWORD`, the same as `hermes-dash`). The gateway only sees the container environment, so `start.sh` writes `dashboard.basic_auth` (username, scrypt password hash and a stable signing secret) into the default profile's `config.yaml`; logins survive restarts and end when the password changes.
- **Config:** `webapp.*` and `dashboard.trusted_proxies` have no environment override; `start.sh` writes them on every start while the dashboard password is usable (set and not `CHANGE_ME`): bind `0.0.0.0:9120`, `public_url` `HERMES_WEBAPP_PUBLIC_URL` (`https://hermes.<DOMAIN>`), trusted proxies `HERMES_TRUSTED_PROXIES` (the `webgateway` subnet, so cookies are `Secure` behind Traefik's TLS). Without a usable password the Webapp is turned off.
- **Health check:** `docker exec hermes hermes webapp --status`.

| Piece | Route | Inside the container |
| --- | --- | --- |
| Web dashboard (`hermes dashboard`, password login) | `https://hermes-dash.<DOMAIN>` | `0.0.0.0:9119` (in `hermes`) |
| Relay server (`hermes relay`, WebSocket) | `wss://hermes-relay.<DOMAIN>` | `0.0.0.0:8767`, no TLS (Traefik terminates it) (in `hermes`) |
| Hermes API (OpenAI-compatible) | `https://hermes.<DOMAIN>/v1` and `/p/<profile>/v1` | `0.0.0.0:8642` (in `hermes`) |
| Hermes API (full surface, Hermes-Relay app) | `https://hermes-api.<DOMAIN>` | `0.0.0.0:8642` (in `hermes`) |
| [Hermes Desktop](#hermes-desktop-webapp) (webapp) | `https://hermes.<DOMAIN>` (every other path) | `0.0.0.0:9120` (in `hermes`) |

All routers are on the one `hermes` container (former name `hermes-api`, kept as a network alias for URLs stored in Open WebUI or n8n). On the shared `hermes.<DOMAIN>` hostname the `/v1`/`/p/` router has priority 100 over the Desktop's host-only rule. One Homepage entry (on the Desktop container). No host ports are published. Keep them behind the WireGuard VPN like the rest of the stack: the dashboard login and the pairing code are the only protection, and the dashboard can edit configuration and API keys.

Timeouts (read from the relay source, checked 2026-11-06): the relay's HTTP client to the gateway for chat has no total or read timeout (`relay/channels/chat.py`: `ClientTimeout(total=None, connect=10)`), so a long turn is not cut off by the relay. The phone app's own request timeout is not part of this repository and was not checked. Only the optional Secure Link proxy (`relay/secure_proxy.py`: 15 minutes total, 120 seconds without data) has a shorter limit; this setup does not use it, and `start.sh` does not patch that file.

What `start.sh` does, only when enabled:

- Downloads the plugin directory `plugin/` of Hermes-Relay `server-v1.13.1`, pinned by commit (`RELAY_REF` in `start.sh`), into `data/plugins/hermes-relay` (default profile only) and enables it through `plugins.enabled`. `hermes plugins install` cannot be used: its scanner rates the repository "dangerous" and `--force` does not override that. The code is reviewable at the pinned commit; bump `RELAY_REF` to upgrade.
- Installs the two Python packages the plugin needs and the image lacks (`segno`, `websocket-client`) into `data/relay/deps` (`PYTHONPATH` in the compose file points there). Needs internet access on first start.
- Starts `hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build` and `data/relay/launch.py --no-ssl` (the relay) as background processes in restart loops; their output appears in `docker logs hermes` prefixed `[dashboard]` and `[relay]`. If one dies it is restarted after 30 seconds and the gateway is not affected.

Settings in `.env`:

| Variable | Meaning |
| --- | --- |
| `HERMES_DASHBOARD_ENABLED` | `true` (default) or `false`. The dashboard also needs a usable password, see below. |
| `HERMES_DASHBOARD_USERNAME`, `HERMES_DASHBOARD_PASSWORD` | Dashboard login (Hermes basic-auth provider; the password is hashed in memory). Hermes refuses a non-loopback bind without an auth provider, so `start.sh` serves the dashboard only when the password is set and not `CHANGE_ME`, and logs a notice otherwise. Generate with `openssl rand -base64 24`. Dashboard sessions are signed with a key derived from the password, so they survive restarts and end when the password changes. |
| `HERMES_RELAY_ENABLED` | `true` (default) or `false`. |
| `HERMES_RELAY_TERMINAL_ENABLED` | `false` (default). See the warning below. |

The relay's terminal channel opens a PTY shell as the `hermes` user **inside `hermes`**, which holds every secret of this stack in its environment and in `data/` (all profile `.env` files) and sits on the `backend`, `hermes-mcp` and `hindsight` networks. That contradicts the rule that terminal and file tools run only in a throwaway sandbox, and the relay has no setting to turn it off. `data/relay/launch.py` therefore replaces the relay's terminal handler with a refusal unless `HERMES_RELAY_TERMINAL_ENABLED=true`; the app's terminal tab then shows "Terminal is disabled on this server". Chat, voice, media and the phone bridge are unaffected. The relay can start a different shell through `RELAY_TERMINAL_SHELL` (an absolute path to an executable), which could in principle be a wrapper that runs elsewhere; that is untested here. The Hermes dashboard's own Chat tab runs the agent, not a raw shell, and uses each profile's configured tools.

### Pairing the app

1. Set `HERMES_DASHBOARD_PASSWORD` in `.env` (and optionally the other variables above), then recreate the container: `docker compose up -d --force-recreate api` in `hermes/`. The first start downloads the plugin and packages.
2. Connect the phone to the VPN, open `https://hermes-dash.<DOMAIN>` and sign in. Open **Relay** in the dashboard and choose **Pair new device** to show a QR code.
3. In the app scan the QR code. It carries the dashboard origin (`HERMES_DASHBOARD_PUBLIC_URL`, set to `https://hermes-dash.<DOMAIN>` by the compose file), the relay session code and the Hermes API key. The relay is reached through the dashboard origin (`wss://hermes-dash.<DOMAIN>/api/plugins/hermes-relay/transport`), so the separate `hermes-relay.<DOMAIN>` route is only the legacy direct route.
4. From a shell instead of the dashboard: `docker exec -it -u hermes hermes hermes pair --mode public --public-url https://hermes-dash.<DOMAIN>`; add `--legacy-direct-relay` to also advertise `wss://hermes-relay.<DOMAIN>` (use `--no-qr` for text only). Manual entry in the app: API URL `https://hermes-api.<DOMAIN>` with `API_SERVER_KEY`, Relay URL `wss://hermes-relay.<DOMAIN>` with the pairing code.
5. Check the server with `docker exec -u hermes hermes hermes relay doctor`, or `curl https://hermes-relay.<DOMAIN>/health` from the VPN. Paired devices are listed and revoked on the dashboard's Relay page.

Backup: `data/relay/` and `data/plugins/hermes-relay` are recreated by `start.sh`; the paired-device list is `data/hermes-relay-sessions.json` (back it up with the rest of `data/`; losing it only means re-pairing). Rollback: set both switches to `false`; `start.sh` removes the plugin from `plugins.enabled` and stops starting the processes. (No re-pairing is needed for the Desktop routing change: the QR still carries `https://hermes.<DOMAIN>` as the API address, and those paths still resolve to `hermes`.)

## Storage and backups

Back up:

- `data/` (bind mount, ignored by Git): configuration, SOULs, sessions, Kanban, cron jobs and outputs, and the profile `.env` files (secrets: keep backups private)

`/opt/hermes` comes straight from the image (no volume), so upgrading is: set `HERMES_AGENT_VERSION` in `hermes/.env` back up `data/` (the first start migrates `config.yaml` irreversibly; the gateway also keeps copies under `data/backups/config/`), then `docker compose pull && docker compose up -d`, run `agent-sandbox build hermes`. The 0.20.5 → 0.23.2 upgrade (2026-11-17) left `data.bak-2026-11-17-v0.20.5/`.

## Architecture and security

The API uses the internal `backend` network, `hermes-mcp`, `hindsight`, and `webgateway`. No host ports are published. On `hermes.<DOMAIN>` Traefik routes `/v1` and the `/p/<profile>/v1` routes to port 8642 and every other path to the Desktop's 9120 behind the dashboard login; `hermes-api.<DOMAIN>` serves the whole API server. Both API routes are behind `API_SERVER_KEY` (see [Hermes Desktop](#hermes-desktop-webapp)). MCP and plugin tools run inside the API container; the terminal and file tools run only in the `hermes-sandbox` CLI sessions of `coding` and `devops`, and code execution is disabled on every profile. `hermes` has no Docker socket and no host folders: `devops`, the only profile that can reach the host Docker socket, is not served by the API; it runs only from the `hermes-sandbox` CLI on the host, and only when the docker module is on.

The `n8n` profile has no tool that changes an existing workflow, so a prompt-injected n8n run cannot alter the live workflows; it can still create new, inactive ones and run existing ones with `n8n_test_workflow` (whose `exposeToMcp` option turns on a workflow's "Available in MCP" setting).

## Validation

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose ps
docker exec hermes sh -c 'curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/p/nextcloud/v1/models'
docker exec hermes hermes webapp --status   # Serving at http://127.0.0.1:9120 (the bind is 0.0.0.0)
docker exec hermes hermes -p calories config get model.default
docker exec hermes hermes -p devops config get terminal.backend      # local
```

## Upstream documentation

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
