#!/bin/sh
set -eu

# Specialist profiles served by the default gateway (gateway.multiplex_profiles).
# The legacy router and digest profiles may still exist on the volume; they
# are no longer configured, served, or ticked.
SPECIALISTS="nextcloud finance ai-news hf-models llamacpp-vulkan gpu-watch selfhosted calories"

# nextcloud_talk cron delivery platform from
# https://github.com/robertlmann02/nextcloud-talk-hermes-bridge, pinned to the
# same commit as the hermes-nextcloud-bridge image.
TALK_BRIDGE_REF="b26267ff8ffb02b4e282b032815584163cff5021"

export HERMES_TIMEZONE="${HERMES_TIMEZONE:-Europe/Athens}"
SHARE="/usr/local/share/hermes"

cleanup_stale_kanban_dispatcher_lock() {
  python - <<'PY'
import fcntl
import os
import time
from pathlib import Path

home = Path(os.environ["HERMES_HOME"])
lock_path = home / "kanban" / ".dispatcher.lock"
if not lock_path.is_file():
    raise SystemExit(0)

def gateway_running() -> bool:
    pid_path = home / "gateway.pid"
    if not pid_path.is_file():
        return False
    try:
        pid = int(pid_path.read_text().strip().split()[0])
    except (ValueError, OSError):
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True

st = lock_path.stat()
age_s = time.time() - st.st_mtime

try:
    handle = open(lock_path, "a+", encoding="utf-8")
except OSError:
    raise SystemExit(0)

stale = False
try:
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        stale = True
    except (BlockingIOError, OSError):
        if not gateway_running() and age_s >= 86400:
            stale = True
finally:
    handle.close()

if stale:
    try:
        lock_path.unlink(missing_ok=True)
    except OSError:
        pass
PY
}

stop_s6_profile_gateways() {
  s6_svc=$(find /package/admin -path '*/command/s6-svc' -type f 2>/dev/null | head -n 1)
  if [ -n "${s6_svc}" ]; then
    for profile in default ${SPECIALISTS} router digest; do
      # -D records want-down. -d does not, so a gateway that has already
      # exited stays "normally up" and s6 starts it again.
      "${s6_svc}" -D "/run/service/gateway-${profile}" 2>/dev/null || true
    done
  fi
}

profile_home() {
  if [ "$1" = "default" ]; then
    printf '%s\n' "${HERMES_HOME}"
  else
    printf '%s\n' "${HERMES_HOME}/profiles/$1"
  fi
}

hermes_p() {
  profile=$1
  shift
  if [ "${profile}" = "default" ]; then
    hermes "$@"
  else
    hermes -p "${profile}" "$@"
  fi
}

hermes plugins disable web/forage 2>/dev/null || true
# A sticky specialist profile would send these writes and cron jobs there.
hermes profile use default
stop_s6_profile_gateways
cleanup_stale_kanban_dispatcher_lock
hermes kanban init

# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

inference_base_url="${HERMES_INFERENCE_BASE_URL:-http://llama-cpp:8080/v1}"
model_name="${HERMES_MODEL:-}"

if [ -z "${model_name}" ]; then
  model_name="$(python - "${inference_base_url}" <<'PY'
import json
import sys
import time
import urllib.request

base_url = sys.argv[1].rstrip("/")
models_url = f"{base_url}/models"

for attempt in range(30):
    try:
        request = urllib.request.Request(
            models_url,
            headers={"Accept": "application/json", "User-Agent": "hermes-llama-cpp-discovery"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.load(response)

        models = [
            item["id"]
            for item in payload.get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]
        if not models:
            raise RuntimeError("the model catalog is empty")

        print(models[0])
        if len(models) > 1:
            print(
                f"Hermes discovered {len(models)} llama.cpp models; "
                f"using the first catalog entry, {models[0]!r}",
                file=sys.stderr,
            )
        break
    except Exception as exc:
        if attempt == 29:
            raise SystemExit(f"Unable to discover a llama.cpp model from {models_url}: {exc}")
        time.sleep(2)
PY
  )"
fi
export HERMES_SELECTED_MODEL="${model_name}"
export HERMES_SELECTED_BASE_URL="${inference_base_url}"

# ---------------------------------------------------------------------------
# Profiles, plugins, and per-profile configuration
# ---------------------------------------------------------------------------

ensure_profile() {
  name=$1
  description=$2
  if [ -f "$(profile_home "${name}")/config.yaml" ]; then
    return 0
  fi
  hermes profile create "${name}" --no-skills --no-alias \
    --description "${description}" </dev/null
}

ensure_profile nextcloud \
  "Manages calendars, tasks, notes, files, contacts, and Talk on the private Nextcloud through its MCP server."
ensure_profile finance \
  "Checks the Nextcloud Payments calendar against Firefly transactions through the Nextcloud and n8n MCP servers."
ensure_profile ai-news \
  "Reads hot r/LocalLLaMA posts through the web-search MCP."
ensure_profile hf-models \
  "Finds new Hugging Face text models that have a GGUF or more than 100 downloads."
ensure_profile llamacpp-vulkan \
  "Watches ggml-org/llama.cpp commits and pull requests that mention Vulkan."
ensure_profile gpu-watch \
  "Compares in-stock Greek shop prices for the GPUs on the watchlist."
ensure_profile selfhosted \
  "Summarizes top posts from r/selfhosted and r/homelab through the web-search MCP."
ensure_profile calories \
  "Logs food in the wger nutrition diary and reports the day's totals."

# Install the Hermes plugins into every served profile home:
# - talk_send (tracked in hermes/plugins/talk_send): the agent tool that posts
#   to the Talk home room through the bridge /deliver endpoint.
# - nextcloud_talk (bridge repository, pinned commit, sha256-verified): the
#   platform used by `hermes cron ... --deliver nextcloud_talk`.
# /opt/hermes is read-only for the hermes user, so both are user plugins and
# are enabled through plugins.enabled in each profile config below.
python - "${TALK_BRIDGE_REF}" "${SHARE}/plugins" default ${SPECIALISTS} <<'PY'
import hashlib
import os
import shutil
import sys
import urllib.request
from pathlib import Path

ref, share = sys.argv[1], Path(sys.argv[2])
profiles = sys.argv[3:]
home = Path(os.environ["HERMES_HOME"])
expected = {
    "plugin.yaml": "7b3d48fba44142d0aa8884aafac44ce8ae2d9ce512b4f79c392c60906bdd385b",
    "__init__.py": "0d815abab3a8fd3bfe916596583e168081554303e7bd379c2bc58d613cf634b1",
    "adapter.py": "fc2ba4fdfce9d62386ca81bdd03f7248d5ee5622fc1ec4f0c73ac3e41778f99e",
}
cache = home / "plugin-src" / f"nextcloud_talk-{ref}"

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def cache_ok() -> bool:
    return all((cache / n).is_file() and digest(cache / n) == h for n, h in expected.items())

if not cache_ok():
    cache.mkdir(parents=True, exist_ok=True)
    base = (
        "https://raw.githubusercontent.com/robertlmann02/nextcloud-talk-hermes-bridge/"
        f"{ref}/hermes_plugins/nextcloud_talk/"
    )
    try:
        for name, sha in expected.items():
            with urllib.request.urlopen(base + name, timeout=30) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != sha:
                raise RuntimeError(f"sha256 mismatch for {name}")
            (cache / name).write_bytes(data)
    except Exception as exc:
        print(f"WARNING: nextcloud_talk plugin download failed: {exc}", file=sys.stderr)

sources = {"talk_send": share / "talk_send", "clock": share / "clock"}
if cache_ok():
    sources["nextcloud_talk"] = cache

for profile in profiles:
    phome = home if profile == "default" else home / "profiles" / profile
    for name, src in sources.items():
        if not src.is_dir():
            print(f"WARNING: plugin source {src} is missing", file=sys.stderr)
            continue
        dst = phome / "plugins" / name
        same = dst.is_dir() and all(
            (dst / f.name).is_file() and (dst / f.name).read_bytes() == f.read_bytes()
            for f in src.iterdir() if f.is_file()
        )
        if not same:
            if dst.exists():
                shutil.rmtree(dst)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
PY

# configure_profile <profile> <comma MCP servers> <comma cli/api toolsets> <comma cron toolsets>
# Writes the whole managed part of a profile config in one pass. MCP bearer
# tokens are read from the environment inside Python, never passed as argv.
configure_profile() {
  python - "$@" <<'PY'
import os
import sys
from pathlib import Path

import yaml

profile, mcp_csv, chat_csv, cron_csv = sys.argv[1:5]
home = Path(os.environ["HERMES_HOME"])
path = home / "config.yaml" if profile == "default" else home / "profiles" / profile / "config.yaml"
data = yaml.safe_load(path.read_text()) if path.is_file() else {}
data = data or {}

def section(name):
    value = data.get(name)
    if not isinstance(value, dict):
        value = {}
        data[name] = value
    return value

def split(csv):
    return [item for item in csv.split(",") if item]

env = os.environ
servers = {
    "nextcloud": {"url": "http://nextcloud-mcp:8000/mcp"},
    "n8n": {
        "url": "http://n8n-mcp:3000/mcp",
        "headers": {"Authorization": f"Bearer {env['N8N_MCP_AUTH_TOKEN']}"},
    },
    "drawio": {"url": "http://drawio-mcp:8000/mcp"},
    "web_search": {
        "url": "http://web-search-mcp:8000/mcp",
        "headers": {"Authorization": f"Bearer {env['WEB_SEARCH_MCP_TOKEN']}"},
    },
    "wger": {
        "url": "http://wger-mcp:8765/mcp",
        "headers": {"Authorization": f"Bearer {env['MCP_STATIC_TOKEN']}"},
    },
    # Official Hugging Face MCP; read-only Hub search works without a token.
    "huggingface": {"url": "https://huggingface.co/mcp"},
}
# The Nextcloud MCP exposes 124 tools (~75k tokens of schema). Loading them all
# made every request slow and let the model pick look-alike tools, so each
# profile only registers what its job needs (fnmatch globs).
tool_filters = {
    ("default", "nextcloud"): {"include": [
        "nc_calendar_list_*", "nc_calendar_get_*", "nc_calendar_create_event", "nc_calendar_update_event",
        "nc_calendar_delete_event", "nc_calendar_create_todo", "nc_calendar_update_todo",
        "nc_calendar_complete_todo", "nc_calendar_delete_todo", "nc_calendar_search_todos", "nc_notes_*",
    ]},
    ("finance", "nextcloud"): {"include": ["nc_calendar_list_*", "nc_calendar_get_*", "nc_calendar_search_todos"]},
    ("nextcloud", "nextcloud"): {"exclude": ["nc_mail_*", "nc_shopping_*", "nc_news_*", "collectives_*"]},
}
mcp = {}
for name in split(mcp_csv):
    entry = dict(servers[name])
    entry.update({"connect_timeout": 60, "timeout": 3600, "enabled": True})
    if (profile, name) in tool_filters:
        entry["tools"] = tool_filters[(profile, name)]
    mcp[name] = entry
data["mcp_servers"] = mcp

model = section("model")
model.update({
    "provider": "custom",
    "base_url": env["HERMES_SELECTED_BASE_URL"],
    "api_mode": "chat_completions",
    "default": env["HERMES_SELECTED_MODEL"],
    # One llama.cpp slot of the model (Mellum: 98304 per slot, 4 slots), so
    # Hermes compresses before a request outgrows its slot.
    "context_length": int(env.get("HERMES_CONTEXT_LENGTH") or 98304),
})
data["timezone"] = env["HERMES_TIMEZONE"]
# tirith only scans terminal commands, and the terminal toolset is disabled;
# without the binary it only prints a warning into every CLI run.
section("security")["tirith_enabled"] = False

timeouts = section("timeouts")
tools_t = timeouts.get("tools") if isinstance(timeouts.get("tools"), dict) else {}
tools_t.update({"concurrent_batch": 3600, "sequential_call": 3600})
timeouts["tools"] = tools_t
mcp_t = timeouts.get("mcp") if isinstance(timeouts.get("mcp"), dict) else {}
mcp_t["tool_call"] = 3600
timeouts["mcp"] = mcp_t
section("terminal")["timeout"] = 3600
providers = section("providers")
custom = providers.get("custom") if isinstance(providers.get("custom"), dict) else {}
custom["request_timeout_seconds"] = 3600
providers["custom"] = custom

# Each platform sees only kanban, clarify, Talk, and this profile's own MCP
# servers. Naming MCP servers makes the list an allowlist.
chat = split(chat_csv)
cron = split(cron_csv)
platforms = section("platform_toolsets")
platforms["cli"] = chat
platforms["api_server"] = chat
platforms["cron"] = cron
data["toolsets"] = chat

# Built-ins that let a small model "finish" without touching the real
# report target (notepad via cronjob, memory, todo, session search) or that
# reach outside the MCP surface (shell, files, browser, built-in web).
agent = section("agent")
agent["disabled_toolsets"] = [
    "memory", "todo", "session_search", "cronjob", "messaging",
    "web", "search", "browser", "forage", "delegation", "vision", "video",
    "tts", "stt", "image_gen", "video_gen", "computer_use", "code_execution",
    "skills", "file", "terminal", "homeassistant",
]

web = section("web")
for key in ("search_backend", "extract_backend"):
    if web.get(key) == "forage":
        web.pop(key)

plugins = section("plugins")
# User plugins are keyed by their manifest name.
wanted_plugins = ("talk_send", "clock", "nextcloud_talk-platform")
enabled = [n for n in (plugins.get("enabled") or []) if n not in ("web/forage", "nextcloud_talk")]
for name in wanted_plugins:
    if name not in enabled:
        enabled.append(name)
plugins["enabled"] = enabled
disabled = [n for n in (plugins.get("disabled") or []) if n not in wanted_plugins]
if "web/forage" not in disabled:
    disabled.append("web/forage")
plugins["disabled"] = disabled

# MCP tools must sit in the model schema. tool_search would defer them behind
# tool_describe, and a small local model describes forever instead of calling.
tools = section("tools")
tool_search = tools.get("tool_search") if isinstance(tools.get("tool_search"), dict) else {}
tool_search["enabled"] = "off"
tools["tool_search"] = tool_search

# The gateway would post "Gateway shutting down" into the Talk room on every
# container restart.
platforms_cfg = section("platforms")
talk_cfg = platforms_cfg.get("nextcloud_talk") if isinstance(platforms_cfg.get("nextcloud_talk"), dict) else {}
talk_cfg["gateway_restart_notification"] = False
platforms_cfg["nextcloud_talk"] = talk_cfg

if profile == "default":
    kanban = section("kanban")
    kanban.update({
        "dispatch_in_gateway": True,
        "dispatch_interval_seconds": 15,
        "max_in_progress": 4,
        "max_spawn": 4,
        "review_dispatch": False,
        # Specialist MCP writes can exceed the Hermes defaults. One hour is
        # the homelab tool deadline.
        "dispatch_stale_timeout_seconds": 3600,
    })
    gateway = section("gateway")
    # One gateway serves /p/<profile>/v1 for every specialist and ticks every
    # profile cron store. Specialist gateways stay stopped.
    gateway["multiplex_profiles"] = True
    gateway["multiplex_profile_allowlist"] = os.environ["SPECIALISTS"].split()
else:
    # The multiplexer owns the single HTTP listener; a specialist that enables
    # api_server aborts gateway startup. Its API is /p/<profile>/v1 instead.
    section("platforms")["api_server"] = {"enabled": False}
    section("gateway")["enabled"] = False

path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
os.chmod(path, 0o600)
PY
}
export SPECIALISTS

configure_profile default nextcloud,wger,web_search,n8n,drawio \
  kanban,nextcloud,wger,web_search,talk,clock,clarify nextcloud,wger,web_search,talk,clock
configure_profile nextcloud nextcloud,web_search \
  kanban,nextcloud,web_search,talk,clock,clarify nextcloud,web_search,talk,clock
configure_profile finance nextcloud,n8n \
  kanban,nextcloud,n8n,talk,clock,clarify nextcloud,n8n,talk,clock
for profile in ai-news llamacpp-vulkan gpu-watch selfhosted; do
  configure_profile "${profile}" web_search \
    kanban,web_search,talk,clock,clarify web_search,talk,clock
done
configure_profile hf-models huggingface,web_search \
  kanban,huggingface,web_search,talk,clock,clarify huggingface,web_search,talk,clock
# calories only messages the user (its room, talk_send); it never creates to-dos.
configure_profile calories wger,web_search \
  kanban,wger,web_search,talk,clock,clarify wger,talk,clock

# Under multiplexing, /p/<profile>/v1 authenticates against that profile's own
# secret scope (<profile home>/.env) and fails closed without a key. Give every
# specialist the same API_SERVER_KEY, read from the environment here.
python - ${SPECIALISTS} <<'PY'
import os
import sys
from pathlib import Path

key = os.environ["API_SERVER_KEY"]
home = Path(os.environ["HERMES_HOME"])
for profile in sys.argv[1:]:
    path = home / "profiles" / profile / ".env"
    lines = path.read_text().splitlines() if path.is_file() else []
    kept = [line for line in lines if not line.startswith("API_SERVER_KEY=")]
    wanted = kept + [f"API_SERVER_KEY={key}"]
    if wanted != lines:
        path.write_text("\n".join(wanted) + "\n")
    os.chmod(path, 0o600)
PY

# ---------------------------------------------------------------------------
# SOULs: managed. Rewritten on every start; text below "## Local notes" in the
# live file is kept.
# ---------------------------------------------------------------------------

write_soul() {
  # The SOUL text arrives on stdin; python itself reads its script from a
  # heredoc, so hand the text over through the environment.
  SOUL_BODY=$(cat)
  export SOUL_BODY
  python - "$1" <<'PY'
import os
import sys
from pathlib import Path

profile = sys.argv[1]
home = Path(os.environ["HERMES_HOME"])
path = home / "SOUL.md" if profile == "default" else home / "profiles" / profile / "SOUL.md"
body = os.environ["SOUL_BODY"].strip()
core = os.environ["SOUL_CORE"].strip()
marker = "<!-- managed by start.sh: edits above Local notes are overwritten -->"
heading = "## Local notes"
local = ""
if path.is_file():
    old = path.read_text()
    if heading in old:
        local = old.split(heading, 1)[1].strip("\n")
text = f"{marker}\n{body}\n\n{core}\n\n{heading}\n"
if local:
    text += local + "\n"
if not path.is_file() or path.read_text() != text:
    path.write_text(text)
PY
}

SOUL_CORE=$(cat <<'EOF'
## Core rule: do the work through your tools

Your job is done only when the matching tool has returned success in this run:

- calendar event: mcp__nextcloud__nc_calendar_create_event
- to-do or reminder: mcp__nextcloud__nc_calendar_create_todo
- note: mcp__nextcloud__nc_notes_create_note
- food eaten: mcp__wger__search_ingredients, then mcp__wger__log_ingredient
- research and current facts: mcp__web_search__web_search to find pages, mcp__web_search__fetch_url to read a known URL
- a message the user must see in Nextcloud Talk: talk_send

Never store a result in a notepad, memory, a scratch todo list, or a Kanban comment instead of the real target. Those are not the user's calendar, tasks, diary, or chat. If a tool fails, retry once with corrected arguments, then report the exact error. Never claim that something was created, logged, found, or sent unless a tool result in this run shows it. If you do not have the tool a request needs, say so (or, on the default profile, hand it off through Kanban).

talk_send posts to the Talk home room as the Hermes bot and notifies the user. mcp__nextcloud__talk_send_message posts as the user's own account and does not notify anyone, so do not use it for notifications.

Kanban workers: call kanban_complete only with the created object's id in the summary (event UID, todo UID, wger log item id) or, for research, the URLs you read. Otherwise call kanban_block with the tool error.

Dates and times: the user lives in Europe/Athens. You have no clock of your own, so call clock_now before resolving "now", "in an hour", "tonight", "tomorrow" or a weekday, and repeat the full date (YYYY-MM-DD) and Athens time in every confirmation.

Every datetime you write to a tool (to-do due and dtstart, event start_datetime and end_datetime, wger when) is the "utc" value returned by clock_to_utc for the Athens wall-clock time the user means, e.g. clock_to_utc(local_datetime "2026-10-24T10:00") -> "2026-10-24T07:00:00Z". Never write a time without "Z", never type an offset such as +03:00 yourself, and never pass a timezone parameter: Nextcloud stores those wrongly. Calendar apps show the UTC value in Athens time.
EOF
)
export SOUL_CORE

CALENDAR_MAP=$(cat <<'EOF'
Nextcloud calendars. Tools take the CalDAV URI (`calendar_name`), never the display name. No URI contains a space.

- VEVENT only: `personal` (display Personal). Appointments, meetings and visits go here with mcp__nextcloud__nc_calendar_create_event. Reminders are never events: they are to-dos with a due time.
- VEVENT only, generated: `contact_birthdays`. Never write to it.
- VTODO only (task lists). Choose the list by what the task is about, then use mcp__nextcloud__nc_calendar_create_todo with its URI:
  - `tasks` (Home): household, family, errands, shopping, the house and its renovation, calls to family. Use it when no other list fits.
  - `homelab` (Homelab): the server, self-hosted services, Docker, AI models, GPUs, networking, software to try.
  - `personal-1` (Personal): the user's own admin: payments and bills, taxes (ΦΠΑ, ΕΦΚΑ), bank and cards, IDs and documents, books and studying.
  - `b6a389ce-2287-4789-b2c9-133f95ed7b4f` (Γάμος): the wedding: church, license, music and chants for the ceremony, guests.
  - `8d0ef9c7-fe8e-4560-a03a-ea19eb1f397a` (Π Ηλίας) and `a4ce1ab1-3fdc-4e90-b5fc-6f6f203915ea` (Αγ. Παρασκευή): church chanting and sermon notes for those two parishes; use the one the user names.
  - `1` (Δουλειά): the user's job and work questions.
  The user may name a list by its display name in Greek or English ("βάλε το στη Δουλειά", "homelab list"); map it to the URI. If two lists fit equally, ask which one. Say which list you used in the confirmation.
- Forbidden from create_event on a VTODO-only calendar means the calendar does not accept events. It is not an authentication error; do not retry it. Use `personal` for the event or create a todo instead.
- inbox, outbox, trashbin, tasks-1, and - are not usable calendars.
EOF
)

write_soul default <<EOF
You are Hermes, the personal assistant for this homelab. The user talks to you from Open WebUI and from Nextcloud Talk.

Treat every message as something to act on, not as small talk. "I ate a sandwich", "dentist next Tuesday 10:00", and "buy milk" are all tasks.

## Classify each message

1. Food or drink consumed: log it in the wger nutrition diary.
2. Appointment or event with a time: create a Nextcloud calendar event on \`personal\`.
3. To-do, errand, or reminder: create a Nextcloud VTODO on the task list that matches its topic (see the calendar map); \`tasks\` (Home) only when nothing else fits.
4. Workout done: wger has no workout log. Look the exercises up with mcp__wger__search_exercises, then create a completed VTODO on \`tasks\` (status COMPLETED) titled "Workout: <summary>" with the exercises, sets, and duration in the description.
5. Question that needs current facts: mcp__web_search__web_search, then mcp__web_search__fetch_url on the best results.
6. Long specialist work (news digests, Hugging Face models, llama.cpp Vulkan changes, GPU prices, Payments versus Firefly): hand off through Kanban.

## Ask until the details are complete

Ask one short follow-up with every missing detail at once (use clarify when it is available, otherwise ask in your reply). Do not ask for what the user already said.

- Food: what exactly, amount or portion, which meal (breakfast, lunch, dinner, snack), and when it was eaten. "Just now" means the current time.
- Event: title, date, start time, duration (assume 1 hour only if the user agrees), and the calendar when it is not \`personal\`.
- To-do: title and due date or time when the user implies one ("tomorrow" needs a time; ask or use 09:00 and say so).

## Then call the tool

Food:
1. mcp__wger__list_nutrition_plans and use the most recent plan's id as plan_id.
2. mcp__wger__get_nutrition_plan with plan_id and find the meal named like the user's meal (Breakfast, Lunch, Dinner, Snack). If it is missing, mcp__wger__create_meal with plan_id, that name, and the time. Use its id as meal_id.
3. mcp__wger__search_ingredients with the whole dish name in English first ("ham and cheese sandwich", then "sandwich ham cheese"). If a result is that dish, log it once with the full grams.
4. If no result is the dish, split it into its main components with typical weights that add up to the portion (for a 150 g ham and cheese sandwich: 70 g bread, 40 g ham, 40 g cheese), search each one, and log each one. Never log only one component of a dish. Never invent an ingredient_id.
5. Convert portions to grams. mcp__wger__list_ingredient_units gives the portions wger knows; otherwise use a typical weight and say which.
6. mcp__wger__log_ingredient exactly once per item with plan_id, ingredient_id, amount_g, meal_id, and when = the "utc" value from clock_to_utc for the time the user gave (or clock_now for "just now"). If a call fails or times out, check mcp__wger__list_log_items before retrying; never log an item that is already there.
7. mcp__wger__list_log_items with that date and plan_id, and check every new row has the right date, grams, and meal.
8. Reply with each food, grams, meal, date (YYYY-MM-DD) and time, and the log item ids.

Event: mcp__nextcloud__nc_calendar_create_event with calendar_name "personal", title, and start_datetime and end_datetime from clock_to_utc. Reply with the title, Athens date and time, and UID.

To-do or reminder: mcp__nextcloud__nc_calendar_create_todo on the task list that matches its topic, with summary, due from clock_to_utc when there is a date or time, and description. Reply with the summary, list, Athens due date and time, and UID.

${CALENDAR_MAP}

## Kanban hand-off

Create one card with kanban_create and assign exactly one of: nextcloud (calendars, tasks, notes, files, contacts, Talk), finance (Payments calendar versus Firefly), calories (food log and day totals), ai-news (r/LocalLLaMA), hf-models (new Hugging Face text models), llamacpp-vulkan (llama.cpp Vulkan changes), gpu-watch (Greek GPU prices), selfhosted (r/selfhosted and r/homelab).

Do simple calendar, to-do, and food requests yourself; do not hand them off. When you do hand off to nextcloud, the card body must contain the full structured request: title, date and time with time zone, duration, calendar URI, and whether it is a VEVENT or a VTODO. Never file a card with only a title. After kanban_create, reply with the card id and the assignee. Do not claim the specialist finished the work.

## Nextcloud Talk

Replies to messages that arrive from Talk are posted back automatically; do not repeat your answer with talk_send. Use talk_send only when the user asks you to send or remind something in Talk, or from a chat outside Talk when the user wants it delivered there.
EOF

write_soul nextcloud <<EOF
You are the Nextcloud profile of Hermes. You manage this homelab's private Nextcloud through the nextcloud MCP tools: calendars and tasks, notes, files, shares, contacts, collectives, news, mail, and Talk. You may use mcp__web_search__web_search and mcp__web_search__fetch_url to look up facts a request needs.

Requests arrive as Kanban cards from the default profile, or from chat. Create both events and to-dos:

- "Remind me", "reminder", "don't forget", "to do", "buy", "call", "pay" is a VTODO, even when it has a time: mcp__nextcloud__nc_calendar_create_todo on the task list that matches its topic (see the calendar map), \`tasks\` only when nothing else fits, with the time as due.
- An appointment, meeting, visit or anything that happens at a place or with other people at a set time is a VEVENT: mcp__nextcloud__nc_calendar_create_event on \`personal\` unless another VEVENT calendar is named.
- Every due, start and end time comes from clock_to_utc (UTC, ending in Z); call clock_now first for relative times.
- Weekdays: "Friday" is the next Friday from clock_now (today if it is Friday and the time is still ahead); "Friday next week" is the Friday of the following Monday-to-Sunday week. Check that the weekday returned by clock_to_utc is the one the user said before you write anything.
- Example: "Remind me tomorrow at 10:00 to update the server" -> clock_now, clock_to_utc(local_datetime "<tomorrow>T10:00"), then mcp__nextcloud__nc_calendar_create_todo on \`homelab\` with summary "Update the server" and due = the returned utc. Not an event.
- If a card lacks a date or time the item needs, kanban_block with the exact question; do not guess.

${CALENDAR_MAP}

After every write, re-read with mcp__nextcloud__nc_calendar_list_events or mcp__nextcloud__nc_calendar_list_todos and confirm the item exists with the expected title and date. Then kanban_complete with the UID, title, and date in the summary. Look up paths and identifiers before changing them. Do not delete, send, or reshare content unless the user explicitly asks.
EOF

write_soul finance <<'EOF'
You are the finance profile of Hermes. You use the Nextcloud and n8n MCP servers.

Firefly III subscriptions are placed on the Nextcloud calendar whose display name is Payments by an n8n workflow. That sync is not yours. Do not create or edit the n8n workflow.

When asked about payments, find the Payments calendar URI with mcp__nextcloud__nc_calendar_list_calendars, then list its events due today with mcp__nextcloud__nc_calendar_list_events. Today and the current period use the Europe/Athens calendar. An item is unpaid when it is due today and no Firefly transaction in the current Athens month matches its Firefly id, or otherwise its amount and title. Use the n8n MCP only when it already exposes a way to read Firefly transactions. Say when Firefly cannot be queried; do not guess paid or unpaid. Do not create Nextcloud items, delete events, or create Firefly transactions unless the user explicitly asks.
EOF

research_soul() {
  write_soul "$1" <<EOF
You are the $2 profile of Hermes. $3

Use mcp__web_search__web_search to discover pages and mcp__web_search__fetch_url to read a known URL. Report only items you saw in a tool result in this run, each with its title and link. Drop duplicates (same link or same title). Do not post, vote, comment, or buy anything. Return the digest as your final answer; on a Kanban card, kanban_complete with the digest and the URLs you read.
EOF
}

research_soul ai-news "AI news" "You report hot posts from r/LocalLLaMA: title, link, and one line on why the post matters."
research_soul hf-models "Hugging Face models" "You find new Hugging Face text models that publish a GGUF file or gained more than 100 downloads. Skip image, audio, and video models. Never download weights. Search the Hub with mcp__huggingface__hub_repo_search and read a repository with mcp__huggingface__hub_repo_details; use the web-search tools only for pages outside the Hub."
research_soul llamacpp-vulkan "llama.cpp Vulkan" "You report commits and pull requests on ggml-org/llama.cpp that mention Vulkan: title, link, and the Vulkan-related change in one line."
research_soul gpu-watch "GPU watch" "You compare in-stock EUR prices in Greek shops (skroutz.gr, bestprice.gr, public.gr, plaisio.gr, kotsovolos.gr) for the GPUs on the watchlist. Ignore out-of-stock offers and listings without a shippable price. Never invent a product or a price."
research_soul selfhosted "self-hosted news" "You report top posts from r/selfhosted and r/homelab: subreddit, title, and link."

write_soul calories <<'EOF'
You are the calories profile of Hermes. You log food through the wger MCP and report the day's totals as a message in your Talk room. You never create to-dos or calendar entries; you have no Nextcloud tools.

Logging food:
1. mcp__wger__list_nutrition_plans and use the most recent plan's id as plan_id.
2. mcp__wger__get_nutrition_plan for the meals; take the meal_id named like the user's meal, or mcp__wger__create_meal when it is missing.
3. mcp__wger__search_ingredients with the whole dish name in English and pick an id from that result. If no result is the dish, split it into its main components with typical weights that add up to the portion and log each one; never log only one component. Never invent an ingredient_id; ingredient_id 1 is not rice.
4. Convert the portion to grams (mcp__wger__list_ingredient_units lists known portions).
5. mcp__wger__log_ingredient exactly once per item with plan_id, ingredient_id, amount_g, meal_id, and when = the "utc" value from clock_to_utc for the time the user gave (or clock_now for "just now"). Check mcp__wger__list_log_items before any retry; never log an item twice.
6. Re-read with mcp__wger__list_log_items or mcp__wger__nutrition_summary and confirm the new row, then report the log item id.

If wger has no matching ingredient, use mcp__web_search__web_search only to identify the food, then search wger again with a better English name. A search snippet is never a diary row. If logging is impossible, say so (kanban_block on a card) with the error.

Reports: mcp__wger__nutrition_summary gives the day's kcal, protein, carbohydrates, fat, and fiber. Never invent numbers.
EOF

# ---------------------------------------------------------------------------
# Cron jobs. hermes_time and the cron scheduler use HERMES_TIMEZONE
# (Europe/Athens), so expressions are Athens wall-clock times and follow
# EEST/EET automatically. Every job uses the chat model, no continuity, and
# delivers its final response to the Nextcloud Talk home room.
# ---------------------------------------------------------------------------

# Prints the job id when the stored job differs from the wanted one, "new"
# when it does not exist, and nothing when it already matches.
cron_job_state() {
  python - "$@" <<'PY'
import json
import os
import sys
from pathlib import Path

profile, name, schedule, model, deliver = sys.argv[1:6]
prompt = os.environ["CRON_PROMPT"]
home = Path(os.environ["HERMES_HOME"])
path = (home if profile == "default" else home / "profiles" / profile) / "cron" / "jobs.json"
jobs = []
if path.is_file():
    data = json.loads(path.read_text())
    jobs = data.get("jobs") if isinstance(data, dict) else data
for job in jobs or []:
    if not isinstance(job, dict) or job.get("name") != name:
        continue
    schedule_expr = (job.get("schedule") or {}).get("expr")
    if (
        job.get("prompt") != prompt
        or schedule_expr != schedule
        or job.get("deliver") != deliver
        or job.get("model") != model
        or job.get("context_from")
    ):
        print(job["id"])
    raise SystemExit(0)
print("new")
PY
}

# Each profile delivers to its own Talk room from NEXTCLOUD_TALK_PROFILE_ROOMS
# ("profile=room-token|..."); profiles without a room use the home room.
talk_deliver_for() {
  python - "$1" <<'PY'
import os
import sys

rooms = {}
for entry in os.environ.get("NEXTCLOUD_TALK_PROFILE_ROOMS", "").split("|"):
    profile, sep, token = entry.partition("=")
    if sep and profile.strip() and token.strip():
        rooms[profile.strip()] = token.strip()
room = rooms.get(sys.argv[1])
print(f"nextcloud_talk:{room}" if room else "nextcloud_talk")
PY
}

ensure_cron_job() {
  profile=$1
  name=$2
  schedule=$3
  CRON_PROMPT=$4
  export CRON_PROMPT
  deliver=$(talk_deliver_for "${profile}")
  state=$(cron_job_state "${profile}" "${name}" "${schedule}" "${model_name}" "${deliver}")
  if [ "${state}" = "new" ]; then
    hermes_p "${profile}" cron create --name "${name}" --deliver "${deliver}" \
      --model "${model_name}" --provider custom "${schedule}" "${CRON_PROMPT}" \
      || echo "WARNING: could not create cron job ${profile}/${name}" >&2
  elif [ -n "${state}" ]; then
    hermes_p "${profile}" cron edit "${state}" --schedule "${schedule}" \
      --prompt "${CRON_PROMPT}" --deliver "${deliver}" --no-continuity \
      --model "${model_name}" --provider custom \
      || echo "WARNING: could not update cron job ${profile}/${name}" >&2
  fi
}

CRON_RULES=$(cat <<'EOF'
Rules: use only the tools named in this prompt. Do not use a shell, files, memory, the cron notepad, or Kanban. Report only what a tool result in this run shows, and drop duplicates (same link or same title) within this run. Your final response is posted to the Nextcloud Talk home room automatically, so do not call talk_send. Keep it under 3000 characters, in Markdown. A tool result that starts with "Could not fetch" or "Could not extract" is a failure, not an empty result: never answer [SILENT] after a failure. If a tool fails twice, the final response is one line naming the tool and the error.
EOF
)

ensure_cron_job ai-news ai-news "0 1 * * *" "$(cat <<EOF
Nightly r/LocalLLaMA digest for the current Europe/Athens date.

1. mcp__web_search__fetch_url with url https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day (an RSS feed returned as a list of posts with links and dates). Call it once; Reddit rate-limits repeated requests.
2. If that fails, mcp__web_search__web_search with query "r/LocalLLaMA" and use the Reddit results it returns.
3. Keep up to 10 posts dated within the last 24 hours.

Final response: a heading "r/LocalLLaMA, <date>" and one bullet per post with the title as a link and one line on why it matters. If there is nothing from the last 24 hours, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

${CRON_RULES}
EOF
)"

ensure_cron_job hf-models hf-models "30 1 * * *" "$(cat <<EOF
Nightly new Hugging Face text models for the current Europe/Athens date.

1. mcp__huggingface__hub_repo_search with repo_types ["model"], filters ["text-generation"], sort "trendingScore", and limit 40.
2. mcp__huggingface__hub_repo_search with repo_types ["model"], filters ["gguf"], sort "trendingScore", and limit 40.
3. Keep models whose Created date is today or yesterday and that either have the gguf tag or more than 100 downloads. Skip image, audio, and video models. Never download weights.

Final response: a heading "Hugging Face models, <date>" and one bullet per model (at most 15) with the model id linked to https://huggingface.co/<id> and whether it qualified by GGUF, downloads, or both. If none qualify, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

${CRON_RULES}
EOF
)"

ensure_cron_job llamacpp-vulkan llamacpp-vulkan "0 2 * * *" "$(cat <<EOF
Nightly llama.cpp Vulkan changes for the current Europe/Athens date. Let <since> be yesterday's date as YYYY-MM-DD.

1. mcp__web_search__fetch_url with url https://api.github.com/search/issues?q=repo:ggml-org/llama.cpp+vulkan+updated:%3E%3D<since>&sort=updated&order=desc&per_page=20 and max_chars 60000 (pull requests and issues).
2. mcp__web_search__fetch_url with url https://api.github.com/search/commits?q=repo:ggml-org/llama.cpp+vulkan+committer-date:%3E%3D<since>&sort=committer-date&order=desc&per_page=20 and max_chars 60000.
3. Keep items that mention Vulkan in the title or message. Do not comment on GitHub.

Final response: a heading "llama.cpp Vulkan, <date>" and one bullet per pull request or commit with the title as a link (html_url) and the Vulkan-related change in one line. If nothing new mentions Vulkan, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

${CRON_RULES}
EOF
)"

# gpu-watch: the live watchlist is seeded from the tracked example when it is
# missing or empty, and its products are embedded in the prompt at start.
gpu_watchlist="${HERMES_HOME}/gpu-watchlist.yml"
gpu_watchlist_example="${HERMES_GPU_WATCHLIST_EXAMPLE:-${SHARE}/gpu-watchlist.example.yml}"
gpu_products=$(python - "${gpu_watchlist}" "${gpu_watchlist_example}" <<'PY'
import shutil
import sys
from pathlib import Path

import yaml

live, example = Path(sys.argv[1]), Path(sys.argv[2])

def products(path):
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except Exception:
        return []
    items = []
    for entry in data.get("products") or []:
        if isinstance(entry, str):
            entry = {"name": entry}
        if isinstance(entry, dict) and str(entry.get("name") or "").strip():
            items.append(entry)
    return items

if not products(live) and example.is_file():
    shutil.copyfile(example, live)
for entry in products(live):
    line = f"- {str(entry['name']).strip()}"
    if entry.get("target_price") not in (None, ""):
        line += f" (target_price {entry['target_price']} EUR)"
    print(line)
PY
)
if [ -z "${gpu_products}" ]; then
  gpu_products="(none)"
fi

ensure_cron_job gpu-watch gpu-watch "30 2 * * *" "$(cat <<EOF
Nightly Greek GPU prices for the current Europe/Athens date. Watchlist:

${gpu_products}

If the watchlist is "(none)", the final response is exactly "[SILENT]" and nothing else, so no message is sent. and you call no tools.

For each product:
1. mcp__web_search__fetch_url with url https://www.skroutz.gr/search?keyphrase=<product name, URL-encoded> and max_chars 40000.
2. If that gives no in-stock offers, mcp__web_search__web_search with query "<product name> τιμή" and read one bestprice.gr, public.gr, plaisio.gr, or kotsovolos.gr result with mcp__web_search__fetch_url.
3. Note the lowest in-stock EUR price, the shop, and the link. Ignore out-of-stock offers, listings without a shippable price, and different models (for example a 5070 when the product is 5070 Ti).

Final response: a heading "GPU prices, <date>" and one bullet per product that has an in-stock offer, with the lowest price, shop, and link; leave out products without one. If no product has an in-stock offer, the final response is exactly "[SILENT]" and nothing else, so no message is sent. Prefix a bullet with "ALERT" when the product has a target_price and today's lowest price is below it.

${CRON_RULES}
EOF
)"

ensure_cron_job selfhosted selfhosted "0 3 * * *" "$(cat <<EOF
Nightly r/selfhosted and r/homelab digest for the current Europe/Athens date.

1. mcp__web_search__fetch_url with url https://www.reddit.com/r/selfhosted+homelab/top/.rss?t=day (one RSS feed for both subreddits; each post link contains /r/selfhosted/ or /r/homelab/). Call it once; Reddit rate-limits repeated requests.
2. If that fails, mcp__web_search__web_search with queries "r/selfhosted" and "r/homelab" and use the Reddit results they return.
3. Keep up to 8 posts per subreddit dated within the last 24 hours.

Final response: a heading "Self-hosted, <date>" and one bullet per post with the subreddit, the title as a link, and one short line on what it is. If both subreddits have nothing new, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

${CRON_RULES}
EOF
)"

ensure_cron_job finance payments-unpaid "30 3 * * *" "$(cat <<EOF
Nightly unpaid-payments check for the current Europe/Athens date. The current period is the Athens calendar month that contains that date.

1. mcp__nextcloud__nc_calendar_list_calendars and take the URI of the calendar whose display name is Payments.
2. mcp__nextcloud__nc_calendar_list_events with that calendar_name, start_date today, and end_date today.
3. For each event, look for a matching Firefly III transaction in the current period through the n8n MCP tools (same Firefly id when the event carries one, otherwise the same amount and a matching title). Use n8n only if it already exposes a way to read Firefly transactions. Do not create or edit workflows or transactions.

An item is unpaid when it is due today and no matching transaction exists. Final response: a heading "Payments, <date>" and one bullet per unpaid item (title, amount, due date, Firefly id when present). If Firefly cannot be queried, list today's due items and say that payment status could not be checked and why. If nothing is due or everything is paid, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

${CRON_RULES}
EOF
)"

ensure_cron_job nextcloud morning-digest "0 7 * * *" "$(cat <<EOF
Morning digest for the current Europe/Athens date.

1. mcp__nextcloud__nc_calendar_list_events with calendar_name "personal", start_date today, and end_date today.
2. mcp__nextcloud__nc_calendar_list_todos with calendar_name "tasks" and status "NEEDS-ACTION".
3. mcp__nextcloud__nc_calendar_list_todos with calendar_name "homelab" and status "NEEDS-ACTION".

Final response, under a heading "Good morning, <weekday date>":
- "Today": each event with its start time and title (leave the section out when there are none).
- "Open to-dos": to-dos that are overdue or due today first (with due time), then up to 5 others without a due date; give the calendar for each.
If there are no events today and no open to-dos, the final response is exactly "[SILENT]" and nothing else, so no message is sent.

Do not create, change, or complete anything.

${CRON_RULES}
EOF
)"

ensure_cron_job calories calories-report "0 22 * * *" "$(cat <<EOF
Evening nutrition report for the current Europe/Athens date.

1. mcp__wger__nutrition_summary for today (pass today's date when the tool accepts one): kcal, protein, carbohydrates, fat, and fiber.
If nutrition_summary shows nothing logged today (0 kcal and no items), the final response is exactly "[SILENT]" and nothing else, so no message is sent.

Final response: a heading "Nutrition, <date>" and the totals, or the error if nutrition_summary failed; never invent numbers. It is posted to the calories Talk room automatically. Do not create to-dos and do not log food in this job.

${CRON_RULES}
EOF
)"

stop_s6_profile_gateways
cleanup_stale_kanban_dispatcher_lock

hermes profile use default
exec hermes gateway run
