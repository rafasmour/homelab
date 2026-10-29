# Benchmark

Compares llama.cpp router models as the brain of the Hermes agent profiles. It
runs the profiles' real jobs through `hermes-api`, checks correctness,
rule-following and speed, stores every result in SQLite
(`data/benchmark.db`) and generates Markdown, JSON and Excel reports with
charts from it.

The stack has two containers:

- `benchmark`: the runner. It has no published ports and no Traefik or
  Homepage labels. PID 1 is `api.js`, a small job API; you can still start a
  run with `docker exec`.
- `benchmark-mcp`: an MCP server that lets the Hermes `models` profile start
  and read runs. See [Benchmark MCP](#benchmark-mcp-hermes-models-profile).
- `benchmark-ui`: a read-only results browser at `https://benchmark.${DOMAIN}`
  (Homepage group AI), behind its own login page. See [Results UI](#results-ui).

## Security

- **The Docker socket is mounted, and access to it is root-equivalent on the
  host.** The runner uses it only for `docker exec` into `hermes-api` (to run
  Hermes and read its logs and session database read-only) and `llama-server`
  (GPU sysfs readings and `docker logs` timings). Do not expose this container
  or add other tools to it.
- `LLAMA_API_KEY` (same as `llama-cpp/.env`) lets the runner load and unload
  router models. `MCP_STATIC_TOKEN` (same as `wger/.env`) authenticates against
  the wger MCP server. Both live only in the ignored `.env` file.
- The Hermes chat cases write real items **on the test date 2027-01-15**: a wger
  food log, a Nextcloud to-do and a Nextcloud event. Each case deletes what it
  created. The run also takes a snapshot first and runs a final cleanup in a
  `finally` block, even after an abort or an error. That cleanup removes new
  test-date items in wger and Nextcloud and any Firefly bill or transaction
  created during the run, deletes `/tmp/bench_*` in `hermes-api`, and verifies
  that the test date is empty. The runner never deletes items that existed
  before the run.
- Reports and the database contain transcripts and answers with personal data
  (calendar, finance and nutrition). `reports/` and `data/` are ignored by Git.
- `benchmark-ui` is view-only and has its own login page. The username and
  password come from `BENCHMARK_UI_USERNAME` and `BENCHMARK_UI_PASSWORD` in
  `.env`. A signed, HttpOnly session cookie lasts 7 days, and a restart logs
  everyone out. Ten failed logins from one address lock it out for 15
  minutes. Every API path answers 401 without a session. It has no
  Docker socket, runs as an unprivileged user with a read-only root
  filesystem, and mounts `data/` and `reports/` read-only.

## Setup

```sh
cp benchmark/.env.example benchmark/.env   # then set LLAMA_API_KEY, MCP_STATIC_TOKEN and BENCHMARK_TALK_ROOM
stat -c %g /var/run/docker.sock            # put this in DOCKER_SOCKET_GID
docker compose --env-file benchmark/.env -f benchmark/docker-compose.yml config --quiet
docker compose --env-file benchmark/.env -f benchmark/docker-compose.yml up -d --build
```

The runner also mounts `../llama-cpp/models/router-config.ini` read-only
(`ROUTER_CONFIG_FILE`) to fill the model metadata (GGUF file, quant, context,
KV type). The file must exist, or Docker creates an empty folder in its place.

The container joins the external `webgateway` network (to reach
`llama-server:8080`) and the external `hermes-mcp` network (to reach
`nextcloud-mcp:8000`, `wger-mcp:8765` and `firefly-mcp:3000`). Code is baked
into the image, so rebuild with `up -d --build` after you edit it (never
during a run: recreating `benchmark` kills the run). To rebuild only the UI:
`docker compose --env-file benchmark/.env -f benchmark/docker-compose.yml up -d --build --no-deps benchmark-ui`.

## Usage

`main.js` is the only entry point:

```sh
docker exec benchmark npm run benchmark -- qwen-3.6-35b-a3b --only hermes --cases cron-ai-news
docker exec benchmark npm run benchmark -- --list            # benchmarks, cases, models
docker exec benchmark npm run benchmark -- all --dry-run     # plan only, no model calls
docker exec benchmark npm run benchmark -- qwen-3.8-27b gemma-4-26b-a4b --profiles finance,nextcloud
docker exec benchmark npm run benchmark -- spark-x2.6-4b --repeat 3 --cases research-qa
```

| Argument | Meaning |
| --- | --- |
| `model ...` | Router model ids or aliases from `GET /models`. Use `all` or give none to test every preset, skipping `-vision` variants and disabled presets. |
| `--only a,b` | Run only these benchmarks (folders under `benchmarks/`). |
| `--cases x,y` | Run only these case ids. |
| `--profiles p,q` | Run only cases of these Hermes profiles (`default`, `finance`, `nextcloud`, ...). |
| `--repeat N` | Run every case N times. |
| `--list` | Print benchmarks, cases with their resolved toolsets, and router models. |
| `--dry-run` | Print the plan without loading or calling any model. |

For a long run that survives your shell, start it detached and follow the log:

```sh
docker exec -d benchmark sh -c 'npm run benchmark -- all --only hermes > /app/reports/full-run.log 2>&1'
tail -f benchmark/reports/full-run.log
```

Only one run can be active at a time (`reports/.running.lock`). To stop a run,
send SIGTERM: `docker exec benchmark pkill -TERM -f "node main.js"` (procps is in the image). The runner
then aborts, cleans up, reloads the production model and writes a partial
report.

For each model, the runner unloads every other model, loads the one under
test (`POST /models/load`) and records the load time; a model that fails to
load gets `load_failed` for all its cases. It then runs the cases. After the
run (and after an abort), it reloads `PRODUCTION_MODEL`
(`qwen-3.6-35b-a3b`). The GPU is sampled every 15 s through
`llama-server` sysfs. If the VRAM temperature (temp3) stays at or above 104 °C
for 60 s, the run aborts and writes a partial report.

**Interference:** the router keeps one model loaded. Any other client (Hermes
gateway cron jobs at night, Talk messages, Open WebUI) that requests another
model swaps it out. The runner reloads the model under test before each case
and notes the swap on that case.

## Benchmark MCP (Hermes models profile)

`benchmark-mcp` (port 8793, network `hermes-mcp`, no Traefik) gives the Hermes
`models` profile five typed tools: `list_models` (presets of
`router-config.ini`, minus `-vision` and `dflash` ones), `start_benchmark`
(`model`, `suite` = `all|cron|chat`, optional `profile`), `benchmark_status`,
`get_results` (`latest` or a run id such as `2026-10-27_17-09`) and
`cancel_benchmark`. There are no free-form commands, paths or run flags.

- Flow: Hermes -> `benchmark-mcp` (bearer `BENCHMARK_MCP_TOKEN`) -> runner job
  API `api.js` (`:8780`, bearer `BENCH_API_TOKEN`, internal network
  `benchmark-api` shared only with `benchmark-mcp`) -> `node main.js <model>
  --cases ...` as an argv array, no shell. The MCP container has no Docker
  socket and no mounts; the runner's existing socket is unchanged.
- Validation happens in both places: the model must be a preset name, suite and
  profile come from fixed lists, extra fields are rejected. Only one run at a
  time: a start is refused while `reports/.running.lock` names a live process
  (also covers runs started with `docker exec` and `rescore`).
- `cancel_benchmark` sends SIGTERM to the active `main.js` run, which aborts
  cleanly (cleanup, production model reloaded).
- Results come from `data/benchmark.db` (read-only): per-model scores and
  per-case status, score, duration and failure types. Check text, answers and
  notes are not returned.
- Log of the last API-started run: `reports/.api-last-run.log`.
- `router-config.ini` is bind-mounted as a single file: if an editor replaces
  the file (new inode), recreate `benchmark` so `list_models` sees the change.
- Tests: `node --disable-warning=ExperimentalWarning --test test/api.test.js`
  in `benchmark/`; `docker run --rm --network none -v ./mcp/tests:/app/tests:ro
  benchmark-mcp:local python -m unittest discover -s /app/tests -v`.
- Setup: `BENCH_API_TOKEN` and `BENCHMARK_MCP_TOKEN` in `benchmark/.env`
  (`openssl rand -hex 32` each); the same `BENCHMARK_MCP_TOKEN` in
  `hermes/.env`. Then `docker compose up -d --build benchmark benchmark-mcp` here and
  recreate `hermes-api` (see `hermes/README.md`). The MCP server only
  authenticates by bearer token; the network is the VPN-only homelab.

## Database

`data/benchmark.db` (in the container `/app/data/benchmark.db`, override with
`BENCH_DB`) is the source of truth. It uses Node's built-in `node:sqlite` (no
npm dependency; the npm scripts pass `--disable-warning=ExperimentalWarning`)
and Python's `sqlite3` in the Excel export. After every case the runner
upserts the whole run in one transaction, reads it back and regenerates
`results.json`, `report.md` and `report.xlsx` from the stored rows. The
journal mode is `DELETE` (not WAL) so the UI can read the file from a
read-only mount.

Migrations are versioned SQL in `lib/db.js` (`MIGRATIONS`, recorded in
`schema_migrations`); add a new entry with the next version to change the
schema.

| Table | Columns | Notes |
| --- | --- | --- |
| `runs` | `id, name, started_at, finished_at, host, command, flags_json, status, meta_json` | `name` is the report folder (`2026-10-24_09-14`). `status` is `running`, `finished` or `aborted`. `meta_json` holds model load times, GPU peaks, notes and the final cleanup. |
| `benchmarks` | `id, name, description` | One row per benchmark module. |
| `models` | `id, alias, file, quant, ctx, kv_type, extra_json` | Router alias; metadata parsed from `router-config.ini` (with `[*]` defaults). |
| `cases` | `id, benchmark_id, case_key, profile, kind, title` | Unique per benchmark and `case_key`. |
| `case_results` | `id, run_id, benchmark_id, model_id, case_id, repeat_idx, status, score, completed, duration_s, model_calls, prompt_tokens, output_tokens, answer_chars, answer_text, transcript_path, error, extra_json, created_at` | Unique on `(run_id, model_id, case_id, repeat_idx)`; writes are upserts. `transcript_path` is relative to `reports/`. `extra_json` keeps notes, leftovers, failure types and the exit code. |
| `checks` | `id, result_id, name, category, passed, weight, detail` | `category` is `completed`, `correctness`, `rules` or `other`; `passed` is 1, 0 or NULL (not applicable); `weight` is the points the check carries in the case score. |
| `metrics` | `id, result_id, name, value, unit` | Benchmark-specific numbers: `decode_tps`, `prompt_tps`, `tool_calls_total`, `tool_calls_failed`, `tool_used_pct`, `model_calls_with_tools`, `exit_code`, ... |
| `tool_calls` | `id, result_id, seq, tool, ok, duration_s, args_hash` | Every tool call in order. `args_hash` is a SHA-1 prefix of the canonical arguments. |
| `run_model_stats` | `id, run_id, benchmark_id, model_id, name, value, text` | Per-run aggregates from `lib/report.js`: `score`, `cron_score`, `chat_score`, `chat_case_score`, `speed_score`, `pass_rate`, `load_s`, `gpu_peak_mem_c`, `gpu_peak_vram_gib`, `chat_disqualified`, ... |

Indexes cover `case_results (benchmark_id, model_id)`, `(run_id)`,
`(case_id)`, checks by result and name, and metrics by name.

`tool_used_pct` is the share of model calls (Hermes API calls) whose reply
contained at least one tool call, from the Hermes session messages. A tool
call counts as failed when the Hermes log has a `tool <name> failed` line
(assigned to that tool's calls in order). Hermes does not log a per-tool
duration, so `duration_s` is NULL.

### Import

`import` loads existing report folders (`results.json` plus the transcripts,
for answers and tool calls) into the database. It is idempotent (upsert by run
+ model + case + repeat) and never writes to the report folder. A run that is
still being written can be imported; importing it again later replaces it.

```sh
docker exec benchmark npm run import -- reports/2026-10-24_09-07
docker exec benchmark npm run import -- reports/2026-10-24_09-14 --models flint-40b-a2.5b
```

`--models a,b` keeps only these models' rows (for example to drop a model
that a stopped run had just started). From the host, with Node 24:
`cd benchmark && ROUTER_CONFIG=../llama-cpp/models/router-config.ini npm run import -- reports/<run>`.

## Results UI

`benchmark-ui` (`ui/server.js`, Node built-ins only) serves a single-page UI
and a read-only JSON API. It opens the database read-only and uses
parameterised SQL only.

Layout: a sticky top bar (brand, breadcrumbs, theme toggle, Sign out), a
filter bar, then the content in a centred container (max 1440 px).

- **Filter bar:** custom dropdowns for benchmark (single choice), runs (a
  running run is marked `running`), models, cases (grouped by kind), profiles,
  kinds and status. Each multi-select has a search box, checkboxes, Select all
  and Clear, and shows the selected count on its button. Checks has an
  Any / Pass / Fail choice per check. Ranges (score, `tool_used_pct`, tokens
  and time per case) open in a popover. The dropdowns work from the keyboard:
  arrow keys, Home/End, Enter or Space to toggle, Escape to close. Active
  filters appear as removable chips with Clear all and Copy link. Free-text
  search covers model, case, answer text and error. On a phone the dropdowns
  fold behind a Filters button.
- **Leaderboard view:** KPI cards (top model, results, pass rate, average
  score, median time per case, tokens), then the leaderboard: one row per model
  with the average score over all selected runs and repeats, pass rate with
  `n / N cases`, the cron and chat role scores (recomputed with the rubric over
  the filtered results, so the chat speed score compares models across runs;
  the per-run values in `run_model_stats` compare only models of the same run),
  median time per case, generation speed and failures. **All columns** adds
  prompt speed, average and total prompt/output tokens, tool calls, load time,
  GPU peaks and one failure count per check. Every column sorts, and every
  column name and KPI has a definition on hover or keyboard focus.
- **Partial models:** a model with results for fewer cases than the selection
  contains (N = distinct cases in the filtered results) gets a `partial`
  badge. It is greyed, not ranked and listed below the complete models, so a
  few early 100 % cases never look like the winner.
- **Statuses and checks:** `pass` = every check passed; `fail` = the run
  finished but a check failed; `error` / `timeout` = the run itself broke.
  The `completed` check is shown as **Run finished** (Hermes ended normally)
  and `correct` as **Task correct** (verified against Nextcloud, wger or
  Firefly). A legend under the leaderboard and the checks explains them.
- **Charts** (plain SVG drawn at the card width, with hover details): average
  score per model, speed against score, average prompt and output tokens per
  case, and failures by type. Below them, a paginated **Results** table and a
  **Runs** table with status, report downloads and an "Only this run" filter.
- **Model view:** KPI cards, score per case and per kind, failures, and every
  case result with its checks and reasons. **Result view:** score, Run
  finished and Task correct, checks with weights and reasons, metrics, the
  tool-call sequence, the answer, the transcript (rendered or raw JSON from
  `reports/`, mounted read-only) and the run's report files.
- The whole view state (filters, sorting, columns, results page, selected
  model or result) is in the URL query string, so links can be shared.
- Light and dark themes follow the system setting, with a toggle. The palette
  is the owner's portfolio theme (`rafasmour/web-portfolio-2.0`,
  `tailwind.config.js`), dark blue and red, with chart colours checked for
  colour-blind separation and contrast.

API (the leaderboard rows also carry `cases`, `cases_total`, `partial`,
`runs_in_progress` and `gpu_peak_vram_gib`): `/api/meta`, `/api/benchmarks`, `/api/runs`, `/api/models`,
`/api/leaderboard`, `/api/results`, `/api/result/<id>`,
`/api/result/<id>/transcript` and `/api/run/<run>/(report.md|report.xlsx|results.json)`.
The filter parameters are `benchmark`, `runs`, `models`, `cases`,
`profiles`, `kinds`, `status`, `check_pass`, `check_fail` (comma-separated),
`q`, and `score_min/max`, `tool_min/max`, `tokens_min/max`, `dur_min/max`.

## Reports

Each run writes `reports/<YYYY-MM-DD_HH-MM>/`, generated from the database
after every case:

- `report.md`: recommendation per role, scores, a per-model summary, a case
  matrix, failures, per-case cleanup and the final Cleanup section;
- `results.json`: every row with every check, the aggregates and the rankings
  (kept for compatibility; the database is the source of truth);
- `report.xlsx`: a Summary sheet (scores, rankings, the "Score per model"
  chart), one sheet per benchmark (pass rate, median duration, tokens,
  failures by type and score charts), and a Cases sheet (one row per case with
  every check, so the scores can be audited);
- `transcripts/<model>/<case>.json`: the prompt, the command, raw
  stdout/stderr, Hermes session messages and tool calls, matching log lines,
  llama.cpp timings, cleanup details and the scored row.

### Scoring

- **Case score (0-100):** `completed` 15 + correctness 50 + rules 20,
  normalised to 100 over the checks that apply to the case.
  - Correctness covers the case-specific checks plus `links_real` for research
    cases when it can be evaluated.
  - For the research cron jobs, `correct` also grades the content against the
    tool results of the run (`benchmarks/hermes/content.js`): the digest must
    list at least 60 % of the items the job's rules keep (date window, topic,
    item limit), at least 80 % of its items must qualify, and `[SILENT]` or the
    error line only count when nothing qualified or every source failed. For
    gpu-watch, `[SILENT]` needs at least one shop page that was read, and every
    price must appear in a tool result.
  - Rules splits evenly over `no_reasoning_leak`, `no_forbidden_tools`,
    `silent_ok` and `size_ok`.
  - A failed `completed` caps the case at 25 and a failed `correct` (the task
    itself) caps it at 50. Timeouts (over 15 min), errors and failed loads
    score 0.
- **Rescoring:** `docker exec benchmark node main.js rescore [run ...]`
  re-grades stored runs (all by default) with the current rules: offline
  checks are recomputed from the transcripts, checks verified against live
  data keep their stored result, and the scores, run aggregates and report
  files are regenerated. The DB is backed up to `data/benchmark.db.bak-<time>`
  first.
- **Cron score:** the mean case score over the 9 cron cases. Speed does not
  count.
- **Chat score:** 0.75 × the mean chat case score + 0.25 × a speed score. The
  speed score is 100 for the fastest median chat time and falls linearly to 0
  at 5× the fastest. A model that left an item behind in a write case, or
  changed data in a read-only case, is disqualified for chat.
- **Speed** is also reported on its own: median wall time per case, median
  decode and prompt tok/s (from llama.cpp `print_timing` log lines), model
  calls and tokens.

## Hermes benchmark

Every case runs:

```sh
docker exec -u hermes -e HERMES_BENCHMARK=1 -e HERMES_BENCHMARK_TALK_ROOM=<mock room> \
  -e NEXTCLOUD_TALK_HOME_ROOM=<mock room> -e NEXTCLOUD_TALK_PROFILE_ROOMS= \
  hermes-api timeout 900 hermes [-p <profile>] chat --query-file /tmp/bench_q.txt \
  -m <model> -t <toolsets> --quiet --max-turns 25 --source tool
```

`--source tool` keeps benchmark sessions out of the user's session lists. A
benchmark run never posts to the user's Talk rooms (see
[Talk isolation](#talk-isolation)).

### Talk isolation

A `hermes chat` run is not a cron job and does not go through
`hermes-nextcloud-bridge`, so Hermes never delivers its final answer to Talk,
even for the cron cases, and the bridge's approval prompts are never posted
(the sandbox profiles' `single_query_mode` answers in the CLI). The n8n
digest workflows are not triggered. The only ways a run could post are tools:

| Path | Room it would use | Benchmark handling |
| --- | --- | --- |
| `talk_send` (toolset `talk`, plugin `hermes/plugins/talk_send`) | normally the profile's entry in `NEXTCLOUD_TALK_PROFILE_ROOMS`, else `NEXTCLOUD_TALK_HOME_ROOM` | Redirected: with `HERMES_BENCHMARK=1` the plugin posts only to `HERMES_BENCHMARK_TALK_ROOM` (= `BENCHMARK_TALK_ROOM`) and is unavailable without it. The real room variables are also blanked in the exec. A case with `talk` is refused when `BENCHMARK_TALK_ROOM` is empty or the profile's installed plugin predates the benchmark mode. |
| `send_message` (toolset `messaging`) | the gateway platforms' real rooms | Refused. Disabled on every profile. |
| Nextcloud MCP `talk_send_message` and other Talk write tools | any room, as the real Nextcloud user | Refused when the profile's Nextcloud MCP `include` list allows one (cannot be redirected). No profile allows them. |

The `cli` default also drops `talk`, and `no_forbidden_tools` fails any
`talk_send` or `send_message` call. No case checks a Talk message today.

Mock user and room (created once with `occ`):

- Nextcloud user `bench-mock` ("Benchmark mock"), in no group. Its password
  was generated and not stored. To sign in as it, set a new one:
  `docker exec -it -u www-data nextcloud php occ user:resetpassword bench-mock`.
- Room "Hermes benchmark (mock)" owned by `bench-mock`, its only member, with
  the Hermes bot (`occ talk:bot:list` id 1) set up:
  `occ talk:bot:setup 1 <token>`. Its token goes in `BENCHMARK_TALK_ROOM`.
  Messages that `bench-mock` writes there would run Hermes (default profile)
  through the bridge like any bot room; nothing needs to.

Test delivery to the mock room without a model request:

```sh
docker exec -e ROOM="<mock room token>" hermes-api sh -c 'curl -fsS -X POST "$NEXTCLOUD_TALK_DELIVER_URL" \
  -H "Authorization: Bearer $NEXTCLOUD_TALK_DELIVER_SECRET" -H "Content-Type: application/json" \
  -d "{\"room_token\":\"$ROOM\",\"message\":\"Benchmark mock test\"}"' >/dev/null && echo delivered
```

Every case is a task file, `benchmarks/hermes/tasks/<case-key>.md`; adding a
case needs no code (see [Task files](#task-files)). The cron cases are
benchmark tasks of their own: Hermes no longer runs these jobs (the schedules
moved to n8n), and the runner does not read `jobs.json`. Their prompts were
frozen from the `ensure_cron_job` heredocs in `hermes/start.sh` with
`${CRON_RULES}` expanded and, for `gpu-watch`, the watchlist from
`hermes/gpu-watchlist.example.yml` embedded the way `start.sh` did. The
runner prepends Hermes' exact cron wrapper.

The runner reads the toolsets live from the profile config (`toolsets` in the
task file):

- `cron` (cron cases): `platform_toolsets.cron`;
- `cli` (default for other kinds): `platform_toolsets.cli` without `kanban`,
  `clarify` and `talk`;
- or an explicit comma-separated list such as `nextcloud,clock`.

| Case | Profile | What is checked |
| --- | --- | --- |
| `cron-ai-news`, `cron-hf-models`, `cron-llamacpp-vulkan`, `cron-llamacpp-rocm`, `cron-gpu-watch`, `cron-selfhosted` | own profile | Frozen task prompt with Hermes' exact cron wrapper. Checks the heading or `[SILENT]`, that every link appears in a tool result, the size, and that only the tools named in the prompt are used. |
| `cron-payments-unpaid` | finance | Same checks. The expected unpaid bills are computed from Firefly `list_bill`. |
| `cron-morning-digest` | nextcloud | Same checks. Must not be `[SILENT]` while open to-dos exist. |
| `cron-calories-report` | calories | Same checks. `[SILENT]` only when today has 0 kcal; otherwise the kcal total must appear. |
| `food-log` | default | wger entries on 2027-01-15 at 13:00 Athens, meal set, about 150 g, no duplicates. Then deleted. |
| `reminder-todo` | nextcloud | One VTODO (not a VEVENT) on `homelab`, due 2027-01-15 08:00Z. Then deleted. |
| `calendar-event` | default | One VEVENT on `personal`, 15:00Z-16:00Z. Then deleted. |
| `subscriptions-read` | finance | All 6 bills listed. Bills are unchanged (`list_bill` before and after). |
| `research-qa` | ai-news | Short answer about router mode, no leaked reasoning. |

These checks run on every case:

- `completed`: exit 0, no truncation, no tool-call parse error, normal end of
  the turn;
- `no_reasoning_leak`: no planning phrases, tool names or raw markup in the
  answer;
- `no_forbidden_tools`: no `talk_send`, `send_message`, kanban or clarify
  calls, no repeated identical calls, and no write tools in read-only cases.

`cron-llamacpp-rocm` was added on 2026-10-24 after the first full run;
the 2026-10-24 runs (Flint in `2026-10-24_09-14`, the other 12 models in
`2026-10-24_10-39`) use the other 13 cases so that they stay comparable.
The 2026-10-27 model evaluation (`llama-cpp/models/model-eval.md`) uses the
same 13 cases: `2026-10-27_14-40` (ornith-1.5-9b), `2026-10-27_15-42`
(qwen-3.5-9b; the run was stopped during the next model, after all 13 cases),
`2026-10-27_16-31` (ling-3.0-tiny) and `2026-10-27_17-09` (the four `-mtp` /
`-dflash` presets). `2026-10-27_15-09` was cut off by a host crash and is
marked `aborted`. Runs after that crash have no `decode_tps`/`prompt_tps`:
the crash left NUL blocks in the `llama-server` Docker log, and `docker logs
--since` stops at them, until the container is recreated.

Metrics come from `hermes-api`:

- Hermes logs (`agent.log*` of the profile, matched by session id and time);
- the profile's `config.yaml` (toolsets only);
- the profile's `state.db`, read-only;
- `docker logs llama-server` timings.

### Task files

```markdown
---
case: reminder-todo          # case key (default: the file name)
kind: chat                   # cron | chat | any other label (agentic, coding, ...)
profile: nextcloud           # Hermes profile (-p); must exist in hermes-api
order: 11                    # position in the run (cron 1-9, chat 10+)
toolsets: cli                # cli | cron | explicit list "a,b"
write_tools: true            # false: any write tool call fails no_forbidden_tools
research: false              # true: also check that answer links appear in tool results
needs: nextcloud             # informational: MCP data the hooks use
setup: nextcloudSnapshot     # hooks.js setup.<name>(clients, params) -> before
verify: nextcloudTodoCreated # hooks.js verify.<name>(clients, before, run, params) -> {checks, notes?, leftovers?}
cleanup: nextcloudNew        # hooks.js cleanup.<name>(clients, before, params) -> {leftovers, deleted}
params: {"calendar": "homelab", "due_utc": "{{TEST_DATE}}T08:00:00Z", "summary_pattern": "rocm|llama", "keywords": ["rocm"]}
---
Remind me on {{TEST_DATE}} at 10:00 to update the llama.cpp ROCm image on the server.
```

- Everything after the closing `---` is the prompt, sent verbatim (trailing
  newlines removed). `{{TEST_DATE}}` (2027-01-15) is expanded in the prompt
  and in `params`.
- One front-matter key per line. `params` is one line of JSON; the other
  values may carry a ` # comment`.
- Cron tasks (`kind: cron`) also need `job` and `heading` (the expected
  heading of a non-silent answer); `schedule` and `source` are reference only.
  Their correctness check is the heading/`[SILENT]` rule; the jobs
  `payments-unpaid`, `morning-digest` and `calories-report` add live
  expectations (`cronExpectation` in `cases.js`).
- Hooks are small named functions in `benchmarks/hermes/hooks.js`. A setup hook
  snapshots state before the run, a verify hook returns a `correct` check
  (and `read_only` for read-only cases), and a cleanup hook deletes what the
  case created and reports leftovers (a leftover disqualifies a model for the
  chat role). Shared snapshot helpers live in `helpers.js`.
- Available hooks: setup `wgerTestDateAndToday`, `nextcloudSnapshot`,
  `fireflyBillsSnapshot`; verify `wgerMealLogged`, `nextcloudTodoCreated`,
  `nextcloudEventCreated`, `fireflyBillsListedReadOnly`, `shortAnswer`;
  cleanup `wgerTestDate`, `nextcloudNew`. Their `params` are documented in
  `hooks.js`.
- Cases without hooks get only the generic checks. Any kind other than `cron`
  runs like a chat case; the leaderboard reports per-kind scores, and the
  `cron`/`chat` role scores use only those two kinds.
- A new case for a new profile needs that profile in `hermes-api` (the case
  fails with `profile ... not found` otherwise). `npm run benchmark -- --list`
  shows every case with its resolved toolsets.

## Adding a benchmark

Create `benchmarks/<name>/index.js` that exports:

```js
module.exports = {
  name: 'name',
  description: 'One line.',
  listCases(opts) { /* [{id, kind, profile?}] filtered by opts.cases / opts.profiles */ },
  async run(ctx) { /* ctx: {model, cases, repeat, runDir, log, signal, isAborted, onRow}; return rows */ },
  // optional: describeCase(c), abort(), prepareRun() -> snapshot, finalCleanup(snapshot) -> {removed, leftovers, verification}
};
```

Each row must use the standard shape documented at the top of
`lib/report.js`. Give every check a `category` (`completed`, `correctness` or
`rules`) so that it is scored. The reporter stores rows in SQLite when
`onRow` fires; a benchmark needs no database code of its own:

- standard fields go to `case_results` and `checks`;
- `decode_tps`, `prompt_tps`, `tool_calls`, `tool_errors` and `exit_code`
  become metrics;
- put any other number in `row.metrics = { name: value }` (for example
  `tool_used_pct`);
- set `row.answer_text` for the answer and
  `row.tool_call_list = [{ seq, tool, ok, duration_s, args_hash }]` for the
  tool calls;
- export `enrichFromTranscript(row, transcript)` to let `import` fill these
  from saved transcripts.

Then allowlist the new folder and files in the root `.gitignore`.

## Backups

Back up `.env` and `data/benchmark.db` (all results across runs). Copy the
database when no run is writing, or use
`sqlite3 data/benchmark.db ".backup benchmark-backup.db"`. Reports in
`reports/` can be regenerated from the database except for the transcripts;
keep them if you want transcript links in the UI.
