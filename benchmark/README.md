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
docker exec benchmark npm run benchmark -- qwen-3.8-27b mellum-2.1-thinking --profiles finance,nextcloud
docker exec benchmark npm run benchmark -- ornith-1.5-9b-dflash --profiles ai-assistant   # the opt-in "assistant" group only
docker exec benchmark npm run benchmark -- m1 m2 m3 --only hermes --with-optin             # default selection + assistant group
docker exec benchmark npm run benchmark -- m1 --only hermes --web                          # default selection + web cases
docker exec benchmark npm run benchmark -- lfm-3-1.7b --repeat 3 --cases research-qa
```

| Argument | Meaning |
| --- | --- |
| `model ...` | Router model ids or aliases from `GET /models`. Use `all` or give none to test every preset, skipping `-vision` variants and disabled presets. |
| `--only a,b` | Run only these benchmarks (folders under `benchmarks/`). |
| `--cases x,y` | Run only these case ids. |
| `--profiles p,q` | Run only cases of these Hermes profiles (`default`, `finance`, `nextcloud`, ...). `--profiles ai-assistant` is the "assistant" group, see [Assistant cases](#assistant-cases-ai-assistant). |
| `--with-optin` | Add the opt-in assistant group to the default selection. |
| `--web` | Add the web cases (`web: true`, need web search/extract). |
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
(default `ornith-1.5-9b-dflash`, the Hermes model; the compose default was `qwen-3.6-35b-a3b` until 2026-11-03, so an unset `PRODUCTION_MODEL` reloaded the wrong model). The GPU is sampled every 15 s through
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
| `run_benchmarks` | `run_id, benchmark_id, version, fingerprint, source` | Benchmark version and content fingerprint of each benchmark in a run (see "Benchmark versions"). `source` is `run` (recorded by the runner) or `backfill` (assigned afterwards, no fingerprint). |
| `benchmark_versions` | `benchmark_id, version, released_on, summary` | Changelog entry of each version, filled by the runner and by `backfill-versions`; the UI shows it. |
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
docker exec benchmark npm run import -- reports/2026-10-24_09-14 --models mellum-2.1-12b-a2.5b
```

`--models a,b` keeps only these models' rows (for example to drop a model
that a stopped run had just started). From the host, with Node 24:
`cd benchmark && ROUTER_CONFIG=../llama-cpp/models/router-config.ini npm run import -- reports/<run>`.

## Benchmark versions

What a benchmark measures changes over time, and scores from different versions are not comparable. Every benchmark therefore
has a version, recorded per run and benchmark in `run_benchmarks` (also in `results.json` as `benchmarks[].version` /
`fingerprint`, and as the line `Benchmark version: X (fingerprint Y)` under the benchmark heading of `report.md`).

- **Explicit version.** `benchmarks/<name>/version.js` exports `BENCHMARK_VERSION` (semver-like) and a `CHANGELOG`
  (`{version, date, summary}`, the current version last); `benchmarks/<name>/index.js` attaches them to the benchmark module.
  Bump it by hand, add the changelog entry and a row to the table below whenever what is measured changes: the case or task
  set, a case's prompt, checks or verifier, the scoring rules, and (Hermes) the Hermes setup under test (SOUL, plugins, hooks,
  sampling). Rule of thumb: major = the case set or the setup changed, minor = a check, verifier or scoring tweak.
- **Content fingerprint.** `lib/version.js` hashes (SHA-256, first 12 hex) the files that define the measurement plus the
  scoring code (`scoreRow` and the weights in `lib/report.js`): Hermes `tasks/*.md` and the case/check/verifier/hook code,
  STT/TTS the benchmark code, `models.json` / `voices.json`, `lib/speech.js` (normalisation, WER) and the clip manifest or
  `data/tts-texts.json`. It is stored next to the version. If one version shows more than one fingerprint, something that is
  measured changed without a version bump; the UI flags that version ("changed"). The Hermes setup itself lives outside this
  container (the `hermes` stack), so a change there is not fingerprinted: bump the version by hand.
- **Rescoring** keeps the stored version and fingerprint of a run.
- **Backfill.** `docker exec benchmark npm run backfill-versions -- --dry-run` prints the plan; without `--dry-run` it backs up
  the DB (`data/benchmark.db.bak-<time>`), gives every stored run x benchmark without a version its historical version
  (`backfill()` in `benchmarks/<name>/version.js`, a table of run-folder name thresholds), writes the changelog rows and patches
  `reports/<run>/results.json` and `report.md` (no fingerprint, `version_source: "backfill"`). It is idempotent and never
  touches versions recorded by a real run; `--force` re-assigns earlier backfilled ones. Existing report.xlsx files are not rewritten.

### Version table

| Benchmark | Version | Date | Runs (folders) | What changed |
| --- | --- | --- | --- | --- |
| hermes | 1.0.0 | 2026-10-24 | `2026-10-24_09-07` to `2026-10-27_17-09` (10 runs) | First release: 13 cases (8 cron, 5 chat). The 2026-10-27 model evaluation uses the same set. |
| hermes | 1.1.0 | 2026-10-28 | `2026-10-28_16-41`, `2026-11-02_13-28`, `2026-11-02_14-36` | `cron-llamacpp-rocm` added (14 cases). |
| hermes | 2.0.0 | 2026-11-03 | `2026-11-03_21-43` to `2026-11-04_08-15` (4 runs) | Opt-in `ai-assistant` group (9 spoken-style cases): 17 cases with `--with-optin`; web cases and GPU watch left the default set. |
| hermes | 3.0.0 | 2026-11-06 | `2026-11-06_10-33` | New setup: the assistant consults specialist agents with `ask_agent`, no sentence limit. |
| hermes | 3.1.0 | 2026-11-06 | `2026-11-06_16-12` | ai-assistant slim Kanban toolset (delegate plugin) and SOUL fixes. |
| hermes | 3.2.0 | 2026-11-06 | `2026-11-06_18-19` to `2026-11-06_22-12` (4 runs) | Clock hooks, last SOUL fixes, reply language not checked; optional preset-sampling switch (the LFM3 runs `2026-11-06_21-12`). |
| hermes | 3.3.0 | 2026-11-07 | `hermes-3.3.0-2026-11-07` run | Reminder argument repair (clock hook), ai-assistant reply cleaner (`spoken_reply`). |
| stt | 1.0.0 | 2026-11-03 | all 5 stt runs | FLEURS el/en subset, WER/CER, pass at WER <= 25%. |
| tts | 1.0.0 | 2026-11-04 | all 3 tts runs | Texts from Hermes answers, round-trip WER by an STT judge, five sanity checks. |

The historical Hermes versions are reconstructed from report dates, notes and the milestones above (the repository has only
two commits touching the benchmark), so the boundaries inside one day (3.0.0 / 3.1.0 / 3.2.0) are best effort.

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
- **Benchmark version:** a Version dropdown next to Benchmark and a version bar above the leaderboard (segmented: All versions,
  v3.2.0, v3.1.0, ...). The newest version of the selected benchmark is selected by default, so models are only compared
  within one version; choose All versions to mix them (a warning says the scores are not comparable). Selecting a run
  explicitly (for example "Only this run") shows it regardless of version. The bar shows the changelog line of the selected
  version, a `backfilled` badge for versions assigned afterwards and a warning when the content fingerprint changed without
  a bump. The **Versions** card lists every version with its runs, models, cases, results, average score, pass rate, top
  model (best average among models covering the version's whole case set) and what changed. Results and Runs tables have a
  Version column. URL parameter: `versions=3.2.0` (or `all`).
- **Audio (stt, tts):** results of the speech benchmarks have an audio player. TTS: the speech the model and voice generated
  (`reports/<run>/audio/<model@voice>/<item>.wav`) next to the text that was spoken and what the STT judge heard. STT: the
  source clip (`_asr-eval/clips/<lang>/<clip>.wav`) next to the reference text and the model's transcript. The player is in the
  Results table (Audio, Reference text, Transcript columns), the model and model-run case tables, and the result page; files
  load on demand. `/api/audio/<result id>.wav` resolves the file from the database row (never from a client path), accepts only
  safe names, requires the real path to stay inside `reports/<run>/audio` or the clips folder, is read-only, behind the login,
  and supports `Range` requests. `benchmark-ui` mounts only `_asr-eval/clips` of the speech models read-only at `/stt-clips`
  (`STT_CLIPS_DIR`), plus the existing read-only `reports/` and `data/`.
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

API additions: `/api/versions[?benchmark=]` (per benchmark version summary), `/api/audio/<result id>.wav`; every result row has
`bench_version`, speech rows `audio` (`tts`, `stt` or null), `reference` and `answer_text`; `/api/meta` lists `versions`.
Filter parameter `versions` (comma-separated, `none` = unversioned runs, absent or `all` = every version).

API (the leaderboard rows also carry `cases`, `cases_total`, `partial`,
`runs_in_progress` and `gpu_peak_vram_gib`): `/api/meta`, `/api/benchmarks`, `/api/runs`, `/api/models`,
`/api/leaderboard`, `/api/results`, `/api/result/<id>`,
`/api/result/<id>/transcript` and `/api/run/<run>/(report.md|report.xlsx|results.json)`.
The filter parameters are `benchmark`, `runs`, `models`, `cases`,
`profiles`, `kinds`, `status`, `check_pass`, `check_fail` (comma-separated),
`versions`, `q`, and `score_min/max`, `tool_min/max`, `tokens_min/max`, `dur_min/max`.

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
    error line only count when nothing qualified or every source failed. Reddit
    posts are expected within 24 h of `clock_now` and accepted up to 25 h.
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
docker exec -u hermes -e HERMES_BENCHMARK=1 -e HERMES_HOME=/tmp/bench-home -e HERMES_BENCHMARK_TALK_ROOM=<mock room> \
  -e NEXTCLOUD_TALK_HOME_ROOM=<mock room> -e NEXTCLOUD_TALK_PROFILE_ROOMS= \
  hermes-api timeout 900 hermes chat --query-file /tmp/bench_q.txt \
  -m <model> -t <toolsets> --quiet --max-turns 25 --source tool
```

`--source tool` marks benchmark sessions; they live in the throw-away home anyway. A
benchmark run never posts to the user's Talk rooms (see
[Talk isolation](#talk-isolation)).

### Sandbox (no real data is read or changed)

Every case runs with `HERMES_HOME=/tmp/bench-home` inside `hermes-api`: a throw-away copy of the profile's
`config.yaml`, `.env`, `SOUL.md`, `auth.json`, plugins, skills, hooks and platforms (no `-p`). It starts with empty
`memories/`, `sessions/`, `cron/`, `logs/` and a fresh `state.db`, and is deleted after the case. Consequences:

- **Memory**: the built-in `memory` tool (MEMORY.md/USER.md) works but only on the copy; the user's real memories are
  never read, and what the model wrote is saved in the transcript (`sandbox.memory`) before the folder is removed.
  Hindsight has no config in the copy and is unavailable (nothing recalled or retained). `session_search`, skill
  creation (`skill_manage`) and `cronjob` also only see the copy; benchmark sessions never appear in the real session
  history, search or `agent.log`.
- **Writes to real systems** are handled by `hermes/plugins/local_only/benchmark_sandbox.py`, active only with
  `HERMES_BENCHMARK=1` (set by the runner, always refreshed from the mounted plugin folder into the copy). It wraps
  tool dispatch and records every write in `benchmark-calls.jsonl`:

| Tool | In a benchmark case |
| --- | --- |
| `talk_send`, `send_message`, `cronjob`, `delegate_task`, `terminal`, `write_file`, `patch`, `execute_code`, `process` | not executed, fake success |
| MCP writes: Nextcloud notes, WebDAV, contacts, shares, mail, Talk; Firefly `store_*`/`update_*`/`delete_*`; n8n create/test/activate; `start_benchmark`; every other tool whose verb is a write | not executed, fake success (`{"success": true, "id": ...}`) |
| `nc_calendar_create_event`, `nc_calendar_create_todo`, wger `log_ingredient` | real (the checks read the real state); deleted by recorded id after the case, plus the hooks' snapshot/diff cleanup |
| update/complete/delete of an event, to-do or wger log item | real only for an id this case created; fake for any existing item |
| wger `create_meal` (the MCP cannot delete a meal) | fake meal id; the real `log_ingredient` is called without it and the reply shows the fake meal again |
| `kanban_*` | real, on the throw-away board (`HERMES_KANBAN_DB`, see below) |

  The plugin refuses to run unsandboxed: if the first case's `benchmark-calls.jsonl` lacks the plugin's marker, all
  remaining cases are `skipped`. Transcripts keep the recorded calls (`sandbox.calls`, `fake: true/false`) and each row's
  notes say how many writes were faked. Reads after a faked write do not show it (a fake note is not in
  `nc_notes_search_notes`): that is the price of never touching the real data.

### Infra faults versus model faults

The harness must never be why a model fails. A model that misbehaves (garbage, loops, tool spam, malformed tool calls,
refusals, context overflow, HTTP 400/500 for a bad request, timeouts) is scored and the run goes on; cleanup always runs.
An **environment fault** is retried: the case is run once more after reloading the model (60 s pause for rate limits), and
when the second attempt still fails with an environment fault the row gets status `infra`: no score, left out of means,
pass rates and rankings (the aggregates carry `infra_cases`), listed in the Failures section. Detected faults: model
unloaded/swapped during the case or another model answering, llama.cpp connection errors or "loading model", Hermes not
starting, MCP/network errors in tool results (ConnectError, 502/503/504, 429, timeouts), research sources that are
rate-limited, erroring or an empty Reddit feed, failed reloads, and any harness exception (setup, verification, snapshot).
Both attempts keep a transcript (`<case>.json`, `<case>-retry.json`). `skipped` = refused before running (profile slot
needs more `parallel` than the preset has, or the sandbox is broken): no score either.

### Case selection

| Group | Cases | How to run |
| --- | --- | --- |
| default | `cron-hf-models`, `cron-payments-unpaid`, `cron-morning-digest`, `cron-calories-report`, `food-log`, `reminder-todo`, `calendar-event`, `subscriptions-read` | no flags |
| opt-in `assistant` (`optin: true`) | the nine `assistant-*` cases | `--profiles ai-assistant`, `--with-optin`, or `--cases` |
| web (`web: true`) | `cron-ai-news`, `cron-selfhosted`, `cron-llamacpp-vulkan`, `cron-llamacpp-rocm`, `research-qa`: their prompts need `web_search`/`fetch_url` | `--web` or `--cases`; never selected by `--profiles` |

The web cases are kept (not deleted) and stay graded (Reddit RSS, GitHub, link checks); add `web: true` to any task file
whose job depends on the web tools. GPU watch (case, profile, room) was removed in November 2026.

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
`${CRON_RULES}` expanded. The
runner prepends Hermes' exact cron wrapper.

The runner reads the toolsets live from the profile config (`toolsets` in the
task file):

- `cron` (cron cases): `platform_toolsets.cron`;
- `cli` (default for other kinds): `platform_toolsets.cli` without `kanban`,
  `clarify` and `talk` (a case with `kanban: true` keeps `kanban`);
- or an explicit comma-separated list such as `nextcloud,clock`.

| Case | Profile | What is checked |
| --- | --- | --- |
| `cron-hf-models` (default); `cron-ai-news`, `cron-llamacpp-vulkan`, `cron-llamacpp-rocm`, `cron-selfhosted` (web, opt-in) | own profile | Frozen task prompt with Hermes' exact cron wrapper. Checks the heading or `[SILENT]`, that every link appears in a tool result, the size, and that only the tools named in the prompt are used (Hermes built-ins `memory` and `clock_*` are always allowed). |
| `cron-payments-unpaid` | finance | Same checks. The expected unpaid bills are computed from Firefly `list_bill`. |
| `cron-morning-digest` | nextcloud | Same checks. Must not be `[SILENT]` while open to-dos exist. |
| `cron-calories-report` | calories | Same checks. `[SILENT]` only when today has 0 kcal; otherwise the kcal total must appear. |
| `food-log` | default | wger entries on 2027-01-15 at 13:00 Athens, meal set, about 150 g, no duplicates. Then deleted. |
| `reminder-todo` | nextcloud | One VTODO (not a VEVENT) on `homelab`, due 2027-01-15 08:00Z. Then deleted. |
| `calendar-event` | default | One VEVENT on `personal`, 15:00Z-16:00Z. Then deleted. |
| `subscriptions-read` | finance | All 6 bills listed. Bills are unchanged (`list_bill` before and after). |
| `research-qa` (web, opt-in) | ai-news | Short answer about router mode, no leaked reasoning. |

### Assistant cases (ai-assistant)

Nine opt-in cases for the `ai-assistant` profile (Jarvis persona, minimal Nextcloud tools, Kanban delegation and the `ask_agent` consult tool), taken
from the owner's real requests of 2026-10-30 to 2026-11-03 (personal details paraphrased, dates moved to the
2027-01-15 test day). They are the "assistant" group: **opt-in**, they run only with `--profiles ai-assistant` or
`--cases` (or `--with-optin`), and never in the default selection (so `all` stays comparable with the earlier
default runs). The benchmark job API starts them with `profile: ai-assistant`.

| Case | Source request | What is checked |
| --- | --- | --- |
| `assistant-event-en` | "Create a calendar event for tomorrow to check the Todo, because many tasks are overdue" (the real answer said "Done" without ever calling `nc_calendar_create_event`) | Exactly one VEVENT on `personal`, 08:00Z-09:00Z, about the to-do check, no extra to-do; spoken style. |
| `assistant-reminders-el` | Greek: three reminders for Monday (accountant about income tax 10:00, pay the loans 13:00, pay for the house furniture 17:00) | Exactly three VTODOs on `personal-1` (furniture also `tasks`), due 08:00Z / 11:00Z / 15:00Z, no events; Greek answer. |
| `assistant-reminder-delegate` | "Remind me tomorrow at 9 to check my phone and note that I have ate a toast" | One VTODO (`tasks` or `personal-1`) due 07:00Z and and, for the toast, either a Kanban card assigned to `calories` mentioning the toast or an `ask_agent` consult of `calories` whose request mentions it (the assistant has no food tools). |
| `assistant-delegate-n8n` | Greek: ask the n8n agent why the workflow "firefly subs to nextcloud payments" does not work | A card for `n8n` (or `default`) naming the workflow, or an `ask_agent` consult of `n8n` naming it; nothing created in Nextcloud ("Hermes tasks go to the Kanban"). |
| `assistant-delegate-plan` | Planner agent should research fine-tuning a small model for Greek and homelab tools and not return before Monday 10:00 | One card for `planner` mentioning fine-tuning and Greek; nothing created in Nextcloud. |
| `assistant-agenda` | "What do I have to do for the day?" / "What is on my calendar today?" | Calls `nc_calendar_search_todos` and an events tool, creates nothing, names at least one item the tools returned (live data, so no fixed titles). |
| `assistant-garbled-el` | Speech-recognition noise in Greek (a book passage read aloud) that the real assistant answered with a Kanban loop and a lecture | No card, no Nextcloud item, at most one tool call, short Greek reply. |
| `assistant-time-el` | "What time is it right now?" in Greek | Calls `clock_now`, at most 2 tool calls, Greek, no ISO/UTC reading. |
| `assistant-event-el` | Greek appointment request on the pattern of `calendar-event` | One VEVENT on `personal`, 15:00Z-16:00Z, dentist; Greek answer. |

Every assistant case also runs the `spoken_style` check (rules): no Markdown, URLs, emoji, ISO dates, UTC times or
ids (the reply language is not checked). There is no sentence limit (the owner removed it). The assistant has no `kanban` toolset: it queues cards with the `agents` plugin's `delegate(assignee, title, details)` and
reads them with `task_status(card_id?)`. Both are allowed in chat cases (one call each; identical repeats are still a loop) and
flagged like `ask_agent` in cron cases. `delegate` writes to the throw-away board (`HERMES_KANBAN_DB`), so the card is
verified there (see [Kanban isolation](#kanban-isolation)); `kanban: true` cases additionally tolerate the old `kanban_*` tools. The assistant's toolsets are
`nextcloud_assistant, web_search, agents, clock, memory`. Nextcloud items are cleaned up by the
usual test-date and keyword cleanup (`nextcloudNew`), through the benchmark's own full Nextcloud MCP (the assistant itself cannot delete).

**Consults (`ask_agent`).** The `agents` toolset lets ai-assistant (and 12 specialist profiles) run another profile as a
separate `hermes chat` process. `ask_agent` is allowed in chat cases (it is not in the forbidden list; repeated identical
calls are still flagged; a cron case that calls it fails "tools not named in the prompt"). The verifier takes optional
`consults: [{profile, request_patterns: [{pattern, label}], label}]`, matched against the case's `ask_agent` calls
(`args.profile`, `args.request`, accent-insensitive), and `any_of: ["cards", "consults"]`, which passes that part when the
Kanban card check OR the consult check passes (the check notes say which matched). Used by `assistant-reminder-delegate`
and `assistant-delegate-n8n`; `assistant-delegate-plan` still needs the planner card (deferred work).

*Consult sandbox.* The consulted profile runs with `HERMES_HOME=/tmp/bench-home/profiles/<p>`, so `prepareHome` builds a
throw-away copy there for each consultable profile (calories, finance, nextcloud, planner, web-search, n8n, models,
hf-models, ai-news, selfhosted, llamacpp-vulkan, llamacpp-rocm) in the same docker exec as the main copy: same file
list, shared `local_only` and `talk_send` plugins refreshed, the `id_slot` remap applied to every copy, and a clear
failure when a copy lacks `plugins/local_only/benchmark_sandbox.py`. The copies are a few hundred KB each (skills
included). The runner passes `HERMES_ASK_AGENT_MODEL=<model under test>` (so the consulted agent uses the same model)
and `HERMES_PROFILE=<case profile>` (the caller name); `HERMES_BENCHMARK`, `HERMES_KANBAN_DB` and the Talk variables are
inherited, and a consult still running after 120 s is killed (`status: timeout`). Writes a consulted profile makes (for
example `log_ingredient` for the toast) are recorded in its own `benchmark-calls.jsonl`; `readSandbox` reads those files
too (tagged with the profile), and the cleanup deletes them like the main profile's writes. They are never counted
against the ai-assistant's own tool calls (it did not call a wger tool). `BENCH_HOME/logs/ask_agent.log` is stored as
`consults` in the transcript; the row carries `consults` and `consult_seconds` (also metrics, and shown in the report's
failure list). All of it is removed with `/tmp/bench-home`.

Not verified by a real run yet (written without sending model requests): the exact `calendar_name` strings
returned for `personal-1` and `tasks`, the Greek `summary_pattern` regexes and `mention_from_results` need one
real run to calibrate. `ai-assistant` carries `extra_body` `id_slot: 1` and a reasoning budget (1024 tokens, read live from the profile config):
on a preset with fewer slots (`parallel=1`) the runner sets `id_slot: 0` in the throw-away profile copy (the pin
only picks the prompt-cache slot; production config is untouched) and notes it on the case. On `ornith-1.5-9b-dflash` the run overwrites slot 1, the
prompt the primer keeps warm; the primer replays it within about 2.5 minutes after the run, so the next real
ai-assistant request after a benchmark can be cold. The reasoning budget also makes its scores incomparable with
other profiles.

### Kanban isolation

Hermes profiles with the `kanban` toolset can create cards, and the real dispatcher would start a specialist
for each. Every case therefore runs with `HERMES_KANBAN_DB=/tmp/bench-kanban/kanban.db` in `hermes-api`, an empty
throw-away board that is created before and deleted after each case. A card the model creates never reaches the
real board; the `assistantOutcome` verifier reads the cards from that file and the transcript stores them as
`kanban_cards`. Other cases still treat `kanban_*` calls as forbidden. Consulted profiles (`ask_agent`) inherit `HERMES_KANBAN_DB`, so their cards go to the same
throw-away board.

These checks run on every case:

- `completed`: exit 0, no truncation, no tool-call parse error, normal end of
  the turn;
- `no_reasoning_leak`: no planning phrases, tool names or raw markup in the
  answer, and not the reasoning-budget message ("That is enough thinking;
  answer now."). Phrase patterns ignore link text and URLs, so a quoted
  Reddit title such as "I should've listened..." no longer fails a digest, and
  "I should" counts only before an action verb;
- `no_forbidden_tools`: no `talk_send`, `send_message`, kanban (except
  `kanban: true` cases), clarify, `delegate_task` or cronjob calls (`ask_agent` is allowed in chat cases), no repeated
  identical calls (`clock_*` excepted in chat cases) and no write tools in
  read-only cases (calendar, notes, webdav, wger and Firefly writes);
  `memory`, `clock_*` and `hindsight_*` are built-ins and always allowed;
- `spoken_style` (ai-assistant cases only; no Markdown, URLs, emoji, ISO/UTC/ids, no language check, no sentence limit): see [Assistant cases](#assistant-cases-ai-assistant).

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
web: false                   # true: needs the web search/extract tools; opt-in via --web or --cases
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
  `nextcloudEventCreated`, `fireflyBillsListedReadOnly`, `shortAnswer`,
  `assistantOutcome` (to-dos, events and Kanban cards together, plus spoken style);
  cleanup `wgerTestDate`, `nextcloudNew`. Their `params` are documented in
  `hooks.js`.
- Cases without hooks get only the generic checks. Any kind other than `cron`
  runs like a chat case; the leaderboard reports per-kind scores, and the
  `cron`/`chat` role scores use only those two kinds.
- A new case for a new profile needs that profile in `hermes-api` (the case
  fails with `profile ... not found` otherwise). `npm run benchmark -- --list`
  shows every case with its resolved toolsets.

## Speech benchmarks (stt, tts)

Two opt-in benchmarks compare the audio.cpp speech models of the `speech` stack. They are not part of the default
selection (`npm run benchmark -- all` still means the Hermes benchmark only); name them with `--only`. They never call
llama.cpp: they have their own model lists (the benchmark module exports `ownModels()`; main.js runs those models after
any router models and skips the "restore production model" step when only speech benchmarks ran), and store rows in the
same SQLite database and report folder (`report.md`, `results.json`, `report.xlsx`, plus `stt-summary.md` or
`tts-summary.md` with the per-language leaderboards).

- **Runtime:** `audiocpp_cli` through `docker exec audiocpp-tts` (offline batch per model, Vulkan). The audio.cpp server
  keeps running; the CLI is a second process on the same GPU, so run the speech benchmarks when nothing else of ours uses
  the card. The runner mounts `speech/audiocpp/models` read-only at `/speech-models` (model discovery, STT clips).
- **Quantized models only.** Models are discovered from the GGUF headers (`audiocpp.model_spec.family`, `category`) under
  `speech/audiocpp/models`; float variants (f16, f32, bf16, fp16) are never listed. Q6_K is the default quant, Q8_0/Q4_K
  are comparisons. `npm run benchmark -- --only stt --list` prints what was found.
- **Idle GPU:** the runner samples VRAM before the first model and writes it into the report (`baseline VRAM`, and a
  warning above 3 GiB, which means an LLM or another model is resident and latencies are not idle-GPU numbers). Peak VRAM per
  model is the whole-GPU peak while it ran, also shown as the increase over that baseline.
- **Time to first audio** is not measured: the benchmark uses offline batch synthesis, so only the total synthesis time (and
  RTF) is reported.
- **Selection:** `--profiles el` (or `en`) selects a language, `--cases en/en01,el/el02` single items; `SPEECH_LIMIT=N` keeps the first N items per language
  (smoke runs).

### STT benchmark

Cases are the fixed FLEURS subset in `speech/audiocpp/models/_asr-eval/clips/{el,en}/*.wav` with `manifest.jsonl`
(`lang`, `path`, `text`, `duration`; 100 clips per language). Scoring normalisation is the STT evaluation's (`score.py`):
NFKC, lowercase, everything that is not a letter or digit becomes a space; Greek also drops accents and folds final sigma.
Per language and model: pooled WER and CER, mean/median seconds per clip, RTF (processing / audio seconds), failures (no
output or empty transcript). Per model: load time (process time minus the per-clip times, so it includes the first
warmup), peak VRAM and RSS. A clip passes at WER <= 25%; the per-clip score is 100 x (1 - min(1, WER)).
Per-model overrides (skip a GGUF, restrict languages, extra CLI args, per-language CLI args such as Nemotron's `--language el-GR` and Cohere's `--language el`) go in `benchmarks/stt/models.json`; a model with `langArgs` runs one audiocpp_cli process per language (so its load time is summed over both). Folders starting with `_` or `.` (for example `_asr-eval/`) are never scanned for models.

```sh
docker exec benchmark npm run benchmark -- --only stt                       # every quantized ASR GGUF, 200 clips each
docker exec benchmark npm run benchmark -- phonon-2.5-q6_k --only stt       # one model
docker exec benchmark npm run benchmark -- --only stt --profiles el         # Greek clips only
```

### TTS benchmark

Each quantized TTS GGUF x voice is a "model" named `<gguf>@<voice>`; voices per model, the language each voice may be
used for, and the extra CLI arguments (voice id, VoxCPM2 voice-design prefix, OmniVoice `--instruct`, clone reference WAVs
from `speech/audiocpp/voices`) are in `benchmarks/tts/voices.json` (they mirror `TTS_BACKENDS` in `speech/docker-compose.yml`).
Greek text only goes to voices that list `el`. A model without an entry gets a `default` voice for the languages it supports;
`"default": false` keeps a model out of default runs (name it explicitly).

**Texts.** `data/tts-texts.json` is a fixed snapshot built from the Hermes answers stored in the database
(`case_results.answer_text`): markdown, code, tables, URLs and emoji removed, split into chunks of at most 400 characters,
single-script prose only (an English chunk has no Greek letters, a Greek chunk at most 15% Latin letters), numbers/dates
and tool-like text dropped, at most a third of an item set from one case, newest passing answers first.
It contains personal data (calendar, tasks, finance), lives under the ignored `data/` folder and must never be committed.
Rebuild it (also after a new Hermes run, e.g. the Greek `assistant-*-el` cases):

```sh
docker exec benchmark npm run tts-texts -- --en 20 --el 15 --max 400      # writes data/tts-texts.json
```

**Round trip.** After each model x voice x language batch the audio is transcribed by an STT judge and scored against the
original text with the same normalisation as the STT benchmark. Default judges (best of the STT run 2026-11-03_22-12):
`parakeet-tdt-0.6b-v3-greek-q6_k` for Greek (WER 12.4%) and `qwen3-asr-1.7b-q6_k` for English (WER 3.3%). Override with
`TTS_JUDGE_EN` / `TTS_JUDGE_EL` / `TTS_JUDGE` (a model id, passed with `docker exec -e`), or set `TTS_JUDGE_AUTO=1` to take the
lowest-WER model of the latest finished `stt` run. The judge is named in the report. The judge's own errors count against the
TTS model, which is why the strongest STT model per language is used.

**Metrics per item:** round-trip WER/CER, `parsed back` (WER <= 10%), synthesis seconds, RTF, characters of text per audio
second, leading/trailing/internal silence, clipping ratio, RMS and peak dBFS, sample rate, median pitch (crude
autocorrelation; for consistency per voice only). Failures (no audio, unreadable WAV, no judge transcript) are counted per
model. There is no fallback voice here (the gateway's `TTS_FALLBACK` is not involved). Generated audio is kept under
`reports/<run>/audio/<model>@<voice>/<item>.wav` (ignored by Git) and linked from `tts-summary.md`.

**Score (per item, 0-100):** 60% intelligibility (round-trip WER 0 scores 1, WER >= 50% scores 0, linear) + 25% audio sanity
(share of five checks passed: speech rate 8-25 chars/s, clipping < 0.1% of samples, leading <= 1.5 s and trailing <= 2 s
silence, internal silence <= 35% of the spoken span, peak -30..-0.5 dBFS and RMS -40..-8 dBFS) + 15% speed (RTF <= 0.1
scores 1, RTF >= 1.0 scores 0). A failed synthesis scores 0. A model's score is the mean over its items; a language's
leaderboard is sorted by it.

```sh
docker exec benchmark npm run benchmark -- --only tts --list              # models/voices and texts
docker exec benchmark npm run benchmark -- --only tts --dry-run
docker exec benchmark npm run benchmark -- --only tts                     # every model x voice
docker exec benchmark npm run benchmark -- --only tts supertonic-3-q8_0@M1 chatterbox-q6_k@spyros-ref
docker exec -e TTS_JUDGE_EL=<best-greek-stt-model> benchmark npm run benchmark -- --only tts
```

MOSS-TTS-Local (Q6_K, about 5.8 GB of weights) only fits when the production LLM is unloaded (`ornith-1.5-9b-dflash` leaves about 4 GB free); the benchmark does not touch llama.cpp, so unload it first or exclude the model (`voices.json`: `"default": false`). Run order matters: STT first, then the TTS benchmark when the LLM benchmarks are done
and no LLM is loaded.

Unit tests (normalisation, WER, WAV analysis, CLI output parsing): `cd benchmark && npm test` on the host (the image does not
contain `test/`).

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

Also give it a `version.js` like the existing benchmarks (`version`, `changelog`, `fingerprintFiles()`, optional
`backfill(runName)`) and attach it in `index.js` (`Object.assign(b, require('./version'))`); see "Benchmark versions".
A benchmark without a version is stored unversioned.

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

### Preset sampling variant (Hermes override removed)

`hermes/start.sh` writes `temperature` and `presence_penalty` (`HERMES_SAMPLING_*`) into every non-default profile's custom
provider `extra_body`, which overrides the llama.cpp preset. To benchmark a model under its preset's own sampling (for example
LFM3's vendor tool-use sampling), start the run with `-e HERMES_BENCH_PRESET_SAMPLING=1`: the runner then deletes those two keys
from every `extra_body` in the sandbox copies (`BENCH_HOME/config.yaml`, `BENCH_HOME/profiles/*/config.yaml`; production config is
untouched), refuses the case if nothing was removed, and adds the case note "preset sampling (Hermes temperature/presence override
removed)". Test: `node --test test/hermes.test.js`.
