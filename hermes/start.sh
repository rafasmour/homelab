#!/bin/sh
set -eu

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
    for profile in default nextcloud finance ai-news hf-models llamacpp-vulkan gpu-watch selfhosted calories router digest; do
      # -D records want-down. -d does not, so a gateway that has already
      # exited stays "normally up" and s6 starts it again.
      "${s6_svc}" -D "/run/service/gateway-${profile}" 2>/dev/null || true
    done
  fi
}

hermes plugins disable web/forage 2>/dev/null || true
# A sticky specialist profile would send these writes and cron jobs there.
hermes profile use default
stop_s6_profile_gateways
cleanup_stale_kanban_dispatcher_lock

# Chat on the API (Open WebUI) only routes work. no_mcp hides MCP from that
# chat. Nightly cron runs inside each specialist profile, ticked by this
# gateway because gateway.multiplex_profiles is on.
soul="${HERMES_HOME}/SOUL.md"
soul_is_stock=0
if [ -f "${soul}" ] && grep -q "You are Hermes Agent, an intelligent AI assistant created by Nous Research." "${soul}"; then
  soul_is_stock=1
fi
if [ ! -f "${soul}" ] || [ "${soul_is_stock}" -eq 1 ]; then
  cat > "${soul}" <<'EOF'
You are the dispatcher for this homelab. You do not search, browse, or call Nextcloud, n8n, draw.io, or wger yourself. A specialist profile does that work after you file it.

When the user gives you a task, create one Kanban card with kanban_create. Put the user's full request in the body. Set assignee to exactly one of these profiles:

- nextcloud — files, shares, notes, calendars, tasks, contacts, mail, Talk
- finance — the Payments calendar and whether a due item has a Firefly transaction
- calories — log food and read the day's nutrition
- ai-news — hot posts from r/LocalLLaMA
- hf-models — new Hugging Face text models
- llamacpp-vulkan — llama.cpp commits and pull requests that mention Vulkan
- gpu-watch — in-stock Greek GPU prices
- selfhosted — top posts from r/selfhosted and r/homelab

If the request matches none of those, say so and do not create a card. Do not invent a profile name. After a card is created, reply with its id and the assignee. The specialist picks the card up on its own. Up to four specialist runs can be in flight; they share one local model, so extra workers wait on the GPU. Do not wait for the specialist to finish.

Do not claim a specialist finished the work. Creating the Kanban card is your only success. Specialists verify that the real entry exists on their report target; you cannot see those tools.
EOF
  chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}" "${soul}" 2>/dev/null || true
fi
if [ -f "${soul}" ] && ! grep -Fq "Do not claim a specialist finished" "${soul}"; then
  printf '\nDo not claim a specialist finished the work. Creating the Kanban card is your only success. Specialists verify that the real entry exists on their report target; you cannot see those tools.\n' >> "${soul}"
fi

python - <<'PY'
import os
from pathlib import Path

import yaml

path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
data = yaml.safe_load(path.read_text()) or {}
platforms = data.get("platform_toolsets")
if not isinstance(platforms, dict):
    platforms = {}
platforms["api_server"] = ["kanban", "no_mcp"]
data["platform_toolsets"] = platforms
# kanban_create stays hidden unless this list names the toolset, even when
# the API platform already selected it.
data["toolsets"] = ["kanban"]
kanban = data.get("kanban")
if not isinstance(kanban, dict):
    kanban = {}
kanban["dispatch_in_gateway"] = True
kanban["dispatch_interval_seconds"] = 15
kanban["max_in_progress"] = 4
kanban["max_spawn"] = 4
kanban["review_dispatch"] = False
# Specialist MCP writes (Nextcloud todos, web-search fetches) can exceed
# the 3–7 minute Hermes defaults. One hour is the homelab tool deadline.
kanban["dispatch_stale_timeout_seconds"] = 3600
data["kanban"] = kanban
timeouts = data.get("timeouts")
if not isinstance(timeouts, dict):
    timeouts = {}
tools_timeouts = timeouts.get("tools")
if not isinstance(tools_timeouts, dict):
    tools_timeouts = {}
tools_timeouts["concurrent_batch"] = 3600
tools_timeouts["sequential_call"] = 3600
timeouts["tools"] = tools_timeouts
mcp_timeouts = timeouts.get("mcp")
if not isinstance(mcp_timeouts, dict):
    mcp_timeouts = {}
mcp_timeouts["tool_call"] = 3600
timeouts["mcp"] = mcp_timeouts
data["timeouts"] = timeouts
terminal = data.get("terminal")
if not isinstance(terminal, dict):
    terminal = {}
terminal["timeout"] = 3600
data["terminal"] = terminal
providers = data.get("providers")
if not isinstance(providers, dict):
    providers = {}
custom_provider = providers.get("custom")
if not isinstance(custom_provider, dict):
    custom_provider = {}
custom_provider["request_timeout_seconds"] = 3600
providers["custom"] = custom_provider
data["providers"] = providers
gateway = data.get("gateway")
if not isinstance(gateway, dict):
    gateway = {}
# One gateway ticks every profile cron store and runs each job in that
# profile's home. Specialist gateways stay stopped.
gateway["multiplex_profiles"] = True
data["gateway"] = gateway
path.write_text(yaml.safe_dump(data, sort_keys=False))
PY
chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}" "${HERMES_HOME}/config.yaml" 2>/dev/null || true
hermes kanban init

hermes config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":3600,"enabled":true}'
hermes config set mcp_servers.n8n \
  "{\"url\":\"http://n8n-mcp:3000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${N8N_MCP_AUTH_TOKEN}\"},\"connect_timeout\":60,\"timeout\":3600,\"enabled\":true}"
hermes config set mcp_servers.drawio \
  '{"url":"http://drawio-mcp:8000/mcp","connect_timeout":60,"timeout":3600,"enabled":true}'
hermes config set mcp_servers.web_search \
  "{\"url\":\"http://web-search-mcp:8000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${WEB_SEARCH_MCP_TOKEN}\"},\"connect_timeout\":60,\"timeout\":3600,\"enabled\":true}"

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

hermes config set model.provider custom
hermes config set model.base_url "${inference_base_url}"
hermes config set model.api_mode chat_completions
hermes config set model.default "${model_name}"
hermes config set model.context_length 262144

nextcloud_profile="${HERMES_HOME}/profiles/nextcloud"
if [ ! -f "${nextcloud_profile}/config.yaml" ]; then
  hermes profile create nextcloud --no-skills --no-alias \
    --description "Manages files, shares, notes, calendars, contacts, collectives, news, mail, and Talk on the private Nextcloud through its MCP server."
  cat > "${nextcloud_profile}/SOUL.md" <<'EOF'
You are the Nextcloud profile of Hermes. You manage this homelab's private Nextcloud through the nextcloud MCP tools.

Use those tools for files, shares, notes, calendars and tasks, contacts, collectives, news, mail, and Talk. Look up paths and identifiers before changing them. Do not delete, send, or reshare content unless the user explicitly asks. Say what you changed when a write succeeds. Never mark a Kanban card or reminder complete unless the matching Nextcloud MCP write returned success. If the tool fails or is missing, report the error and leave the work incomplete.

After every write, re-read with a Nextcloud MCP list or get and confirm the item exists with the expected title and due. Never kanban_complete on a planned or remembered action. Never claim success or mark a Kanban card complete unless that follow-up read shows the real entry.

Calendar writes:
- Call nc_calendar_list_calendars first. Pass that tool's exact name, the CalDAV URI. Never pass a display name, and never invent a calendar name. No live calendar name contains a space. Do not pass a name that contains a space, including "nextcloud tasks".
- nc_calendar_list_calendars does not report component types. Use this map:
  - VEVENT only: personal (display Personal). Put timed events and event alarms here with nc_calendar_create_event and a reminders entry (action DISPLAY, minutes_before). Do not write user events to contact_birthdays; it is the generated birthday calendar and is also VEVENT only.
  - VTODO only: tasks (display Home), homelab (Homelab), personal-1 (also displayed as Personal), 1 (Δουλειά), b6a389ce-2287-4789-b2c9-133f95ed7b4f (Γάμος), 8d0ef9c7-fe8e-4560-a03a-ea19eb1f397a (Π Ηλίας), a4ce1ab1-3fdc-4e90-b5fc-6f6f203915ea (Αγ. Παρασκευή). Put tasks and task reminders on tasks with nc_calendar_create_todo and its reminders argument, unless the user names one of the other VTODO calendars.
- Forbidden from nc_calendar_create_event on tasks, or on any VTODO-only calendar, means that calendar does not accept VEVENT. The app password is fine. Do not treat it as an authentication outage, and do not retry the same create_event or create duplicate todos.
- Deleted collections tasks-1 and - are not calendars you can use. inbox, outbox, and trashbin are scheduling collections, not calendars.
EOF
fi

hermes -p nextcloud config set model.provider custom
hermes -p nextcloud config set model.base_url "${inference_base_url}"
hermes -p nextcloud config set model.api_mode chat_completions
hermes -p nextcloud config set model.default "${model_name}"
hermes -p nextcloud config set model.context_length 262144
hermes -p nextcloud config set timeouts.tools.concurrent_batch 3600
hermes -p nextcloud config set timeouts.tools.sequential_call 3600
hermes -p nextcloud config set timeouts.mcp.tool_call 3600
hermes -p nextcloud config set terminal.timeout 3600
hermes -p nextcloud config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":3600,"enabled":true}'
if [ -f "${nextcloud_profile}/SOUL.md" ] && ! grep -q "Never mark a Kanban card" "${nextcloud_profile}/SOUL.md"; then
  printf '\nNever mark a Kanban card or reminder complete unless the matching Nextcloud MCP write returned success. If the tool fails or is missing, report the error and leave the work incomplete.\n' >> "${nextcloud_profile}/SOUL.md"
fi
if [ -f "${nextcloud_profile}/SOUL.md" ] && ! grep -Fq "Never kanban_complete on a planned" "${nextcloud_profile}/SOUL.md"; then
  printf '\nAfter every write, re-read with a Nextcloud MCP list or get and confirm the item exists with the expected title and due. Never kanban_complete on a planned or remembered action. Never claim success or mark a Kanban card complete unless that follow-up read shows the real entry.\n' >> "${nextcloud_profile}/SOUL.md"
fi

mcp_server_exists() {
  python - "$1" "$2" <<'PY'
import os
import sys
from pathlib import Path

import yaml

profile, server = sys.argv[1], sys.argv[2]
home = Path(os.environ["HERMES_HOME"])
if profile == "-":
    path = home / "config.yaml"
else:
    path = home / "profiles" / profile / "config.yaml"
if not path.is_file():
    sys.exit(1)
data = yaml.safe_load(path.read_text()) or {}
servers = data.get("mcp_servers") or {}
sys.exit(0 if isinstance(servers, dict) and server in servers else 1)
PY
}

cron_jobs_path() {
  python - "$1" <<'PY'
import os
import sys
from pathlib import Path

profile = sys.argv[1]
home = Path(os.environ["HERMES_HOME"])
if profile == "default":
    print(home / "cron" / "jobs.json")
else:
    print(home / "profiles" / profile / "cron" / "jobs.json")
PY
}

cron_job_exists() {
  profile=$1
  name=$2
  python - "${profile}" "${name}" <<'PY'
import json
import os
import sys
from pathlib import Path

profile, name = sys.argv[1], sys.argv[2]
home = Path(os.environ["HERMES_HOME"])
if profile == "default":
    path = home / "cron" / "jobs.json"
else:
    path = home / "profiles" / profile / "cron" / "jobs.json"
if not path.is_file():
    sys.exit(1)
data = json.loads(path.read_text())
jobs = data.get("jobs") if isinstance(data, dict) else data
jobs = jobs or []
sys.exit(
    0
    if any(isinstance(job, dict) and job.get("name") == name for job in jobs)
    else 1
)
PY
}

# Jobs used to live in the default profile store. Move one by name into the
# specialist store, including its notepad rows, so a restart does not leave
# a second copy on the default gateway.
relocate_default_cron_job() {
  profile=$1
  name=$2
  python - "${profile}" "${name}" <<'PY'
import json
import os
import sqlite3
import sys
from pathlib import Path

profile, name = sys.argv[1], sys.argv[2]
home = Path(os.environ["HERMES_HOME"])
default_path = home / "cron" / "jobs.json"
profile_dir = home / "profiles" / profile / "cron"
profile_path = profile_dir / "jobs.json"

def load(path):
    if not path.is_file():
        return {"jobs": [], "updated_at": None}
    data = json.loads(path.read_text())
    if isinstance(data, list):
        data = {"jobs": data}
    if not isinstance(data, dict):
        data = {"jobs": []}
    data.setdefault("jobs", [])
    return data

if not default_path.is_file():
    sys.exit(0)
default = load(default_path)
moved = [
    job for job in default["jobs"]
    if isinstance(job, dict) and job.get("name") == name
]
if not moved:
    sys.exit(0)
default["jobs"] = [
    job for job in default["jobs"]
    if not (isinstance(job, dict) and job.get("name") == name)
]
profile_data = load(profile_path)
have = {
    job.get("name")
    for job in profile_data["jobs"]
    if isinstance(job, dict)
}
profile_dir.mkdir(parents=True, exist_ok=True)
try:
    os.chmod(profile_dir, 0o700)
except OSError:
    pass
if name not in have:
    profile_data["jobs"].extend(moved)
    profile_path.write_text(json.dumps(profile_data, indent=2) + "\n")
    os.chmod(profile_path, 0o600)
    src = home / "cron" / "notepad.db"
    if src.is_file():
        ids = [job.get("id") for job in moved if job.get("id")]
        if ids:
            src_conn = sqlite3.connect(src)
            try:
                exists = src_conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cron_notepad'"
                ).fetchone()
                if exists:
                    marks = ",".join("?" * len(ids))
                    notes = src_conn.execute(
                        f"SELECT job_id, key, value, updated_at FROM cron_notepad WHERE job_id IN ({marks})",
                        ids,
                    ).fetchall()
                    if notes:
                        dst = profile_dir / "notepad.db"
                        dst_conn = sqlite3.connect(dst)
                        try:
                            dst_conn.execute(
                                """CREATE TABLE IF NOT EXISTS cron_notepad (
                                     job_id TEXT NOT NULL,
                                     key TEXT NOT NULL,
                                     value TEXT NOT NULL,
                                     updated_at TEXT NOT NULL,
                                     PRIMARY KEY (job_id, key)
                                   )"""
                            )
                            dst_conn.executemany(
                                "INSERT OR REPLACE INTO cron_notepad (job_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
                                notes,
                            )
                            dst_conn.commit()
                        finally:
                            dst_conn.close()
                    src_conn.execute(
                        f"DELETE FROM cron_notepad WHERE job_id IN ({marks})",
                        ids,
                    )
                    src_conn.commit()
            finally:
                src_conn.close()
default_path.write_text(json.dumps(default, indent=2) + "\n")
PY
  chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}" \
    "${HERMES_HOME}/cron" \
    "${HERMES_HOME}/cron/jobs.json" \
    "${HERMES_HOME}/profiles/${profile}/cron" \
    "${HERMES_HOME}/profiles/${profile}/cron/jobs.json" \
    2>/dev/null || true
  if [ -f "${HERMES_HOME}/profiles/${profile}/cron/notepad.db" ]; then
    chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}" \
      "${HERMES_HOME}/profiles/${profile}/cron/notepad.db" \
      2>/dev/null || true
  fi
}

write_cron_prompt() {
  profile=$1
  name=$2
  prompt=$3
  python - "${profile}" "${name}" "${prompt}" <<'PY'
import json
import os
import sys
from pathlib import Path

profile, name, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
home = Path(os.environ["HERMES_HOME"])
path = home / "profiles" / profile / "cron" / "jobs.json"
if not path.is_file():
    sys.exit(0)
data = json.loads(path.read_text())
jobs = data.get("jobs") if isinstance(data, dict) else None
if not isinstance(jobs, list):
    sys.exit(0)
changed = False
for job in jobs:
    if isinstance(job, dict) and job.get("name") == name and job.get("prompt") != prompt:
        job["prompt"] = prompt
        changed = True
if changed:
    path.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(path, 0o600)
PY
  chown "${HERMES_UID:-1000}:${HERMES_GID:-1000}" \
    "${HERMES_HOME}/profiles/${profile}/cron" \
    "${HERMES_HOME}/profiles/${profile}/cron/jobs.json" \
    2>/dev/null || true
}

append_soul_if_missing() {
  soul=$1
  needle=$2
  paragraph=$3
  if [ -f "${soul}" ] && ! grep -Fq "${needle}" "${soul}"; then
    printf '\n%s\n' "${paragraph}" >> "${soul}"
  fi
}

ensure_profile() {
  name=$1
  description=$2
  profile_dir="${HERMES_HOME}/profiles/${name}"
  if [ -f "${profile_dir}/config.yaml" ]; then
    return 0
  fi
  hermes profile create "${name}" --no-skills --no-alias \
    --description "${description}" </dev/null
  cat > "${profile_dir}/SOUL.md"
}

configure_profile_model() {
  profile=$1
  hermes -p "${profile}" config set model.provider custom
  hermes -p "${profile}" config set model.base_url "${inference_base_url}"
  hermes -p "${profile}" config set model.api_mode chat_completions
  hermes -p "${profile}" config set model.default "${model_name}"
  hermes -p "${profile}" config set model.context_length 262144
  hermes -p "${profile}" config set timeouts.tools.concurrent_batch 3600
  hermes -p "${profile}" config set timeouts.tools.sequential_call 3600
  hermes -p "${profile}" config set timeouts.mcp.tool_call 3600
  hermes -p "${profile}" config set terminal.timeout 3600
}

ensure_web_search_mcp() {
  profile=$1
  : "${WEB_SEARCH_MCP_TOKEN:?Set WEB_SEARCH_MCP_TOKEN in .env}"
  payload="{\"url\":\"http://web-search-mcp:8000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${WEB_SEARCH_MCP_TOKEN}\"},\"connect_timeout\":60,\"timeout\":3600,\"enabled\":true}"
  hermes -p "${profile}" config set mcp_servers.web_search "${payload}"
}

rewrite_forage_soul() {
  soul="${HERMES_HOME}/profiles/$1/SOUL.md"
  if [ ! -f "${soul}" ]; then
    return 0
  fi
  sed -i \
    -e 's/Use Forage search and extract, the SearXNG-backed backend,/Use the mcp_web_search_web_search tool/' \
    -e 's/Use Forage search and extract/Use the mcp_web_search_web_search tool/g' \
    -e 's/through Forage/through mcp_web_search_web_search/g' \
    -e 's/uses Forage when/uses mcp_web_search_web_search when/g' \
    -e 's/use Forage when/use mcp_web_search_web_search when/g' \
    -e 's/use Forage to/use mcp_web_search_web_search to/g' \
    -e 's/Use Forage to/Use mcp_web_search_web_search to/g' \
    -e 's/and Forage\/SearXNG/and mcp_web_search_web_search/g' \
    "${soul}"
}

register_wger_mcp() {
  profile=$1
  : "${MCP_STATIC_TOKEN:?Set MCP_STATIC_TOKEN to register the wger MCP server}"
  payload="{\"url\":\"http://wger-mcp:8765/mcp\",\"headers\":{\"Authorization\":\"Bearer ${MCP_STATIC_TOKEN}\"},\"connect_timeout\":60,\"timeout\":3600,\"enabled\":true}"
  if [ "${profile}" = "-" ]; then
    hermes config set mcp_servers.wger "${payload}"
  else
    hermes -p "${profile}" config set mcp_servers.wger "${payload}"
  fi
}

# Kanban workers spawn with --toolsets from the assignee's CLI platform list.
# An unpinned specialist inherits hermes-cli (web, memory, forage, terminal),
# so a small model can kanban_complete after a builtin search and never call MCP.
# Pin CLI tools to kanban plus that profile's MCP servers. Kanban lifecycle
# tools stay available for workers; MCP is the implementation surface.
pin_specialist_cli_tools() {
  profile=$1
  shift
  python - "$profile" "$@" <<'PY'
import os
import sys
from pathlib import Path

import yaml

profile = sys.argv[1]
mcp_names = list(sys.argv[2:])
path = Path(os.environ["HERMES_HOME"]) / "profiles" / profile / "config.yaml"
if not path.is_file():
    raise SystemExit(0)
data = yaml.safe_load(path.read_text()) or {}
platforms = data.get("platform_toolsets")
if not isinstance(platforms, dict):
    platforms = {}
wanted = ["kanban", *mcp_names]
if platforms.get("cli") != wanted:
    platforms["cli"] = wanted
    data["platform_toolsets"] = platforms
agent = data.get("agent")
if not isinstance(agent, dict):
    agent = {}
disabled = [
    "memory",
    "web",
    "browser",
    "forage",
    "delegation",
    "clarify",
    "todo",
    "vision",
    "tts",
    "stt",
    "image_gen",
    "computer_use",
    "code_execution",
    "session_search",
    "skills",
    "cronjob",
    "file",
    "terminal",
]
if agent.get("disabled_toolsets") != disabled:
    agent["disabled_toolsets"] = disabled
    data["agent"] = agent
plugins = data.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
enabled = [name for name in (plugins.get("enabled") or []) if name != "web/forage"]
disabled_plugins = list(plugins.get("disabled") or [])
if "web/forage" not in disabled_plugins:
    disabled_plugins.append("web/forage")
plugins["enabled"] = enabled
plugins["disabled"] = disabled_plugins
data["plugins"] = plugins
# MCP tools must sit in the model schema. auto tool_search defers them
# behind tool_describe, and a small local model will describe forever
# instead of calling log_ingredient / nutrition_summary.
tools = data.get("tools")
if not isinstance(tools, dict):
    tools = {}
tool_search = tools.get("tool_search")
if not isinstance(tool_search, dict):
    tool_search = {}
if tool_search.get("enabled") != "off":
    tool_search["enabled"] = "off"
    tools["tool_search"] = tool_search
    data["tools"] = tools
path.write_text(yaml.safe_dump(data, sort_keys=False))
PY
  hermes -p "${profile}" plugins disable web/forage 2>/dev/null || true
}

ensure_cron_job() {
  profile=$1
  name=$2
  schedule=$3
  continuity=$4
  prompt=$5
  relocate_default_cron_job "${profile}" "${name}"
  if cron_job_exists "${profile}" "${name}"; then
    return 0
  fi
  if [ "${continuity}" = "yes" ]; then
    hermes -p "${profile}" cron create --name "${name}" --deliver local --continuity \
      "${schedule}" "${prompt}"
  else
    hermes -p "${profile}" cron create --name "${name}" --deliver local \
      "${schedule}" "${prompt}"
  fi
}

gpu_watchlist="${HERMES_HOME}/gpu-watchlist.yml"
gpu_watchlist_example="${HERMES_GPU_WATCHLIST_EXAMPLE:-/usr/local/share/hermes/gpu-watchlist.example.yml}"
if [ ! -f "${gpu_watchlist}" ]; then
  cp "${gpu_watchlist_example}" "${gpu_watchlist}"
fi

register_wger_mcp -

pin_specialist_cli_tools nextcloud nextcloud

ensure_profile finance \
  "Checks Firefly subscriptions on the Nextcloud Payments calendar and records which events due today have no matching Firefly transaction." <<'EOF'
You are the finance profile of Hermes. You use the Nextcloud and n8n MCP servers.

Firefly III subscriptions are placed on the Nextcloud calendar named Payments by an n8n workflow. That sync is not yours. Do not create or edit the n8n workflow.

When asked about payments, list events due today on the Payments calendar. Today and the current period use the Europe/Athens calendar. An item is unpaid when it is due today and no Firefly transaction in the current Athens month matches its Firefly id, or otherwise its amount and title. Say when Firefly cannot be queried. Do not guess that an item is paid or unpaid. Do not create Nextcloud tasks or send Talk messages unless the user explicitly asks. Do not delete events or create Firefly transactions unless the user explicitly asks.

Verify every listed Payments event and Firefly match with a Nextcloud or n8n MCP read in this run. Do not invent paid or unpaid. Never claim success or mark a Kanban card complete unless those reads returned the items you report.
EOF
configure_profile_model finance
hermes -p finance config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":3600,"enabled":true}'
hermes -p finance config set mcp_servers.n8n \
  "{\"url\":\"http://n8n-mcp:3000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${N8N_MCP_AUTH_TOKEN}\"},\"connect_timeout\":60,\"timeout\":3600,\"enabled\":true}"
append_soul_if_missing "${HERMES_HOME}/profiles/finance/SOUL.md" \
  "Verify every listed Payments event" \
  "Verify every listed Payments event and Firefly match with a Nextcloud or n8n MCP read in this run. Do not invent paid or unpaid. Never claim success or mark a Kanban card complete unless those reads returned the items you report."
pin_specialist_cli_tools finance nextcloud n8n

ensure_profile ai-news \
  "Reads hot r/LocalLLaMA posts through the web-search MCP and drops items already reported." <<'EOF'
You are the AI news profile of Hermes. Use the mcp_web_search_web_search tool to read hot posts from r/LocalLLaMA.

Drop posts already covered in this chat. Summarize title, link, and why the post matters. Do not post, vote, or send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches.
EOF
configure_profile_model ai-news
ensure_web_search_mcp ai-news
rewrite_forage_soul ai-news
append_soul_if_missing "${HERMES_HOME}/profiles/ai-news/SOUL.md" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches."
pin_specialist_cli_tools ai-news web_search

ensure_profile hf-models \
  "Finds new Hugging Face text models that have a GGUF or more than 100 downloads in 24 hours." <<'EOF'
You are the Hugging Face models profile of Hermes. Use the mcp_web_search_web_search tool to find new text models that have a GGUF file or more than 100 downloads in the last 24 hours.

Skip image, audio, and video models. Drop models already covered in this chat. Do not download weights. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches.
EOF
configure_profile_model hf-models
ensure_web_search_mcp hf-models
rewrite_forage_soul hf-models
append_soul_if_missing "${HERMES_HOME}/profiles/hf-models/SOUL.md" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches."
pin_specialist_cli_tools hf-models web_search

ensure_profile llamacpp-vulkan \
  "Watches ggml-org/llama.cpp commits and pull requests that mention Vulkan." <<'EOF'
You are the llama.cpp Vulkan profile of Hermes. Use the mcp_web_search_web_search tool to read commits and pull requests on ggml-org/llama.cpp that mention Vulkan.

Include the title, link, and the Vulkan-related change. Drop items already covered in this chat. Do not comment on GitHub. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches.
EOF
configure_profile_model llamacpp-vulkan
ensure_web_search_mcp llamacpp-vulkan
rewrite_forage_soul llamacpp-vulkan
append_soul_if_missing "${HERMES_HOME}/profiles/llamacpp-vulkan/SOUL.md" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches."
pin_specialist_cli_tools llamacpp-vulkan web_search

ensure_profile gpu-watch \
  "Compares in-stock Greek shop prices for GPUs on the watchlist and stays silent until product names are added." <<'EOF'
You are the GPU watch profile of Hermes. Use the mcp_web_search_web_search tool for in-stock EUR prices on skroutz.gr, public.gr, and plaisio.gr, and mcp_web_search_web_search for other Greek shops such as kotsovolos.gr and bestprice.gr.

Read /home/hermes/.hermes/gpu-watchlist.yml. If products is empty, stay silent and do not invent product names. Alert only when today's lowest in-stock price is below the last price you stored for that GPU. When a product has target_price, alert only under that price too. A first observation is stored and is not an alert. Do not buy anything. Do not send Nextcloud Talk messages.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After notepad set of last_price:<name> or digest, get that key and confirm the stored value. Never claim success or mark a Kanban card complete unless that follow-up read matches.
EOF
configure_profile_model gpu-watch
ensure_web_search_mcp gpu-watch
rewrite_forage_soul gpu-watch
append_soul_if_missing "${HERMES_HOME}/profiles/gpu-watch/SOUL.md" \
  "After notepad set of last_price" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After notepad set of last_price:<name> or digest, get that key and confirm the stored value. Never claim success or mark a Kanban card complete unless that follow-up read matches."
pin_specialist_cli_tools gpu-watch web_search

ensure_profile selfhosted \
  "Summarizes top posts from r/selfhosted and r/homelab through the web-search MCP." <<'EOF'
You are the self-hosted news profile of Hermes. Use the mcp_web_search_web_search tool to read top posts from r/selfhosted and r/homelab.

Drop posts already covered in this chat. Do not post or vote. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches.
EOF
configure_profile_model selfhosted
ensure_web_search_mcp selfhosted
rewrite_forage_soul selfhosted
append_soul_if_missing "${HERMES_HOME}/profiles/selfhosted/SOUL.md" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result" \
  "Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After storing a cron notepad digest, get the same key and confirm the stored text. Never claim success or mark a Kanban card complete unless that follow-up read matches."
pin_specialist_cli_tools selfhosted web_search

ensure_profile calories \
  "Logs foods in wger and uses the web-search MCP when wger has no matching ingredient." <<'EOF'
You are the calories profile of Hermes. You log food through the wger MCP and use mcp_web_search_web_search when wger has no match.

Search wger ingredients before logging. If nothing matches, use mcp_web_search_web_search to identify the food and its nutrition, say that wger had no match, and do not invent an ingredient id. log_ingredient needs plan_id, ingredient_id, and amount_g. when, meal_id, and weight_unit_id are optional. nutrition_summary reads that day's kcal and macros. A diary row needs a nutrition plan id and an ingredient id from wger.

The 22:00 Europe/Athens report is this profile's scheduled job. It reads nutrition_summary for the Athens day and creates a Nextcloud task due at 22:00. Do not send Talk messages.

Never mark a Kanban card complete unless the wger or Nextcloud MCP write you needed returned success. If the tool fails or is missing, report the error and leave the work incomplete.

On a food-log Kanban card, after kanban_show, the next tool calls must be mcp__wger_* (list_nutrition_plans, then ingredients, then log_ingredient). Do not use memory, builtin web_search, forage, or the shell. Use mcp_web_search_web_search only when wger has no matching ingredient. Do not call kanban_complete until list_log_items or nutrition_summary in this same run shows the new diary row. If those MCP tools error, kanban_block with the error.

Web search is only for identifying food when wger has no ingredient. You still must log via wger (log_ingredient) or explicitly fail; never treat a search snippet as a diary row. After log_ingredient or a Nextcloud task write, re-read with nutrition_summary or a Nextcloud list/get and confirm the diary row or todo exists before claiming success or marking a Kanban card complete.
EOF
configure_profile_model calories
ensure_web_search_mcp calories
rewrite_forage_soul calories
register_wger_mcp calories
hermes -p calories config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":3600,"enabled":true}'
if [ -f "${HERMES_HOME}/profiles/calories/SOUL.md" ]; then
  sed -i \
    's/The 22:00 Europe\/Athens report is a scheduled job on the default profile./The 22:00 Europe\/Athens report is this profile'"'"'s scheduled job./' \
    "${HERMES_HOME}/profiles/calories/SOUL.md"
  if ! grep -q "Never mark a Kanban card complete unless the wger" "${HERMES_HOME}/profiles/calories/SOUL.md"; then
    printf '\nNever mark a Kanban card complete unless the wger or Nextcloud MCP write you needed returned success. If the tool fails or is missing, report the error and leave the work incomplete.\n' >> "${HERMES_HOME}/profiles/calories/SOUL.md"
  fi
  append_soul_if_missing "${HERMES_HOME}/profiles/calories/SOUL.md" \
    "never treat a search snippet as a diary row" \
    "Web search is only for identifying food when wger has no ingredient. You still must log via wger (log_ingredient) or explicitly fail; never treat a search snippet as a diary row. After log_ingredient or a Nextcloud task write, re-read with nutrition_summary or a Nextcloud list/get and confirm the diary row or todo exists before claiming success or marking a Kanban card complete."
  append_soul_if_missing "${HERMES_HOME}/profiles/calories/SOUL.md" \
    "the next tool calls must be mcp__wger_*" \
    "On a food-log Kanban card, after kanban_show, the next tool calls must be mcp__wger_* (list_nutrition_plans, then search_ingredients, then log_ingredient). Do not use memory, builtin web_search, forage, or the shell. Use mcp_web_search_web_search only when wger has no matching ingredient. Do not call kanban_complete until list_log_items or nutrition_summary in this same run shows the new diary row. If those MCP tools error, kanban_block with the error."
  append_soul_if_missing "${HERMES_HOME}/profiles/calories/SOUL.md" \
    "Never invent an ingredient_id" \
    "Never invent an ingredient_id. Call search_ingredients for the food name and use an id from that result. ingredient_id 1 is not rice. After log_ingredient, call list_log_items or nutrition_summary and check the ingredient name before kanban_complete."
fi
# Kanban workers use the CLI platform list. Omit nextcloud here so a food-log
# worker cannot wander into Nextcloud prompts. calories-report still sees
# nextcloud because cron resolves the cron platform (unset → all MCP servers).
pin_specialist_cli_tools calories wger web_search

# Each job is stored on the profile that should run it. hermes cron has no
# timezone flag and the container
# clock is UTC. Each expression is the intended Athens/EEST wall time minus 3
# hours. EEST is a fixed UTC+3 offset, not Europe/Athens DST rules, and these
# expressions are not switched to EET (UTC+2) in winter. Jobs at 01:00-02:30
# EEST run on the previous UTC date. Do not set TZ on this container.

ai_news_prompt=$(cat <<'EOF'
The intended wall time is 01:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 22:00 UTC (`0 22 * * *`). 01:00 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use mcp_web_search_web_search to collect currently hot posts from r/LocalLLaMA. Deduplicate against the previous output injected for this job and against its notepad. Drop posts already reported.

Resolve this job's id with `hermes cron list` by the name ai-news. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include title, link, and one line on why the post matters. If nothing is new, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After setting digest, run `hermes cron notepad <id> get digest` and confirm the stored value matches. If the get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job ai-news ai-news "0 22 * * *" yes "${ai_news_prompt}"
write_cron_prompt ai-news ai-news "${ai_news_prompt}"

hf_models_prompt=$(cat <<'EOF'
The intended wall time is 01:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 22:30 UTC (`30 22 * * *`). 01:30 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use mcp_web_search_web_search to find new Hugging Face text models that either publish a GGUF file or gained more than 100 downloads in the last 24 hours. Skip image, audio, and video models. Do not download weights. Deduplicate against the previous output and the notepad.

Resolve this job's id with `hermes cron list` by the name hf-models. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include model id, link, and whether it qualified by GGUF, by downloads, or by both. If nothing qualifies, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After setting digest, run `hermes cron notepad <id> get digest` and confirm the stored value matches. If the get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job hf-models hf-models "30 22 * * *" yes "${hf_models_prompt}"
write_cron_prompt hf-models hf-models "${hf_models_prompt}"

llamacpp_vulkan_prompt=$(cat <<'EOF'
The intended wall time is 02:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 23:00 UTC (`0 23 * * *`). 02:00 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use mcp_web_search_web_search to read recent commits and pull requests on https://github.com/ggml-org/llama.cpp that mention Vulkan. Deduplicate against the previous output and the notepad. Do not comment on GitHub.

Resolve this job's id with `hermes cron list` by the name llamacpp-vulkan. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include title, link, and the Vulkan-related change in one line. If nothing new mentions Vulkan, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After setting digest, run `hermes cron notepad <id> get digest` and confirm the stored value matches. If the get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job llamacpp-vulkan llamacpp-vulkan "0 23 * * *" yes "${llamacpp_vulkan_prompt}"
write_cron_prompt llamacpp-vulkan llamacpp-vulkan "${llamacpp_vulkan_prompt}"

gpu_watch_prompt=$(cat <<'EOF'
The intended wall time is 02:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 23:30 UTC (`30 23 * * *`). 02:30 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Read /home/hermes/.hermes/gpu-watchlist.yml. It is seeded from the tracked example hermes/gpu-watchlist.example.yml. If products is missing, empty, or every name is blank, set digest to none and respond with exactly [SILENT]. Do not invent product names.

For each product, use mcp_web_search_web_search to find today's lowest in-stock price in EUR on skroutz.gr, public.gr, and plaisio.gr. Also use mcp_web_search_web_search for other Greek shops such as kotsovolos.gr and bestprice.gr. Ignore out-of-stock offers and listings with no shippable price.

Notepad keys, via `hermes cron notepad <id> set <key> '<value>'` after resolving <id> for the job named gpu-watch:
- last_price:<name> is the last observed lowest in-stock EUR price
- digest is the text for the morning publisher, or the single word none

Alert only when today's lowest in-stock price is strictly below the stored last_price for that name. If last_price is absent, store today's price and do not alert. If the entry sets target_price, alert only when today's lowest price is also strictly below that target_price. After a successful price read, update last_price to today's lowest even when you do not alert.

If nothing alerts, set digest to none and respond with exactly [SILENT]. If something alerts, set digest to the product, shop, URL, today's price, the previous price, and target_price when set. Your final response is that same text.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not buy anything.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After each notepad set of last_price:<name> or digest, get that key and confirm the stored value. If a get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job gpu-watch gpu-watch "30 23 * * *" yes "${gpu_watch_prompt}"
write_cron_prompt gpu-watch gpu-watch "${gpu_watch_prompt}"

selfhosted_prompt=$(cat <<'EOF'
The intended wall time is 03:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 00:00 UTC (`0 0 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Use mcp_web_search_web_search to collect top posts from r/selfhosted and r/homelab. Deduplicate against the previous output and the notepad.

Resolve this job's id with `hermes cron list` by the name selfhosted. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include subreddit, title, and link. If nothing is new, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.

Do not claim a search was done unless this run has an mcp_web_search_web_search tool result. After setting digest, run `hermes cron notepad <id> get digest` and confirm the stored value matches. If the get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job selfhosted selfhosted "0 0 * * *" yes "${selfhosted_prompt}"
write_cron_prompt selfhosted selfhosted "${selfhosted_prompt}"

payments_unpaid_prompt=$(cat <<'EOF'
The intended wall time is 03:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 00:30 UTC (`30 0 * * *`). Use the Athens/EEST calendar date of that wall time as today.

The current period is the EEST calendar month that contains that date. The 00:30 EEST Firefly subscription sync is an n8n workflow, not this job. Do not create or edit that workflow.

Using the Nextcloud MCP, list events due on that EEST date on the calendar named Payments. For each event, look for a matching Firefly III transaction in the current period: the same Firefly id when the event carries one, otherwise the same amount and a matching title. Use the n8n MCP only when it already exposes a way to read Firefly transactions. Do not invent transactions or API keys.

An item is unpaid when the event is due today and no matching transaction exists. Resolve this job's id with `hermes cron list` by the name payments-unpaid. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Store the full unpaid list for today (title, amount, due date, Firefly id when present), not a delta from yesterday. If Firefly cannot be queried, set digest to a short blocked notice that names the missing access, and do not guess paid or unpaid. If there is nothing due, or every due event has a matching transaction, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not mark events done and do not create Firefly transactions. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the digest.

Verify each Payments event and Firefly match via MCP reads in this run. Do not invent paid or unpaid. After setting digest, get it back and confirm the stored text. If the get fails or differs, do not treat the run as successful.
EOF
)
ensure_cron_job finance payments-unpaid "30 0 * * *" no "${payments_unpaid_prompt}"
write_cron_prompt finance payments-unpaid "${payments_unpaid_prompt}"

morning_digest_prompt=$(cat <<'EOF'
The intended wall time is 07:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 04:00 UTC (`0 4 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Publish the queued night digests. Those digests live on other profiles' cron notepads, not on this profile. For each one, resolve the job id with `hermes -p <profile> cron list`, then read `hermes -p <profile> cron notepad <id> get digest`.

- ai-news on ai-news: `hermes -p ai-news cron list` and `hermes -p ai-news cron notepad <id> get digest`
- hf-models on hf-models: `hermes -p hf-models cron list` and `hermes -p hf-models cron notepad <id> get digest`
- llamacpp-vulkan on llamacpp-vulkan: `hermes -p llamacpp-vulkan cron list` and `hermes -p llamacpp-vulkan cron notepad <id> get digest`
- gpu-watch on gpu-watch: `hermes -p gpu-watch cron list` and `hermes -p gpu-watch cron notepad <id> get digest`
- selfhosted on selfhosted: `hermes -p selfhosted cron list` and `hermes -p selfhosted cron notepad <id> get digest`
- payments-unpaid on finance: `hermes -p finance cron list` and `hermes -p finance cron notepad <id> get digest`

Skip a job when the digest is missing, empty, none, or published. For each remaining digest, create one Nextcloud task with the Nextcloud MCP calendar todo tools. The task title is the job name. The task body is the digest. The due time is 07:00 Athens (EEST, fixed UTC+3) on the EEST date of this run, not the container UTC clock. Do not send Nextcloud Talk messages. The task is the notification.

After a task is created, re-read with a Nextcloud MCP list or get and confirm that task exists with the expected title and due. Only then set digest to published on that same profile so a later run does not duplicate it: `hermes -p <profile> cron notepad <id> set digest published`. Never set published for a planned or remembered task.

If every digest was skipped, respond with exactly [SILENT]. Otherwise your final response is the list of task titles you created. Never list a title unless that follow-up MCP read showed the task.
EOF
)
ensure_cron_job nextcloud morning-digest "0 4 * * *" no "${morning_digest_prompt}"
write_cron_prompt nextcloud morning-digest "${morning_digest_prompt}"

calories_report_prompt=$(cat <<'EOF'
The intended wall time is 22:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 19:00 UTC (`0 19 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Read the day's nutrition total with the wger MCP tool nutrition_summary: energy in kcal, protein, carbohydrates, fat, and fiber. Pass the EEST date when the tool accepts when. Do not log foods in this job.

Create one Nextcloud task with the Nextcloud MCP calendar todo tools, due at 22:00 Athens (EEST, fixed UTC+3) on that EEST date. Title: Calories. Body: the day's kcal and macros. If nutrition_summary fails or is unauthorized, still create the task, say the diary could not be read, include the error, and do not invent numbers.

Do not send Nextcloud Talk messages. Your final response is the same totals you put in the task, or the error you recorded.

After creating the Nextcloud task, re-read with MCP list/get and confirm it exists with title Calories and the expected due. Do not claim success unless that follow-up read shows the task. Do not invent diary numbers.
EOF
)
ensure_cron_job calories calories-report "0 19 * * *" no "${calories_report_prompt}"
write_cron_prompt calories calories-report "${calories_report_prompt}"

for profile in nextcloud finance ai-news hf-models llamacpp-vulkan gpu-watch selfhosted calories router digest; do
  if [ -f "${HERMES_HOME}/profiles/${profile}/config.yaml" ]; then
    hermes -p "${profile}" config set platforms.api_server.enabled false
    hermes -p "${profile}" config set gateway.enabled false
    hermes -p "${profile}" config set model.context_length 262144
  fi
done

stop_s6_profile_gateways
cleanup_stale_kanban_dispatcher_lock

hermes profile use default
exec hermes gateway run
