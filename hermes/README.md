# Hermes

Docker Compose deployment for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) OpenAI-compatible API, and its specialist profiles. The former nightly cron jobs now run as n8n workflows (see [Scheduled digests](#scheduled-digests-moved-to-n8n)).

- API: `https://hermes.<DOMAIN>` (port 8642 inside the container), one route per profile under `/p/<profile>/v1`
- Hermes-Relay (Android app): web dashboard `https://hermes-dash.<DOMAIN>` (port 9119) and relay `wss://hermes-relay.<DOMAIN>` (port 8767), see [Connecting Hermes-Relay](#connecting-hermes-relay)
- Inference: the `llama-cpp:8080` OpenAI-compatible router on `webgateway`
- Model: `HERMES_MODEL` (default `qwen-3.6-35b-a3b`, a thinking model) for chat
- Time zone: `HERMES_TIMEZONE` (default `Europe/Athens`) for the Hermes clock
- Nextcloud Talk: through [hermes-nextcloud-bridge](../hermes-nextcloud-bridge/README.md)
- Terminal and file tools: only the `models`, `hf-models` and `llamacpp-rocm` profiles, over SSH in their own [sandbox](../hermes-sandboxes/README.md), and the CLI-only `coding` and `devops` profiles inside a throwaway `hermes-sandbox` container (`~/docker/hermes-sandbox`)
- State: the bind-mounted `data/` folder (`/home/hermes/.hermes`), shared with the bridge and `hermes-sandbox`
- Tool and MCP call deadlines: 3600 seconds

## Requirements

- Docker Engine with Docker Compose, the external `webgateway` network, and Traefik
- A `llama-cpp` container reachable as `llama-cpp:8080` on `webgateway`, serving the `HERMES_MODEL` alias
- The Nextcloud, n8n, draw.io, wger, and web-search MCP services on `hermes-mcp` (this stack creates that network)
- `hermes-nextcloud-bridge` for Talk delivery
- The [hermes-sandboxes](../hermes-sandboxes/README.md) stack (it creates the external `hermes-sandbox` network) and its `setup-keys.sh` run once
- The [self-heal](../self-heal/README.md) stack, which creates the external `self-heal-agent` network (the controller and its read-only diagnose MCP)

## Configure and start

Copy the environment template only if a local `.env` does not already exist, then replace every `CHANGE_ME`:

```bash
cp .env.example .env
```

- `API_SERVER_KEY`: at least 16 characters (`openssl rand -hex 32`); clients send it as the Bearer token on every route, including `/p/<profile>/v1`.
- `WEB_SEARCH_MCP_TOKEN`, `N8N_MCP_AUTH_TOKEN`, `MCP_STATIC_TOKEN`: the same values as `web-search/.env`, `n8n/.env`, and `wger/.env`.
- `BENCHMARK_MCP_TOKEN` (optional): the same value as in `benchmark/.env` (`openssl rand -hex 32`). Without it the `models` profile is configured without the `benchmark` MCP server.
- `SELF_HEAL_HERMES_KEY` and `DIAGNOSE_MCP_TOKEN`: the same values as in `self-heal/.env` (`openssl rand -hex 32` each). `SELF_HEAL_HERMES_KEY` must differ from `API_SERVER_KEY` and have at least 16 characters, otherwise `devops-diagnose` is not served (see [Self-heal diagnosis](#self-heal-diagnosis-devops-diagnose)).
- `NEXTCLOUD_TALK_DELIVER_SECRET` and `NEXTCLOUD_TALK_HOME_ROOM`: the same values as `TALK_DELIVER_SECRET` and `NEXTCLOUD_TALK_HOME_ROOM` in `hermes-nextcloud-bridge/.env`.

```bash
mkdir -p data
docker compose up -d
docker compose logs -f api
```

`data/` must belong to `HERMES_UID:HERMES_GID` (1000:1000 by default). Create it as that user before the first start; Docker would otherwise create it as root.

### One-time migration from the `hermes-data` volume

Earlier versions kept the state in the named volume `hermes_hermes-data`. Copy it into `data/` once, from the repository root:

```bash
docker stop hermes-nextcloud-bridge hermes-api
mkdir -p hermes/data
docker run --rm -v hermes_hermes-data:/from -v "$PWD/hermes/data:/to" alpine cp -a /from/. /to/
ls -ln hermes/data | head            # files owned by 1000:1000
docker compose -f hermes/docker-compose.yml up -d --force-recreate
docker compose -f hermes-nextcloud-bridge/docker-compose.yml up -d --build --force-recreate
docker exec hermes-api ls /home/hermes/.hermes/profiles   # same profiles as before
```

The old volume is not used any more and stays as a backup; remove it with `docker volume rm hermes_hermes-data` only after the new setup has run fine for a while.

Start Hermes before the Nextcloud, n8n, wger, and web-search stacks, which reference `hermes-mcp` as external. Recreate `hermes-api` after those MCP services are healthy.

## What start.sh manages on every start

`start.sh` runs before the gateway and rewrites the managed state in `data/`, so changes to the script reach the live profiles on the next restart:

- Creates any missing profile: `nextcloud`, `finance`, `ai-news`, `hf-models`, `llamacpp-vulkan`, `llamacpp-rocm`, `selfhosted`, `calories`, `models`, `planner`, `n8n`, `web-search`, the self-heal profile `devops-diagnose` (see [Self-heal diagnosis](#self-heal-diagnosis-devops-diagnose)), and the CLI-only `coding` and `devops` (see [CLI-only profiles](#cli-only-profiles-coding-and-devops)). The `voice` profile (Home Assistant Assist agent) was removed on 2026-11-06 because Home Assistant is retired; its old `data/profiles/voice` folder is kept as a backup and is no longer configured, served or ticked. The legacy `router` and `digest` profiles stay in `data/` but are no longer configured, served, or ticked.
- Writes each profile's model (`HERMES_MODEL`, provider `custom`, `chat_completions`, context 131072: one slot of the `qwen-3.6-35b-a3b` preset), `timezone`, timeouts, MCP servers, toolsets, and plugins. MCP Bearer tokens are read from the environment inside the script and never passed on a command line.
- Rewrites every `SOUL.md` it owns. The file starts with a `<!-- managed by start.sh ... -->` marker; everything under a `## Local notes` heading in the live file is kept.
- Installs these Hermes user plugins into every profile home:
  - `talk_send` (tracked in `hermes/plugins/talk_send`, mounted read-only): the agent tool that posts to the Talk home room.
  - `clock` (`hermes/plugins/clock`): `clock_now` and `clock_to_utc`. On every profile except default it also hooks Nextcloud and wger calls: `pre_tool_call` rewrites the datetime arguments of to-do/event writes (`due`, `dtstart`, `start_datetime`, `end_datetime`) and wger `log_ingredient`/`update_log_item` (`when`) to UTC `...Z` (a naive value that matches a `clock_to_utc` result of the session just gets its `Z`, any other naive value is read as Athens time, a non-UTC offset is converted; date-only values, all-day events and calls with a `timezone` argument are untouched; the same hook repairs `reminders` of to-do/event writes so each item keeps exactly one of `trigger_at`, `minutes_before`, `trigger` in that priority, because the model sends `minutes_before` and `trigger` together and the Nextcloud MCP rejects that; items with none are dropped, other keys stay, and every repair is logged at INFO as `clock: ... reminders ... -> ...`), and `transform_tool_result` appends an `Athens times:` line to calendar and wger-log results. The default profile is excluded and behaves as before.
  - `spoken_reply` (`hermes/plugins/spoken_reply`): `transform_llm_output` hook enabled on `ai-assistant` only (default and every other profile unchanged). It cleans the final reply of a turn for speech: Markdown to plain text (emphasis, headings, links to their text, bare URLs removed, list items and table rows as sentences ending in a period) and removes letters of scripts other than Latin/Greek (stray Cyrillic, Arabic, Hebrew, CJK) and emoji; it never returns an empty text. The logic is a copy of `_speakable` in `speech/gateway/server.py`. Hermes calls the hook once per turn after the tool loop, so it covers the final response of non-streamed requests and the stored/returned `final_response`; text already streamed as SSE deltas by the API server is not rewritten (the TTS gateway cleans again before speaking). Tests: `python3 -m unittest discover -s hermes/tests`.
  - `agents` (`hermes/plugins/agents`): the `ask_agent` tool (one profile consulting another) plus `delegate` and `task_status` (Kanban cards for ai-assistant, see [Agents working together](#agents-working-together-ask_agent-and-kanban-results-in-talk)). Enabled on `ai-assistant` and the 12 specialists `calories`, `finance`, `nextcloud`, `planner`, `web-search`, `n8n`, `models`, `hf-models`, `ai-news`, `selfhosted`, `llamacpp-vulkan`, `llamacpp-rocm`; removed from every other profile.
  - `kanban_notify` (`hermes/plugins/kanban_notify`, hooks only): posts "Done: ..." or "Blocked: ..." to the Talk home room when a Kanban worker finishes or blocks a card. Enabled on the same 12 specialists only.
  - `sandbox_terminal` (`hermes/plugins/sandbox_terminal`): the `sandbox_ssh` terminal backend of every profile and the Talk approval gate (see [Sandboxes and approvals](#sandboxes-and-approvals)).
  - `local_only` (`hermes/plugins/local_only`): local models only. It removes OpenRouter (paid default model), Nous and the API-key providers from the auxiliary fallback chain, which Hermes otherwise walks after a timeout or payment error regardless of config. Every profile also sets `fallback_providers: []`, `auxiliary.free_only: true`, and `auxiliary.title_generation.enabled: false` (a timed-out title call used to load the default model over a running one). `start.sh` also pins every auxiliary task (`vision`, `compression`, `skills_hub`, `approval`, `review`, `mcp`, `title_generation`, `memory_query_rewrite`, `tts_audio_tags`, `triage_specifier`, `kanban_decomposer`, `kanban_estimator`, `profile_describer`, `goal_judge`, `curator`, `monitor`, `background_review`, `moa_reference`, `moa_aggregator`, `session_search`, `web_extract`, `video`, `flush_memories`) to `provider: custom` with the profile's own `base_url`, `api_key` and model and an empty `fallback_chain`, so the "auto" chain is never walked; the plugin also makes any non-custom provider resolution raise. `vision` uses the profile model rather than a vision preset because loading `gemma-4-31b-it-vision` would evict the served model; image input to the text model fails loudly. `delegation` and Hindsight (`api_url` on the hindsight network, no LLM key in Hermes) stay local. The ai-assistant SOUL calls the owner Rafael and has no role-play persona.
  - `nextcloud_talk-platform`, the bridge repository's cron delivery platform, downloaded at the pinned bridge commit and verified by SHA-256 (cached under `plugin-src/` in `data/`).
- Writes `API_SERVER_KEY` into each served specialist's `<profile>/.env`. Under multiplexing a `/p/<profile>/` request is authenticated against that profile's own secrets and fails closed without a key. The CLI-only profiles get no key, and an existing `API_SERVER_KEY=` line is removed from theirs. `devops-diagnose` gets `SELF_HEAL_HERMES_KEY` as its `API_SERVER_KEY` instead, or no key at all when that value is unusable.
- Leaves the profile cron stores alone: jobs that profiles schedule with the `cronjob` tool (or `hermes [-p <profile>] cron create`) survive restarts.
- Writes each SOUL from its profile's own text plus shared blocks. default keeps the long core rule and the "Whose task is it" section (Nextcloud to-dos and events are the user's tasks, the Hermes Kanban is Hermes's work queue, timed work is a cron job, `delegate_task` is for short side jobs). Every other profile gets a short "Rules" block (do the work with tools, retry once, never claim what no tool result shows, one question listing everything missing, answer only) and a short "Working with other profiles" block (to-dos versus Kanban, `kanban_create`, and `ask_agent` for the profiles that have it). The profiles that write datetimes (`nextcloud`, `planner`, `calories`) also get a short "Dates and times" block (Europe/Athens, `clock_now`, `clock_to_utc`). `ai-assistant` and `devops-diagnose` have complete SOULs of their own and get none of these blocks.
- Sampling: every profile except default gets `temperature` (`HERMES_SAMPLING_TEMPERATURE`, 0.6) and `presence_penalty` (`HERMES_SAMPLING_PRESENCE_PENALTY`, 0) in the `extra_body` of its `custom_providers` entry, next to `id_slot`. Hermes 0.20.5 has no per-profile sampling setting, so the request body carries them and they replace the model preset's own values (presence-penalty 1.5 in a preset made small models drop repeated tool arguments). An empty variable keeps the preset's value; default is never changed.
- Disables the old Forage plugin.

`/opt/hermes` is not writable by the `hermes` user, so the plugins live in the profile homes and are enabled through `plugins.enabled`.

## The core rule: work through the MCP tools

default's SOUL includes this rule in full (`SOUL_CORE`); every other profile except `ai-assistant` and `devops-diagnose` has the short "Rules" block with the same intent, and `ai-assistant` has a spoken-reply version of it. A task is done only when the matching tool returned success in that run: calendar events with `mcp__nextcloud__nc_calendar_create_event`, to-dos and reminders with `mcp__nextcloud__nc_calendar_create_todo`, notes with `mcp__nextcloud__nc_notes_create_note`, food with `mcp__wger__search_ingredients` then `mcp__wger__log_ingredient`, research with `mcp__web_search__web_search` and `mcp__web_search__fetch_url`, and Talk notifications with `talk_send`. The rule is also enforced by configuration: every profile disables `todo`, `session_search`, `messaging`, code execution, the browser, the built-in web toolset and skills (`cronjob` and `delegation` are enabled on default only); `memory` is enabled everywhere; the shell (`terminal`) and `file` toolsets are disabled on every profile except the sandbox profiles (`models`, `hf-models`, `llamacpp-rocm`) and the CLI-only `coding` and `devops`.

## Profiles

All profiles use `HERMES_MODEL`. Each profile gets only the tools its job needs: its MCP servers (with per-server tool allowlists), `clock`, its sandbox's `terminal` and `file`, and `talk` (`talk_send`) on default only. `configure_profile` adds to the lists below: `kanban` to every profile except `devops-diagnose` and `ai-assistant`; `agents` (`ask_agent`; `delegate` and `task_status` are used by ai-assistant) to `ai-assistant` and the 12 specialists named above (not to `default`, `devops-diagnose`, `coding`, `devops`); `cronjob`, `delegation` (`delegate_task`) and `web_search` to default only. Every other profile lists `web_search` itself where its job needs it (the `web_search` MCP is still registered for all profiles but the CLI-only ones, whose sandbox cannot reach `hermes-mcp`); cron lists get `kanban` and `web_search`. `clarify` is disabled everywhere: follow-up questions go in the reply. default is the orchestrator: all MCP servers except `diagnose` (the self-heal boundary), the Kanban as its own work queue and `delegate_task` subagents (see [Kanban and subagents](#kanban-and-subagents)). Skills, the built-in web, browser and code tools stay disabled. Hermes runs no cron jobs (the digests are n8n workflows); the `cron` lists only serve the benchmark's cron cases and name exactly the tools those prompts use, or just `clock`.

| Profile | MCP servers in its toolsets | cli and api_server | cron | Role |
| --- | --- | --- | --- | --- |
| default | nextcloud, wger, web_search, firefly, huggingface, n8n (not diagnose) | same, plus talk, clock | clock | Personal assistant and orchestrator for Open WebUI and Talk |
| nextcloud | nextcloud (29 tools by explicit name: calendar and to-do read/create/update/delete, notes create/search/get/append/update, 8 WebDAV, 3 contacts) | nextcloud, clock | nextcloud, clock | Calendars, to-dos, notes, files; `morning-digest` |
| finance | firefly | firefly, clock | firefly, clock | Firefly III only: subscriptions (bills), transactions, accounts; no delete tools; `payments-unpaid` |
| ai-news | web_search | web_search, clock | web_search, clock | r/LocalLLaMA; `ai-news` |
| hf-models | huggingface (`hub_repo_search`, `hub_repo_details`) | huggingface, terminal, file, clock | huggingface, clock | New Hugging Face text models; compares sizes with the served models in `/llama-cpp` (`sbx-hf-models`, read-write `llama-cpp` and `llama-cpp-classifier`); always passes an integer `limit` to `hub_repo_search`; `hf-models` |
| llamacpp-vulkan | web_search | web_search, clock | web_search, clock | llama.cpp Vulkan changes; `llamacpp-vulkan` |
| llamacpp-rocm | web_search | web_search, terminal, file, clock | web_search, clock | llama.cpp ROCm/HIP changes (this server's backend) and llama.cpp code questions from a read-only clone (`sbx-llamacpp`, `/repo`); `llamacpp-rocm` |
| selfhosted | web_search | web_search, clock | web_search, clock | r/selfhosted and r/homelab; `selfhosted` |
| calories | wger (10 tools), web_search (`web_search` only, to identify an unknown food) | wger, web_search, clock | wger, clock | Food log and day totals; never creates to-dos; `calories-report` |
| coding (CLI only) | none | terminal, file, clock | clock | `hermes-sandbox coder`: Docker Compose projects in the mounted folder (typically `~/docker/projects/<name>`), run through the scoped compose proxy at `<name>.<DOMAIN>`; git per milestone, tests, README |
| devops (CLI only) | none | terminal, file, clock | clock | `hermes-sandbox devops`: Compose stacks in the folder `hermes-sandbox` ran in, following its `AGENTS.md`; host Docker and git only with those modules; risky commands need approval; `testbed-docker` only with the testbed module |
| models | huggingface (`hub_repo_search`, `hub_repo_details`), web_search, benchmark (`list_models`, `start_benchmark`, `benchmark_status`, `get_results`, `cancel_benchmark`; only with `BENCHMARK_MCP_TOKEN`) | huggingface, web_search, benchmark, terminal, file, clock | clock | Model manager (`sbx-models`, `/llama-cpp`): downloads, measured router presets, restarts `llama-server` through the restart-only proxy, starts and reads [benchmark](../benchmark/README.md#benchmark-mcp-hermes-models-profile) runs (checks status first, one run at a time) |
| planner | nextcloud (11 calendar/to-do tools, no deletes), firefly (`list_bill`, `list_transaction`, `get_basic_summary`), wger (`nutrition_summary`, `list_log_items`, `list_nutrition_plans`) | nextcloud, firefly, wger, clock | clock | Weekly review, wedding (Γάμος) countdown and chasing, meal and week planning, to-do priorities; asks before creating anything |
| n8n | n8n (11 of 28 tools: nodes, validate, list/get/create/test workflows, executions, health; no update, autofix, delete, credentials, data tables, templates, versions) | n8n, clock | clock | Builds new n8n workflows (created inactive): deterministic nodes first, at most one tool-less LLM step. It cannot change, activate or deactivate existing workflows; it describes changes or creates a corrected copy for the owner to swap in the n8n UI |
| devops-diagnose (self-heal only) | diagnose (`container_list`, `container_logs`, `prom_query`, `loki_query`, `compose_file`, `host_overview`, `host_memory`, `host_processes`, `host_cgroups`, `host_gpu`; all read-only) | diagnose, clock | clock | Called only by the self-heal controller with its own key; diagnoses one Grafana alert and answers with the contract JSON (summary, evidence, proposed `restart_container` or `none`, confidence); `agent.max_turns: 15`; no Talk room |
| web-search | web_search (`web_search`, `fetch_url`) | web_search, clock | clock | Research assistant: searches, reads 2-4 sources fully, answers with numbered citations and a Sources list |
| ai-assistant | nextcloud (`nextcloud_assistant`: 14 calendar, to-do and note tools, including edits and deletes; no files or contacts), web_search (`web_search`, `fetch_url`) | nextcloud_assistant, web_search, clock | clock | The owner's everyday assistant for Hermes-Relay chat and voice (see [The ai-assistant profile](#the-ai-assistant-profile)): spoken-style answers, Nextcloud itself, quick web facts, everything else through `ask_agent` or `delegate` (no `kanban` toolset, no Kanban guidance in its prompt); thinking budget 1024 tokens; the primed profile |

The n8n MCP authenticates to n8n with `N8N_API_KEY` from `n8n/.env`; when that key expires, every n8n workflow call fails with 401 until a new key is created in n8n (Settings, n8n API).

### The default profile is the assistant

The default profile treats every message as a task. It classifies the message (food, appointment, to-do, workout, question, or long specialist work), asks one short follow-up for whatever is missing (food: what, amount, meal, time; events: title, date, time, duration; to-dos: title and due), then calls the tool itself and replies with the created object's id. A workout becomes a completed to-do, because the wger MCP has no workout logging. For long specialist work (news, models, payments) it plans a Kanban card for the profile that handles it. It picks the Nextcloud to-do list by topic (listing the lists first) and names the list it used. The calendar URIs come from [nextcloud/README.md](../nextcloud/README.md#calendars-and-tasks).

### The ai-assistant profile

The owner's everyday assistant: phone voice through Hermes-Relay, and chat. It is a normal served specialist (`/p/ai-assistant/v1`, the shared `API_SERVER_KEY`, no extra key, no Talk room) with the smallest toolset that does the job.

- **Tools:** `mcp__nextcloud_assistant__*` (14: `nc_calendar_list_calendars`, `get_upcoming_events`, `list_events`, `create_event`, `update_event`, `delete_event`, `search_todos`, `create_todo`, `update_todo`, `complete_todo`, `delete_todo`, `nc_notes_create_note`, `search_notes`, `append_content`), `web_search` and `fetch_url`, `ask_agent`, `delegate`, `task_status`, `memory` (built-in plus Hindsight), `clock_now`, `clock_to_utc`. A second registration of the Nextcloud MCP under its own name is needed because the multiplexed gateway applies only default's tool filters (the multiplexed gateway reads only default's `mcp_servers`); both filter lists must stay identical. No `talk_send` (the app is the output), no `delegate_task`, no cron, terminal, file, code or browser tools, no contacts or files.
- **Other profiles:** it has no food, money, file, contact, n8n or model tools. `ask_agent(profile, request)` asks the right profile and waits up to two minutes for the answer, which the assistant then speaks (see [Agents working together](#agents-working-together-ask_agent-and-kanban-results-in-talk)). `delegate(assignee, title, details)` creates a Kanban card (same `create_task` call and `ready` status as a chat's `kanban_create`, `created_by` = `ai-assistant`) for work the owner wants done later, by a deadline, or that will clearly take long; the dispatcher inside the gateway runs it as `hermes -p <assignee> chat -q` within 15 s, `kanban_notify` posts the result to Talk, and the owner later asks "how did it go" (`task_status`). ai-assistant has no `kanban` toolset (its 14 schemas are about 23k characters and Hermes adds about 6.6k characters of Kanban guidance whenever `kanban_show` is available); cards it creates are not auto-subscribed to the chat session. CLI-only profiles and `devops-diagnose` cannot be asked or assigned.
- **SOUL (about 5.8k characters, no character role-play; since 2026-11-06 the reply language is just "the language of his latest message", and the to-do lists, the Forbidden-means-wrong-calendar rule, no unrequested alarms and the `clock_to_utc` worked example are spelled out):** answers in the language of the latest message, plain spoken sentences as long as the answer needs (no sentence limit), no Markdown, URLs, ids, ISO dates or UTC times; confirms only what a tool result in the turn shows, with the item's title and spoken day and time (never "Done" alone); creates new items without asking and asks before changing, completing or deleting an existing one; the to-do list map, the clock rules, quick web facts through its own tools, the other profiles through `ask_agent` and `delegate`/`task_status`, food always to `calories`, no tool call for dictated text or noise, memory only for lasting facts. It has no shared core rule (own rules instead of the core rule).
- **Thinking budget 1024 tokens** (`HERMES_AI_ASSISTANT_THINK_BUDGET`, since 2026-11-05; about 16 s at 63 tok/s; it was capped at 200 tokens until 2026-11-04). It is sent as `reasoning_budget_tokens` in the profile's `custom_providers` `extra_body`, together with `id_slot` and the sampling values; every other profile thinks without a limit.
- `agent.max_turns` 12, approvals strict, no terminal or file tools.
- **Prompt size:** about 18.6-20.8k tokens on the first call before the 2026-11-06 trim (the 14 Kanban tools alone are ~25k characters and cannot be trimmed per tool); removing `cronjob`, `delegation` and the role-play lowers it, the real figure is in `data/cache/prime/state.json` after the next priming. Measured 2026-11-03, `ornith-1.5-9b-dflash`, thinking off: cold, "Reply with OK" evaluated 18,561 tokens in 15.6 s and answered in 19.3 s; primed, the same request evaluated 4 tokens (`f_sim` 1.000, 0.22 s) and answered in 2.6 s; "What is on my calendar today?" (a Nextcloud tool call and the answer) took 4.2 s primed.

#### Hermes-Relay: chat, voice and wake word

The app pairs once with the Hermes dashboard (see [Pairing the app](#pairing-the-app)); the profile is a per-chat and per-voice setting in the app, not a second pairing.

1. Pair the app as described below if it is not yet paired. The profile list comes from the server, so `ai-assistant` appears after `docker compose up -d --force-recreate api`.
2. Chat: select the profile `ai-assistant` in the app's profile selector (the relay passes `profile` with every chat message); new chats then run as that profile.
3. Voice: select the same profile for voice mode (the relay's voice routes take a `profile` too and read that profile's STT and TTS config: `auto` and `assistant`/Jarvis through speech-gateway, so English and Greek switch by themselves).
   Streaming voice output: `start.sh` writes a `voice_output` section into the ai-assistant profile (provider `openai_tts`, model/voice `assistant`, codec `pcm`, 24 kHz) and patches the relay's `voice_lab/providers/openai_tts.py` (idempotent, warns and continues if upstream drifted) to read its endpoint from `HERMES_RELAY_OPENAI_TTS_URL` and key from `HERMES_RELAY_OPENAI_TTS_KEY` (compose: speech-gateway, placeholder key; never api.openai.com). The relay's `/voice/output/session` then streams the speech gateway's sentence-by-sentence PCM (Jarvis) to the phone, so speech starts after the first sentence (about 1.6 s) instead of after the whole reply (about 3 s plus). If the app instead uses the legacy `/voice/synthesize` path it still works, just slower.
4. Wake word: enable it after choosing the profile; it starts the voice mode, which uses the selected profile.
5. Not verified here (no phone): the exact menu names, and that the wake word follows the selected profile. The relay sends the app's chat to the gateway's own API server (`RELAY_WEBAPI_URL`, port 8642), so those turns are API-server calls that the priming plugin captures like any other.

### Sending to Nextcloud Talk

Agents send Talk messages with the `talk_send` tool (toolset `talk`). It takes one argument, `message`, and posts it to `NEXTCLOUD_TALK_HOME_ROOM` as the Hermes bot through the bridge's `/deliver` endpoint. The URL, secret, and room come from the container environment and are not visible to the model. Hermes' own `send_message` tool is not registered as an agent tool in this release, and `mcp__nextcloud__talk_send_message` posts as the Nextcloud user without a notification, so the SOULs point the model at `talk_send`.

Benchmark runs set `HERMES_BENCHMARK=1` on their `docker exec`; `talk_send` then posts only to `HERMES_BENCHMARK_TALK_ROOM` (the mock user's room) and is unavailable without it, never falling back to the real rooms. See [benchmark/README.md](../benchmark/README.md#talk-isolation). The plugin is copied into the profile homes at container start, so a change to it needs `docker compose up -d hermes-api` (or a restart).

The gateway connects the `nextcloud_talk` platform on every profile (it has no inbound side) and does not post restart notices into the room (`platforms.nextcloud_talk.gateway_restart_notification: false`).

## Agents working together (ask_agent and Kanban results in Talk)

Two small plugins let the profiles use each other's tools without growing every prompt.

**`ask_agent(profile, request)`** (plugin `agents`, toolset `agents`) is on `ai-assistant` and the 12 specialists. The `profile` argument is one of `calories`, `finance`, `nextcloud`, `planner`, `web-search`, `n8n`, `models`, `hf-models`, `ai-news`, `selfhosted`, `llamacpp-vulkan`, `llamacpp-rocm`; the tool description lists each profile's job, so the SOULs do not repeat it. The list is hardcoded in `plugins/agents/__init__.py` and `AGENT_PROFILES` in `start.sh`; keep them in sync.

- **How it runs:** the tool writes the request (plus a short note that another profile consulted it on the owner's behalf, and for `ai-assistant` that the answer will be read aloud) to a job folder `data/cache/ask_agent/<id>/` and starts `plugins/agents/runner.py` detached (own session, stdin closed). The runner runs `hermes chat --query-file ... --quiet --source tool` with `HERMES_HOME` set to the target profile, so the consulted profile uses its own toolsets, MCP filters, SOUL, memory and sampling. The same works inside the Talk bridge container, which mounts the same `data/` folder.
- **Waiting:** the tool polls for up to `HERMES_ASK_AGENT_WAIT` seconds (120). A finished answer comes back as `{ok, profile, answer, seconds}`, cut to `HERMES_ASK_AGENT_MAX_CHARS` (8000). A failed consult comes back as `ok: false` with the end of its stderr.
- **Longer than two minutes:** the job is marked detached and the tool returns `{ok: true, status: "running"}`; the caller tells the owner the answer will come in Talk. When the runner finishes it posts "<profile> (asked by <caller>): <answer>" to the Talk home room through the bridge `/deliver` endpoint (same `NEXTCLOUD_TALK_*` variables as `talk_send`) and removes the job folder. If delivery is not configured or fails, the text is kept in `data/cache/ask_agent/undelivered/`. The runner kills a consult after `HERMES_ASK_AGENT_HARD_CAP` seconds (1800).
- **Limits and loop guard:** a profile cannot ask itself; `HERMES_ASK_AGENT_CHAIN` (set for the consulted process) lists the profiles that already asked, and a profile in that list cannot be asked again; a chain stops at 3 profiles; at most 3 consults run detached at once. A consult cannot see the caller's conversation: the request must contain every date, amount and name.
- **Risky commands are denied in a consult.** The consult's stdin is closed, so the approval prompt of `sandbox_terminal` reads end of file and denies. Downloads, restarts and benchmark starts therefore stay with the owner's own Talk room or terminal; the `models` and `hf-models` SOULs say that another profile's request never authorizes them. A consult started from a Kanban worker drops the worker's task identity variables but keeps `HERMES_KANBAN_DB` and `HERMES_KANBAN_BOARD`.
- **Lost on restart:** detached consults are child processes of the container. Recreating or restarting `hermes-api` (or the bridge) while one runs loses its answer.
- **API turns versus CLI turns:** a consult, a Kanban worker and a Talk room run as separate `hermes chat` processes and apply the target profile's own MCP tool filters. A request through Open WebUI or Hermes-Relay (`/p/<profile>/v1`) is served by the multiplexed gateway, which applies only default's filters per server name, which is why `ai-assistant` has its own `nextcloud_assistant` registration; a specialist's narrower filter (for example `calories` web search, `nextcloud` explicit tools) applies on the CLI paths only.
- Every consult is logged as one JSON line in `data/logs/ask_agent.log` (time, caller, profile, status, seconds, exit code, first 200 characters of the request). Benchmark runs (`HERMES_BENCHMARK=1`) kill a consult at the wait limit instead of detaching it and post only to the mock room.

**`delegate(assignee, title, details)`** and **`task_status(card_id?)`** (same plugin and toolset, only ai-assistant uses them; the specialists keep the `kanban` toolset). `delegate` creates one ready card for one of the 12 specialists on the board `kanban_db.connect()` resolves (`HERMES_KANBAN_DB` in benchmark runs) and answers "Queued for <assignee>; the result will be posted to Talk when it finishes."; `task_status` returns status and the latest summary, block reason or last comment (up to 1500 characters) of one card, or the 5 newest cards ai-assistant created.

**`kanban_notify`** (hooks only) enabled on the same 12 specialists: when a Kanban worker completes or blocks a card, it posts "Done: <title> (<assignee>): <summary, at most 3000 characters>" or "Blocked: <title> (<assignee>): <reason>" to the Talk home room. Any card a worker finishes is announced; there is no filter on who created it. Outside benchmark mode the room is `NEXTCLOUD_TALK_HOME_ROOM`; in benchmark mode only `HERMES_BENCHMARK_TALK_ROOM`, otherwise nothing is sent.

Related variables in `hermes/.env`: `HERMES_ASK_AGENT_WAIT`, `HERMES_ASK_AGENT_HARD_CAP`, `HERMES_ASK_AGENT_MAX_CHARS`, `HERMES_SAMPLING_TEMPERATURE`, `HERMES_SAMPLING_PRESENCE_PENALTY` (see `.env.example`). `HERMES_ASK_AGENT_MODEL` (the benchmark sets it) makes a consult use a given model instead of the profile's.

## Long-term memory (Hindsight)

Every profile except the excluded ones uses the self-hosted [Hindsight](../hindsight/README.md) server as its Hermes memory provider (`memory.provider: hindsight`), next to the built-in `MEMORY.md`/`USER.md` (still on, still private per profile). Start the `hindsight` stack first: it creates the external `hindsight` network that `hermes-api` joins (internal network, no internet; Hindsight itself has no authentication and is reachable only from `hermes-api`).

- **One shared bank `hermes`.** Every retained memory carries the tag `profile:<name>` (plus `session:<id>`), but recall is not filtered by tag, so a fact told to `ai-assistant` is recalled in `default` and the other profiles, in any language (EmbeddingGemma 2 is multilingual).
- **Per-profile file.** `start.sh` writes `data/profiles/<name>/hindsight/config.json` (`data/hindsight/config.json` for default) on every start: `mode: local_external`, `api_url: http://hindsight:8888`, `retain_every_n_turns` from `HERMES_HINDSIGHT_RETAIN_EVERY` (1), `recall_budget: mid`, `recall_max_tokens: 800`, **`auto_retain: false`** (saving only through `hindsight_retain`, see the ai-assistant SOUL "Memory" rule), `recall_types: observation,world,experience`, **`memory_mode: tools`** with `auto_recall: false`, plus `bank_mission` and a strict `bank_retain_mission` (only lasting facts the owner states; never the assistant's claims, changing status, stories or garbled speech).
- **Tools mode since 2026-11-04 (factory reset).** With the default `hybrid` mode every turn got recalled memories injected under Hermes' fixed note "Treat as authoritative reference data" plus the plugin's "Do not call tools to look up information that is already present here". Stale status ("X is overdue"), the assistant's own wrong answers and garbled transcripts were stored, recalled as authoritative and repeated instead of checked. Now nothing is injected: the model calls `hindsight_recall` / `hindsight_reflect` when it needs the past, and turns are still retained. On 2026-11-04 the bank, every profile's sessions (`state.db`, `sessions/`, `webui/sessions/`) and built-in memories (`memories/`) were deleted; backups are in `data/backups/factory-reset-20261104/` (`hermes-sessions-memories.tar.gz`, `webui-sessions.tar.gz`, `hindsight-db.dump` as `pg_dump -Fc`). The plugin ignores every `HINDSIGHT_*` variable once this file exists, so no cloud mode or API key can be selected by accident; no data leaves the machine.
- **Why retain every turn.** The gateway builds a new agent (and plugin instance) per message and the plugin's turn counter lives in it, so `retain_every_n_turns` above 1 never fires in the API/gateway path. Each turn is retained asynchronously; the extraction and consolidation calls run on Ornith through `hindsight-relay` (a few seconds each, off the reply path).
- **Where recall went (hybrid mode, before 2026-11-04).** With `recall_sync` the recall for the current message (0.05-0.2 s, a few hundred tokens) is injected into that turn's *user message* inside a `<memory-context>` block, never into the system prompt. The system prompt only gains a fixed three-line `# Hindsight Memory` block and the tool list gains `hindsight_retain`, `hindsight_recall` and `hindsight_reflect`, so the prompt prefix stays stable and priming keeps working (below). A plain "remember that ..." is usually answered with the built-in `memory` tool (private, that profile only); the Hindsight copy is made by the automatic retain of the turn.
- **Switch.** `HERMES_MEMORY_PROVIDER` in `hermes/.env` (unset or `hindsight` = on, empty = built-in memory only), then `docker compose up -d api`. Off removes `memory.provider: hindsight` from the profiles; the config files and the bank stay. `HERMES_MEMORY_EXCLUDE` (default `devops-diagnose coding devops`) lists profiles that never use it: `devops-diagnose` is the read-only self-heal boundary, and `coding` and `devops` run in throwaway sandbox containers that cannot reach the `hindsight` network. Remove a name from the list to include it.
- **Cron and benchmark runs.** A cron job is one turn per run (no per-platform setting exists in the plugin), so with the default it is recalled into but retained only if the job itself calls `hindsight_retain`. The benchmark harness runs every case in a throw-away `HERMES_HOME` copy (`/tmp/bench-home`) without the Hindsight config, so the plugin is unavailable and contacts nothing; benchmark prompts never reach the shared bank, real memories never reach the benchmark prompts, and the built-in memory, skills, cron jobs and sessions of a case live in the copy only. With `HERMES_BENCHMARK=1`, `plugins/local_only/benchmark_sandbox.py` also answers writes to real systems with fake successes (see `benchmark/README.md`, "Sandbox").
- **Inspecting and deleting.** The API has no UI: `docker exec hindsight python -c ...` against `http://127.0.0.1:8888/v1/default/banks/hermes/memories/list`; `DELETE /v1/default/banks/hermes/memories` empties the bank.
- **Backup.** `hindsight/postgres` (see the Hindsight README).

## Prompt priming and compaction

**Prompt priming (`prompt_prime` plugin).** The first call of a profile (system prompt + tool schemas) is large: the default profile sends 39,157 tokens, ~29 s to evaluate cold at ~1,350 tokens/s, ai-assistant 18,561 tokens (~15 s). The plugin (`hermes/plugins/prompt_prime`, enabled in every profile by `start.sh`) does two things:

1. An LLM request middleware (observer only) saves the exact provider payload (model, system prompt, 75 tool schemas, sampling options) of the first call of every API-server session of each profile as `data/cache/prime/<profile>.json`, with the user message replaced by `ping` (no user text, no API key stored). It is refreshed by every new session, so memory/date changes in the system prompt are picked up.
2. In the gateway process a thread first rebuilds the template of the primed profile from the live configuration (`_build_template`: an `AIAgent` constructed exactly like the API server does, with no session DB, then `_build_system_prompt` and `_build_api_kwargs`; it never calls a model, creates no session and does not touch Hindsight), at start and whenever that profile's `config.yaml` or `SOUL.md` changes. Changes to SOUL, tools or MCP servers therefore reach the primed slot without a chat; a real captured request still overwrites it. Checked 2026-11-04: the built body was identical to the one captured from a real ai-assistant API request (system prompt, 34 tools, keys), and that request evaluated only 973 of 18,535 prompt tokens. Then it replays the template of `HERMES_PRIME_PROFILE` (default `ai-assistant`, the owner's everyday profile; set it in `hermes/.env` to switch, e.g. back to `default`, then `docker compose up -d api`; the profile needs one API session once so `data/cache/prime/<profile>.json` exists) straight to llama.cpp with `max_tokens` 1, no streaming, and an explicit `id_slot`. It creates no Hermes session, Talk message or memory write. **Idle rule:** every `HERMES_PRIME_INTERVAL` (120 s; 0 disables), 30 s after the gateway starts, the thread replays only when the template's model is `loaded` in the router and the primed slot is not processing (other slots may be busy), and one of these holds: it has not primed before (or the profile or the template file changed), the slot it primed no longer holds its prompt (the model was just (re)loaded, or the slot was reused by another request), or the last priming is older than `HERMES_PRIME_STALE` (600 s). Slot choice: always `HERMES_SLOT_PRIMED` (default 0; see [llama.cpp slot reservation](#llamacpp-slot-reservation)). The slot and prompt length of the last priming are kept in `data/cache/prime/state.json`, so a container restart reuses them. Gaps: (a) nothing happens while another model holds the router (`--models-max 1`) or Ornith is unloaded; the first replay comes within about 2.5 minutes after Ornith is loaded again, (b) a profile that has never had an API session has no template, (c) a real ai-assistant conversation in slot 0 changes its token count, so the next idle check replays the template there (a cheap prefix re-use, the conversation tail is overwritten), (d) up to ~2 minutes (plus the load) pass before the first priming, so a request in that window is cold, (e) a changed system prompt (memory, tools) is re-evaluated from the first differing token until a new session refreshes the template, and (f) it keeps one prompt warm, so other profiles stay cold (default: ~39k tokens, ~30 s).

**llama.cpp slot reservation.** `ornith-1.5-9b-dflash` has 3 slots of 64k. llama.cpp picks a slot by longest-common-prefix similarity unless the request carries `id_slot`; before the reservation other prompts (f_sim 0.68-0.73) landed in the primed slot and forced 13 s re-primes. Now every client is pinned (b11957: the router forwards `id_slot` to the child, log `selected slot by id (N)`; a request for a busy slot is deferred and queued, not rejected, and never spills to another slot):

| Slot | Traffic | Where it is set |
|---|---|---|
| 0 | the primed profile (`HERMES_PRIME_PROFILE`, ai-assistant) and the prompt_prime replay | `HERMES_SLOT_PRIMED` (start.sh writes `id_slot` into that profile's `custom_providers` `extra_body`, next to its reasoning budget) |
| 2 | every other Hermes profile (default, specialists, cron, Kanban workers) | `HERMES_SLOT_OTHERS` (same mechanism) |
| 1 | Hindsight retain, consolidation and reflect | `HINDSIGHT_API_LLM_EXTRA_BODY={"id_slot": 1}` in `hindsight/docker-compose.yml` |

Trade-off: other profiles now share slot 2, so two concurrent non-ai-assistant requests queue (Kanban runs at most 2 workers, so a second worker waits for the first request, not for a whole task) and a profile switch on slot 2 re-evaluates its prompt (default ~39k tokens, ~30 s) instead of finding a slot with a similar prefix. Slot 1 is used only by Hindsight, whose calls are serial (`MAX_CONCURRENT=1`). `HERMES_SLOT_OTHERS=-1` removes the pinning of all other profiles (they then fall back to similarity selection and can evict slot 0 again). Not pinned: Open WebUI talking to llama-server directly and the n8n digest workflows (see llama-cpp/README.md); they use LCP selection and can still take slot 0 if it is the closest match or the least recently used.

**Recovery after restarts (measured 2026-11-03, Ornith DFlash, `HERMES_PRIME_PROFILE=ai-assistant`).** All containers are `restart: unless-stopped`; the `hindsight` network is created by the hindsight stack, so start hindsight (and speech, llama-cpp) before hermes after a cold boot; Hermes itself needs no ordering against speech/llama-cpp because both warmers retry.

| Event | What reloads | Time |
| --- | --- | --- |
| `hermes-api` recreated | nothing to load; prompt_prime replays the template (19,113 tokens, 13.2 s) | primed about 1 min after start |
| `audiocpp-tts` restarted | speech-gateway warmer (15 s loop) loads Jarvis | about 25 s |
| `llama-server` restarted | router loads Ornith (`load-on-startup`) in about 7 s; Jarvis stays loaded; prompt_prime re-primes on its next 120 s tick (19,041 tokens, 13.4 s) | model 7 s, primed about 90 s (up to ~2.5 min) |
| another llama model used (e.g. paperless) | warmer parks audio.cpp on Phonon; when that model sleeps (default `sleep-idle-seconds` 300) or unloads, the warmer reloads Ornith within 15 s, then Jarvis, then prompt_prime within 120 s | model about 5 min after the other model's last request, then about 2 min; this path was reasoned from the warmer code, not triggered |

Measured 2026-11-03 on `ornith-1.5-9b-dflash` (3 x 64k, q8_0 KV, `checkpoint-min-step` 2048): a cold default-profile request ("Reply with OK") evaluated 39,159 tokens in 29.1 s and finished in 36.7 s; after unloading and reloading the model and one priming (29.6 s, in the background) the same request evaluated 13 tokens in 0.38 s (`f_sim` 1.000) and finished in 8.7 s, all of it generation (reasoning on). With Hindsight (2026-11-03) the ai-assistant first call grew from 18,561 to 19,113 tokens (+3 tools, +1 system block); a fresh session after priming evaluated only the 317 tokens of the user message plus recalled memories (`f_sim` 0.984, 0.6 s). Limitation: tools or MEMORY changed since the template was stored are re-evaluated from the first differing token only.

**Compaction.** `start.sh` sets `compression.enabled: true` and `compression.threshold` from `HERMES_COMPRESSION_THRESHOLD` (default 0.8) in every profile. The threshold is a fraction of `model.context_length` (65536, one slot) compared with the whole request (system prompt, tools, messages): 0.8 is ~52k tokens, leaving ~13k for the reply and tool output. Hermes' 0.5 default (32,768) is below the default profile's first call; Hermes itself floors models under 512k context at 0.75. `target_ratio` (0.2) and `protect_last_n` (20) are unchanged.

## OpenAI-compatible API per profile

`gateway.multiplex_profiles` is on, so the default gateway serves every profile in `gateway.multiplex_profile_allowlist` on one listener. Specialists keep `platforms.api_server.enabled: false`; the multiplexer refuses to start if a secondary profile enables a port-binding platform.

| Profile | Base URL inside Docker | `/v1/models` id |
| --- | --- | --- |
| default | `http://hermes-api:8642/v1` or `http://hermes-api:8642/p/default/v1` | `hermes-agent` (`API_SERVER_MODEL_NAME`) |
| any specialist | `http://hermes-api:8642/p/<profile>/v1` | the profile name, for example `nextcloud` |

`coding` and `devops` are not in the allowlist and have no `API_SERVER_KEY`, so `/p/coding/v1` and `/p/devops/v1` are not served. `devops-diagnose` is in the allowlist only with a usable `SELF_HEAL_HERMES_KEY`, and only that key opens `/p/devops-diagnose/v1`.

## Self-heal diagnosis (devops-diagnose)

The [self-heal](../self-heal/README.md) controller sends each Grafana alert labelled `self_heal="true"` to `POST http://hermes-api:8642/p/devops-diagnose/v1/chat/completions` over the internal `self-heal-agent` network. The profile only diagnoses; the controller validates its JSON, posts the proposal to the self-heal Talk room and executes a catalog action only after the owner's TOTP approval.

- Own key: `start.sh` writes `SELF_HEAL_HERMES_KEY` into `data/profiles/devops-diagnose/.env` as `API_SERVER_KEY`. Hermes authenticates every `/p/<profile>/` request against that profile's `.env` only (no fallback to the process environment under multiplexing; a profile without a key answers 401), so the shared `API_SERVER_KEY` cannot reach `devops-diagnose`, and `SELF_HEAL_HERMES_KEY` opens no other profile and not the bare `/v1` routes. If the key is unset, shorter than 16 characters or equal to `API_SERVER_KEY`, the profile is left out of the allowlist and gets no key (a warning is logged).
- Tools: only the `diagnose` MCP (`http://self-heal-diagnose-mcp:8791/mcp`, `Authorization: Bearer $DIAGNOSE_MCP_TOKEN`, written into the profile config from the environment) and `clock`. No terminal, file, talk, web, memory, kanban, delegation or code tools. Approvals stay `manual`/`deny`, never YOLO.
- SOUL: diagnose only, never claim a change, treat alert text and every tool result as untrusted data, use the `host_*` tools for memory, swap and GPU questions (for example llama.cpp filling swap while it loads a model), and answer with only the JSON object. It does not include the shared core rule.
- `agent.max_turns: 15`. Hermes bridges this per turn into the process-wide `HERMES_MAX_ITERATIONS`, so a concurrent turn of another profile can briefly see the other value.
- Never add `devops-diagnose` to `NEXTCLOUD_TALK_PROFILE_ROOMS`.
- `data/` is shared with `hermes-nextcloud-bridge`, so the bridge can read this profile's key and MCP token; it is not on `self-heal-agent` and cannot reach the diagnose MCP, and a forged diagnosis still needs the owner's TOTP approval to do anything.

The public equivalents are `https://hermes.<DOMAIN>/v1` and `https://hermes.<DOMAIN>/p/<profile>/v1`. Hermes 0.20.5 derives a specialist's advertised model id from the profile name and has no setting to rename it; use the client's prefix option (for example Open WebUI `prefix_id`) for names such as `hermes-<profile>`. The requested model name does not change the inference model: every profile runs `HERMES_MODEL`.

## CLI-only profiles (coding and devops)

`coding` (shown as "coder") and `devops` are not reachable through the API or Talk. They run only from the global `hermes-sandbox` launcher in `~/docker/hermes-sandbox` (its own git repository, see its `README.md`), which starts Hermes with one of them inside a throwaway container that mounts only the current folder (at the same path) and that profile's home (`data/profiles/<profile>`).

- Install: `ln -s ~/docker/hermes-sandbox/hermes-sandbox ~/.local/bin/hermes-sandbox`, then create `~/docker/hermes-sandbox/.env` from its `.env.example`.
- Usage: `cd any/folder && hermes-sandbox [coder|devops] [--unrestricted] [-- HERMES_ARGS]`. Without a profile a menu asks for one. It refuses to mount `/` or your home folder, and masks `hermes/data` when the folder contains it.
- Modules are picked per run (`--unrestricted` skips the questions): `internet`, `git` (your git identity and SSH agent), `compose` (a scoped Docker API proxy that allows only the current folder's compose project, its Traefik host `<project>.<DOMAIN>` and no privileged options), `docker` (the full host socket, root-equivalent, confirmed separately), `testbed` (the disposable Docker daemon in [hermes-sandboxes](../hermes-sandboxes/README.md)) and `readonly`. Defaults: coder `internet` + `compose`; devops `internet` + `git` + `docker`.
- Projects for the coder live in `~/docker/projects/<name>` (see its `README.md`), each a normal Compose stack with its own git repository.

- `start.sh` still creates them, installs their plugins, writes their config and SOUL, but leaves them out of `gateway.multiplex_profile_allowlist` and gives them no `API_SERVER_KEY`.
- Their config has `homelab_sandbox: {mode: local, ...}` and no SSH host. The `sandbox_terminal` plugin then uses Hermes' local terminal backend in the current folder, but only when `HERMES_LOCAL_SANDBOX=1`, which only the hermes-sandbox container sets. Anywhere else (for example `docker exec hermes-api hermes -p devops ...`) the terminal refuses to run, so no command ever runs inside `hermes-api`.
- Toolsets are `terminal`, `file` and `clock`; the web_search MCP is dropped because `hermes-mcp` is not reachable from the hermes-sandbox container (with the internet module they can use `curl`).
- Approvals stay `manual` with the same `devops` homelab rules; Hermes asks in the terminal. A one-shot `-q` run denies risky commands (`single_query_mode: deny`).
- Remove any `coding=` and `devops=` entries from `NEXTCLOUD_TALK_PROFILE_ROOMS` in both `.env` files; such a room would only get terminal refusals.

## Sandboxes and approvals

Only `models`, `hf-models` and `llamacpp-rocm` have SSH sandboxes. Their commands and file reads and writes run over SSH in their own container of the [hermes-sandboxes](../hermes-sandboxes/README.md) stack, never in `hermes-api`:

```text
 Open WebUI ─/p/<profile>/v1─► hermes-api ─────────┐   no Docker socket, no repository mounts
 Talk ─► hermes-nextcloud-bridge (hermes chat -q) ─┤   client keys: data/sandbox-keys/<profile>/
                                                   │   ssh: pinned host key, one key per profile
                  hermes-sandbox network (internal)│
          ┌────────────────────────────────────────┼──────────────────────┐
          ▼                                        ▼                      ▼
 sbx-hf-models                                 sbx-models             sbx-llamacpp
 /llama-cpp, /llama-cpp-classifier             /llama-cpp, router     /repo (read-only)
 (read-write), egress                          API, restart-only
                                               Docker proxy
```

- Every profile's `terminal.backend` is `sandbox_ssh` (plugin `sandbox_terminal`). The multiplexed gateway applies the default profile's terminal settings process-wide, so the per-profile `terminal.ssh_*` keys would be ignored there; the plugin instead reads `homelab_sandbox` (host, key, `known_hosts`, cwd) from the config of the profile that serves the turn, and raises an error for a profile without one. A cached sandbox connection also refuses to run for any other profile.
- `HERMES_WRITE_SAFE_ROOT` adds `/work`, `/homelab` (both legacy), `/llama-cpp` and `/llama-cpp-classifier` so `write_file` and `patch` accept sandbox paths. Those paths do not exist in `hermes-api`.
- Keys: `hermes-sandboxes/setup-keys.sh` creates `/home/hermes/.hermes/sandbox-keys/<profile>/id_ed25519` and `known_hosts` in `data/`. SSH runs with `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes` and that profile's `known_hosts` only.

Risky commands need the owner's approval (YOLO stays off; `approvals.mode: manual`, `cron_mode: deny`):

- Patterns: Hermes' own dangerous-command list (recursive deletes, `chmod 777`, `git reset --hard`, force push, `docker restart/stop/kill`, `docker compose down`, `--context`/`-H` daemon redirects, ...) plus homelab rules in `homelab_sandbox.extra_dangerous`: for `devops` (hermes-sandbox) any host `docker` lifecycle, delete, `run`, `exec`, `pull`/`build`, `compose up/down/...`, `git commit/push/reset/clean/restore/rebase`, and edits to `.env` files; for `models` Docker lifecycle and deleting `.gguf`/`.safetensors` files; for `hf-models` deleting `.gguf`/`.safetensors` files. `testbed-docker` is not covered by the homelab rules (Hermes' own patterns still apply to it).
- Talk (the usual way): the bridge runs `hermes chat -q`, where Hermes itself cannot prompt (`approvals.single_query_mode`). The SSH sandbox profiles therefore set `single_query_mode: approve`, and the plugin's `pre_tool_call` hook is the gate: it prints the bridge's approval marker and waits. The bridge (`TALK_APPROVAL_PROMPTS=1`) posts **⚠️ Approval required** with the redacted command and the reason into the profile's room. The owner replies in that room with `/approve once` (also `yes`, `ok`, `approve`), `/approve session` (same pattern allowed for the rest of that run) or `/deny` (also `no`). No reply within `TALK_APPROVAL_TIMEOUT` (600 s) denies. A denied command returns BLOCKED to the agent, whose SOUL tells it not to retry or rephrase but to ask. The hook lives in the same plugin as the terminal backend, so the terminal cannot run without the gate.
- Open WebUI (`/p/<profile>/v1`): Hermes' gateway approval flow applies to its own patterns, and the homelab rules are escalated to it by the plugin.
- Hardline commands (`rm -rf /`, `mkfs`, `dd` to a disk, shutdown, fork bombs) are always blocked.

## Scheduled digests (moved to n8n)

Hermes runs no digest cron jobs. The digests that used to be Hermes cron jobs are deterministic n8n workflows named `Hermes digest – <job>` (files in [`n8n/workflows/hermes-digest-*.json`](../n8n/README.md#hermes-digests)). Fetching, filtering, dates, and formatting are code; at most one LLM call without tools writes one-line summaries, and `morning-digest`, `payments-unpaid`, `calories-report` and `hf-models` use no model at all. Small models looped on tool calls and leaked reasoning into Talk when they ran these jobs as agents. Each workflow posts to the same profile Talk room through the bridge `/deliver` endpoint and posts nothing when there is nothing to report.

| Job | Talk room (profile) | Athens time |
| --- | --- | --- |
| morning-digest | nextcloud | 08:00 |
| payments-unpaid | finance | 08:00 |
| ai-news | ai-news | 08:02 |
| selfhosted | selfhosted | 08:06 |
| hf-models | hf-models | 08:10 |
| llamacpp-vulkan | llamacpp-vulkan | 08:14 |
| llamacpp-rocm | llamacpp-rocm | 08:18 |
| calories-report | calories | 22:00 |

The profiles stay: they serve chat, their Talk rooms, and the Hermes benchmark (whose task prompts are frozen under `benchmark/benchmarks/hermes/tasks/`).  `start.sh` still configures the `cron` platform toolsets and installs the `nextcloud_talk` delivery platform; both are harmless without jobs.

Check that no job is left:

```bash
docker exec hermes-api hermes -p ai-news cron list
```

Old outputs remain under `profiles/<profile>/cron/output/` in `data/`.

## Operations and troubleshooting

### Kanban and subagents

The Hermes Kanban is Hermes's own work queue: default (and any other profile with `kanban`) creates cards (`kanban_create`) assigned to a specialist profile, and the dispatcher inside the gateway (`kanban.dispatch_in_gateway: true`, 15 s tick) runs each card as `hermes -p <profile> chat -q`. Board data lives in `data/kanban`. Nextcloud to-dos (the "Homelab" list and others) are the user's own to-dos; no profile puts its own work there nor the user's to-dos in Kanban (the shared "Whose task is it" SOUL section).

- Every profile except `devops-diagnose` lists `kanban`. Hermes also gives a dispatcher-spawned worker the card tools (`kanban_complete`, `kanban_block`, `kanban_heartbeat`, `kanban_comment`) whatever its profile toolsets say, so no profile disables `kanban` (a disabled toolset would strip those tools).
- Cards that cron jobs drive instead of a one-shot worker are parked with `hermes kanban schedule <id> <reason>` (status `scheduled`), which the dispatcher skips. CLI-only profiles (`coding`, `devops`) cannot be dispatched: block their cards until the owner starts `hermes-sandbox`.
- Concurrency: llama.cpp has 3 slots and `--models-max 1`. `max_in_progress` and `max_spawn` are 2 and `max_in_progress_per_profile` is 1, which leaves one slot for the user's own turn. `auto_decompose` and `review_dispatch` are off.
- `delegate_task` (default only): subagents inherit the parent's local model (`delegation.model/provider/base_url` empty, no cloud fallback), at most 2 at once per parent. Subagents cannot schedule cron jobs.
- The Talk bridge passes each room its profile's cli toolsets, so every room except `devops-diagnose` (which has none) carries the Kanban tools (and `ask_agent` for the specialists). Cards a worker completes or blocks are announced in the Talk home room by `kanban_notify`.
- default has no `diagnose` MCP.

If cards stay in `ready` while gateway logs say another gateway holds the dispatcher lock, an orphaned `kanban/.dispatcher.lock` can block dispatch after an unclean restart; API startup removes that file when it is not held by a live `fcntl` lock.

## Connecting Hermes-Relay

[Hermes-Relay](https://github.com/Codename-11/hermes-relay) is an Android app for Hermes (chat, voice, media, phone bridge, optional terminal). `start.sh` runs its server side next to the gateway, in the same container:

| Piece | Route | Inside the container |
| --- | --- | --- |
| Web dashboard (`hermes dashboard`, password login) | `https://hermes-dash.<DOMAIN>` | `0.0.0.0:9119` |
| Relay server (`hermes relay`, WebSocket) | `wss://hermes-relay.<DOMAIN>` | `0.0.0.0:8767`, no TLS (Traefik terminates it) |
| Hermes API (chat, unchanged) | `https://hermes.<DOMAIN>` | `0.0.0.0:8642` |

All three are Traefik routers on the one `hermes-api` container, with one Homepage entry. No host ports are published. Keep them behind the WireGuard VPN like the rest of the stack: the dashboard login and the pairing code are the only protection, and the dashboard can edit configuration and API keys.

Timeouts (read from the relay source, checked 2026-11-06): the relay's HTTP client to the gateway for chat has no total or read timeout (`relay/channels/chat.py`: `ClientTimeout(total=None, connect=10)`), so a turn that waits two minutes for an `ask_agent` answer is not cut off by the relay. The phone app's own request timeout is not part of this repository and was not checked. Only the optional Secure Link proxy (`relay/secure_proxy.py`: 15 minutes total, 120 seconds without data) has a shorter limit; this setup does not use it, and `start.sh` does not patch that file.

What `start.sh` does, only when enabled:

- Downloads the plugin directory `plugin/` of Hermes-Relay `server-v1.13.1`, pinned by commit (`RELAY_REF` in `start.sh`), into `data/plugins/hermes-relay` (default profile only) and enables it through `plugins.enabled`. `hermes plugins install` cannot be used: its scanner rates the repository "dangerous" and `--force` does not override that. The code is reviewable at the pinned commit; bump `RELAY_REF` to upgrade.
- Installs the two Python packages the plugin needs and the image lacks (`segno`, `websocket-client`) into `data/relay/deps` (`PYTHONPATH` in the compose file points there). Needs internet access on first start.
- Starts `hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build` and `data/relay/launch.py --no-ssl` (the relay) as background processes in restart loops; their output appears in `docker logs hermes-api` prefixed `[dashboard]` and `[relay]`. If one dies it is restarted after 30 seconds and the gateway is not affected.

Settings in `.env`:

| Variable | Meaning |
| --- | --- |
| `HERMES_DASHBOARD_ENABLED` | `true` (default) or `false`. The dashboard also needs a usable password, see below. |
| `HERMES_DASHBOARD_USERNAME`, `HERMES_DASHBOARD_PASSWORD` | Dashboard login (Hermes basic-auth provider; the password is hashed in memory). Hermes refuses a non-loopback bind without an auth provider, so `start.sh` serves the dashboard only when the password is set and not `CHANGE_ME`, and logs a notice otherwise. Generate with `openssl rand -base64 24`. Dashboard sessions are signed with a key derived from the password, so they survive restarts and end when the password changes. |
| `HERMES_RELAY_ENABLED` | `true` (default) or `false`. |
| `HERMES_RELAY_TERMINAL_ENABLED` | `false` (default). See the warning below. |

The relay's terminal channel opens a PTY shell as the `hermes` user **inside `hermes-api`**, which holds every secret of this stack in its environment and in `data/` (all profile `.env` files) and sits on the `backend`, `hermes-mcp` and `hermes-sandbox` networks. That contradicts the rule that terminal and file tools run only in sandboxes, and the relay has no setting to turn it off. `data/relay/launch.py` therefore replaces the relay's terminal handler with a refusal unless `HERMES_RELAY_TERMINAL_ENABLED=true`; the app's terminal tab then shows "Terminal is disabled on this server". Chat, voice, media and the phone bridge are unaffected. The relay can start a different shell through `RELAY_TERMINAL_SHELL` (an absolute path to an executable), which could in principle be a wrapper that connects to a sandbox over SSH; that is untested here. The Hermes dashboard's own Chat tab runs the agent, not a raw shell, and uses each profile's configured tools.

### Pairing the app

1. Set `HERMES_DASHBOARD_PASSWORD` in `.env` (and optionally the other variables above), then recreate the container: `docker compose up -d --force-recreate api` in `hermes/`. The first start downloads the plugin and packages.
2. Connect the phone to the VPN, open `https://hermes-dash.<DOMAIN>` and sign in. Open **Relay** in the dashboard and choose **Pair new device** to show a QR code.
3. In the app scan the QR code. It carries the dashboard origin (`HERMES_DASHBOARD_PUBLIC_URL`, set to `https://hermes-dash.<DOMAIN>` by the compose file), the relay session code and the Hermes API key. The relay is reached through the dashboard origin (`wss://hermes-dash.<DOMAIN>/api/plugins/hermes-relay/transport`), so the separate `hermes-relay.<DOMAIN>` route is only the legacy direct route.
4. From a shell instead of the dashboard: `docker exec -it -u hermes hermes-api hermes pair --mode public --public-url https://hermes-dash.<DOMAIN>`; add `--legacy-direct-relay` to also advertise `wss://hermes-relay.<DOMAIN>` (use `--no-qr` for text only). Manual entry in the app: API URL `https://hermes.<DOMAIN>` with `API_SERVER_KEY`, Relay URL `wss://hermes-relay.<DOMAIN>` with the pairing code.
5. Check the server with `docker exec -u hermes hermes-api hermes relay doctor`, or `curl https://hermes-relay.<DOMAIN>/health` from the VPN. Paired devices are listed and revoked on the dashboard's Relay page.

Backup: `data/relay/` and `data/plugins/hermes-relay` are recreated by `start.sh`; the paired-device list is `data/hermes-relay-sessions.json` (back it up with the rest of `data/`; losing it only means re-pairing). Rollback: set both switches to `false`; `start.sh` removes the plugin from `plugins.enabled` and stops starting the processes.

## Storage and backups

Back up:

- `data/` (bind mount, ignored by Git): configuration, SOULs, sessions, Kanban, cron jobs and outputs, sandbox client keys, and the profile `.env` files (secrets: keep backups private)
- the `hermes-agent-src` volume: agent source mounted at `/opt/hermes` (can be recreated from the image)

When upgrading the Hermes Agent image, recreate `hermes-agent-src` so it is seeded from the new image, and rebuild `hermes-nextcloud-bridge` with the same `HERMES_AGENT_VERSION`:

```bash
docker compose down
docker volume rm hermes_hermes-agent-src
docker compose pull
docker compose up -d
```

Confirm the project-prefixed volume name with `docker volume ls` before removing it.

## Architecture and security

The API uses the internal `backend` network, `hermes-mcp`, `hermes-sandbox` (SSH to the sandboxes), and `webgateway`. No host ports are published. Traefik routes `Host(hermes.<DOMAIN>)` to port 8642, including the `/p/<profile>/` routes, all behind `API_SERVER_KEY`. MCP and plugin tools run inside the API container; the terminal and file tools run only in the sandboxes, and code execution is disabled on every profile. `hermes-api` has no Docker socket and no host folders: `devops`, the only profile that can reach the host Docker socket, is not served by the API or Talk; it runs only from the `hermes-sandbox` CLI on the host, and only when the docker module is on.

`hermes-api` also joins the internal `self-heal-agent` network. There the self-heal controller calls `devops-diagnose` with its own key, and `devops-diagnose` reads the homelab through the self-heal diagnose MCP, which is read-only by construction (GET-only Docker and query proxies, a fixed-field host probe; no exec, inspect or secrets). Assume that profile can be prompt-injected through logs or alert text: it can only propose, and only the controller executes an allowlisted restart after the owner approves it with a TOTP code. The `n8n` profile has no tool that changes an existing workflow, so a prompt-injected n8n run cannot alter the live workflows; it can still create new, inactive ones and run existing ones with `n8n_test_workflow` (whose `exposeToMcp` option turns on a workflow's "Available in MCP" setting).

## Validation

```bash
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose ps
docker exec hermes-api sh -c 'curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/p/nextcloud/v1/models'
docker exec hermes-api hermes -p calories config get model.default
docker exec hermes-api hermes -p devops config get terminal.backend      # sandbox_ssh
docker exec hermes-api hermes -p devops config get homelab_sandbox.mode  # local
docker exec hermes-api hermes -p hf-models config get homelab_sandbox.host  # sbx-hf-models
```

## Upstream documentation

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [nextcloud-talk-hermes-bridge](https://github.com/robertlmann02/nextcloud-talk-hermes-bridge)
