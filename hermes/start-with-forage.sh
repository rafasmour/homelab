#!/bin/sh
set -eu

plugin_dir="${HERMES_HOME}/plugins/web/forage"

if [ ! -f "${plugin_dir}/plugin.yaml" ]; then
  checkout_dir=$(mktemp -d)
  trap 'rm -rf "${checkout_dir}"' EXIT

  git init "${checkout_dir}/forage"
  git -C "${checkout_dir}/forage" remote add origin \
    https://github.com/aldemaroc/forage.git
  git -C "${checkout_dir}/forage" fetch --depth 1 origin \
    "${FORAGE_PLUGIN_REF:-main}"
  git -C "${checkout_dir}/forage" checkout --detach FETCH_HEAD

  mkdir -p "${HERMES_HOME}/plugins/web"
  cp -R "${checkout_dir}/forage/plugins/web/forage" "${plugin_dir}"
fi

hermes plugins enable web/forage
hermes config set web.search_backend forage
hermes config set web.extract_backend forage
hermes config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":180,"enabled":true}'
hermes config set mcp_servers.n8n \
  "{\"url\":\"http://n8n-mcp:3000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${N8N_MCP_AUTH_TOKEN}\"},\"connect_timeout\":60,\"timeout\":180,\"enabled\":true}"
hermes config set mcp_servers.drawio \
  '{"url":"http://drawio-mcp:8000/mcp","connect_timeout":60,"timeout":180,"enabled":true}'

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

nextcloud_profile="${HERMES_HOME}/profiles/nextcloud"
if [ ! -f "${nextcloud_profile}/config.yaml" ]; then
  hermes profile create nextcloud --no-skills --no-alias \
    --description "Manages files, shares, notes, calendars, contacts, collectives, news, mail, and Talk on the private Nextcloud through its MCP server."
  cat > "${nextcloud_profile}/SOUL.md" <<'EOF'
You are the Nextcloud profile of Hermes. You manage this homelab's private Nextcloud through the nextcloud MCP tools.

Use those tools for files, shares, notes, calendars and tasks, contacts, collectives, news, mail, and Talk. Look up paths and identifiers before changing them. Do not delete, send, or reshare content unless the user explicitly asks. Say what you changed when a write succeeds.

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
hermes -p nextcloud config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":180,"enabled":true}'

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

cron_job_exists() {
  python - "$1" <<'PY'
import json
import os
import sys
from pathlib import Path

name = sys.argv[1]
path = Path(os.environ["HERMES_HOME"]) / "cron" / "jobs.json"
if not path.is_file():
    sys.exit(1)
data = json.loads(path.read_text())
jobs = data.get("jobs") or []
sys.exit(
    0
    if any(isinstance(job, dict) and job.get("name") == name for job in jobs)
    else 1
)
PY
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
}

ensure_forage_link() {
  profile=$1
  link="${HERMES_HOME}/profiles/${profile}/plugins/web/forage"
  if [ -e "${link}" ] || [ -L "${link}" ]; then
    return 0
  fi
  mkdir -p "${HERMES_HOME}/profiles/${profile}/plugins/web"
  ln -s "${HERMES_HOME}/plugins/web/forage" "${link}"
  hermes -p "${profile}" plugins enable web/forage
  hermes -p "${profile}" config set web.search_backend forage
  hermes -p "${profile}" config set web.extract_backend forage
}

register_wger_mcp() {
  profile=$1
  if mcp_server_exists "${profile}" wger; then
    return 0
  fi
  : "${MCP_STATIC_TOKEN:?Set MCP_STATIC_TOKEN to register the wger MCP server}"
  payload="{\"url\":\"http://wger-mcp:8765/mcp\",\"headers\":{\"Authorization\":\"Bearer ${MCP_STATIC_TOKEN}\"},\"connect_timeout\":60,\"timeout\":180,\"enabled\":true}"
  if [ "${profile}" = "-" ]; then
    hermes config set mcp_servers.wger "${payload}"
  else
    hermes -p "${profile}" config set mcp_servers.wger "${payload}"
  fi
}

ensure_cron_job() {
  name=$1
  schedule=$2
  continuity=$3
  prompt=$4
  if cron_job_exists "${name}"; then
    return 0
  fi
  if [ "${continuity}" = "yes" ]; then
    hermes cron create --name "${name}" --deliver local --continuity \
      "${schedule}" "${prompt}"
  else
    hermes cron create --name "${name}" --deliver local \
      "${schedule}" "${prompt}"
  fi
}

gpu_watchlist="${HERMES_HOME}/gpu-watchlist.yml"
gpu_watchlist_example="${HERMES_GPU_WATCHLIST_EXAMPLE:-/usr/local/share/hermes/gpu-watchlist.example.yml}"
if [ ! -f "${gpu_watchlist}" ]; then
  cp "${gpu_watchlist_example}" "${gpu_watchlist}"
fi

register_wger_mcp -

ensure_profile finance \
  "Checks Firefly subscriptions on the Nextcloud Payments calendar and records which events due today have no matching Firefly transaction." <<'EOF'
You are the finance profile of Hermes. You use the Nextcloud and n8n MCP servers.

Firefly III subscriptions are placed on the Nextcloud calendar named Payments by an n8n workflow. That sync is not yours. Do not create or edit the n8n workflow.

When asked about payments, list events due today on the Payments calendar. Today and the current period use the Europe/Athens calendar. An item is unpaid when it is due today and no Firefly transaction in the current Athens month matches its Firefly id, or otherwise its amount and title. Say when Firefly cannot be queried. Do not guess that an item is paid or unpaid. Do not create Nextcloud tasks or send Talk messages unless the user explicitly asks. Do not delete events or create Firefly transactions unless the user explicitly asks.
EOF
configure_profile_model finance
if ! mcp_server_exists finance nextcloud; then
  hermes -p finance config set mcp_servers.nextcloud \
    '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":180,"enabled":true}'
fi
if ! mcp_server_exists finance n8n; then
  hermes -p finance config set mcp_servers.n8n \
    "{\"url\":\"http://n8n-mcp:3000/mcp\",\"headers\":{\"Authorization\":\"Bearer ${N8N_MCP_AUTH_TOKEN}\"},\"connect_timeout\":60,\"timeout\":180,\"enabled\":true}"
fi

ensure_profile ai-news \
  "Reads hot r/LocalLLaMA posts through Forage and drops items already reported." <<'EOF'
You are the AI news profile of Hermes. Use Forage search and extract, the SearXNG-backed backend, to read hot posts from r/LocalLLaMA.

Drop posts already covered in this chat. Summarize title, link, and why the post matters. Do not post, vote, or send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.
EOF
configure_profile_model ai-news
ensure_forage_link ai-news

ensure_profile hf-models \
  "Finds new Hugging Face text models that have a GGUF or more than 100 downloads in 24 hours." <<'EOF'
You are the Hugging Face models profile of Hermes. Use Forage search and extract to find new text models that have a GGUF file or more than 100 downloads in the last 24 hours.

Skip image, audio, and video models. Drop models already covered in this chat. Do not download weights. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.
EOF
configure_profile_model hf-models
ensure_forage_link hf-models

ensure_profile llamacpp-vulkan \
  "Watches ggml-org/llama.cpp commits and pull requests that mention Vulkan." <<'EOF'
You are the llama.cpp Vulkan profile of Hermes. Use Forage search and extract to read commits and pull requests on ggml-org/llama.cpp that mention Vulkan.

Include the title, link, and the Vulkan-related change. Drop items already covered in this chat. Do not comment on GitHub. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.
EOF
configure_profile_model llamacpp-vulkan
ensure_forage_link llamacpp-vulkan

ensure_profile gpu-watch \
  "Compares in-stock Greek shop prices for GPUs on the watchlist and stays silent until product names are added." <<'EOF'
You are the GPU watch profile of Hermes. Use Forage search and extract for in-stock EUR prices on skroutz.gr, public.gr, and plaisio.gr, and Forage/SearXNG for other Greek shops such as kotsovolos.gr and bestprice.gr.

Read /home/hermes/.hermes/gpu-watchlist.yml. If products is empty, stay silent and do not invent product names. Alert only when today's lowest in-stock price is below the last price you stored for that GPU. When a product has target_price, alert only under that price too. A first observation is stored and is not an alert. Do not buy anything. Do not send Nextcloud Talk messages.
EOF
configure_profile_model gpu-watch
ensure_forage_link gpu-watch

ensure_profile selfhosted \
  "Summarizes top posts from r/selfhosted and r/homelab through Forage." <<'EOF'
You are the self-hosted news profile of Hermes. Use Forage search and extract to read top posts from r/selfhosted and r/homelab.

Drop posts already covered in this chat. Do not post or vote. Do not send Nextcloud Talk messages. The nightly job stores its digest in a cron notepad; a later morning job publishes Nextcloud tasks.
EOF
configure_profile_model selfhosted
ensure_forage_link selfhosted

ensure_profile calories \
  "Logs foods in wger and uses Forage when wger has no matching ingredient." <<'EOF'
You are the calories profile of Hermes. You log food through the wger MCP and use Forage when wger has no match.

Search wger ingredients before logging. If nothing matches, use Forage to identify the food and its nutrition, say that wger had no match, and do not invent an ingredient id. log_ingredient needs plan_id, ingredient_id, and amount_g. when, meal_id, and weight_unit_id are optional. nutrition_summary reads that day's kcal and macros. A diary row needs a nutrition plan id and an ingredient id from wger.

The 22:00 Europe/Athens report is a scheduled job on the default profile. It reads nutrition_summary for the Athens day and creates a Nextcloud task due at 22:00. Do not send Talk messages.
EOF
configure_profile_model calories
ensure_forage_link calories
register_wger_mcp calories

# Default-profile cron only. hermes cron has no timezone flag and the container
# clock is UTC. Each expression is the intended Athens/EEST wall time minus 3
# hours. EEST is a fixed UTC+3 offset, not Europe/Athens DST rules, and these
# expressions are not switched to EET (UTC+2) in winter. Jobs at 01:00-02:30
# EEST run on the previous UTC date. Do not set TZ on this container.

ai_news_prompt=$(cat <<'EOF'
The intended wall time is 01:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 22:00 UTC (`0 22 * * *`). 01:00 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use Forage web search and extract to collect currently hot posts from r/LocalLLaMA. Deduplicate against the previous output injected for this job and against its notepad. Drop posts already reported.

Resolve this job's id with `hermes cron list` by the name ai-news. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include title, link, and one line on why the post matters. If nothing is new, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.
EOF
)
ensure_cron_job ai-news "0 22 * * *" yes "${ai_news_prompt}"

hf_models_prompt=$(cat <<'EOF'
The intended wall time is 01:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 22:30 UTC (`30 22 * * *`). 01:30 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use Forage web search and extract to find new Hugging Face text models that either publish a GGUF file or gained more than 100 downloads in the last 24 hours. Skip image, audio, and video models. Do not download weights. Deduplicate against the previous output and the notepad.

Resolve this job's id with `hermes cron list` by the name hf-models. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include model id, link, and whether it qualified by GGUF, by downloads, or by both. If nothing qualifies, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.
EOF
)
ensure_cron_job hf-models "30 22 * * *" yes "${hf_models_prompt}"

llamacpp_vulkan_prompt=$(cat <<'EOF'
The intended wall time is 02:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 23:00 UTC (`0 23 * * *`). 02:00 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Use Forage web search and extract to read recent commits and pull requests on https://github.com/ggml-org/llama.cpp that mention Vulkan. Deduplicate against the previous output and the notepad. Do not comment on GitHub.

Resolve this job's id with `hermes cron list` by the name llamacpp-vulkan. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include title, link, and the Vulkan-related change in one line. If nothing new mentions Vulkan, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.
EOF
)
ensure_cron_job llamacpp-vulkan "0 23 * * *" yes "${llamacpp_vulkan_prompt}"

gpu_watch_prompt=$(cat <<'EOF'
The intended wall time is 02:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 23:30 UTC (`30 23 * * *`). 02:30 EEST falls on the previous UTC date. Use the Athens/EEST calendar date of that wall time as today.

Read /home/hermes/.hermes/gpu-watchlist.yml. It is seeded from the tracked example hermes/gpu-watchlist.example.yml. If products is missing, empty, or every name is blank, set digest to none and respond with exactly [SILENT]. Do not invent product names.

For each product, use Forage search and extract to find today's lowest in-stock price in EUR on skroutz.gr, public.gr, and plaisio.gr. Also use Forage, backed by SearXNG, for other Greek shops such as kotsovolos.gr and bestprice.gr. Ignore out-of-stock offers and listings with no shippable price.

Notepad keys, via `hermes cron notepad <id> set <key> '<value>'` after resolving <id> for the job named gpu-watch:
- last_price:<name> is the last observed lowest in-stock EUR price
- digest is the text for the morning publisher, or the single word none

Alert only when today's lowest in-stock price is strictly below the stored last_price for that name. If last_price is absent, store today's price and do not alert. If the entry sets target_price, alert only when today's lowest price is also strictly below that target_price. After a successful price read, update last_price to today's lowest even when you do not alert.

If nothing alerts, set digest to none and respond with exactly [SILENT]. If something alerts, set digest to the product, shop, URL, today's price, the previous price, and target_price when set. Your final response is that same text.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not buy anything.
EOF
)
ensure_cron_job gpu-watch "30 23 * * *" yes "${gpu_watch_prompt}"

selfhosted_prompt=$(cat <<'EOF'
The intended wall time is 03:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 00:00 UTC (`0 0 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Use Forage web search and extract to collect top posts from r/selfhosted and r/homelab. Deduplicate against the previous output and the notepad.

Resolve this job's id with `hermes cron list` by the name selfhosted. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Include subreddit, title, and link. If nothing is new, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not deliver the result yourself. Delivery for this job is local. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the same digest text.
EOF
)
ensure_cron_job selfhosted "0 0 * * *" yes "${selfhosted_prompt}"

payments_unpaid_prompt=$(cat <<'EOF'
The intended wall time is 03:30 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 00:30 UTC (`30 0 * * *`). Use the Athens/EEST calendar date of that wall time as today.

The current period is the EEST calendar month that contains that date. The 00:30 EEST Firefly subscription sync is an n8n workflow, not this job. Do not create or edit that workflow.

Using the Nextcloud MCP, list events due on that EEST date on the calendar named Payments. For each event, look for a matching Firefly III transaction in the current period: the same Firefly id when the event carries one, otherwise the same amount and a matching title. Use the n8n MCP only when it already exposes a way to read Firefly transactions. Do not invent transactions or API keys.

An item is unpaid when the event is due today and no matching transaction exists. Resolve this job's id with `hermes cron list` by the name payments-unpaid. Store the text with `hermes cron notepad <id> set digest '<text>'` as one quoted argument. Keep it under 12 KB. Replace digest on every run. Store the full unpaid list for today (title, amount, due date, Firefly id when present), not a delta from yesterday. If Firefly cannot be queried, set digest to a short blocked notice that names the missing access, and do not guess paid or unpaid. If there is nothing due, or every due event has a matching transaction, set digest to the single word none.

Do not create Nextcloud tasks. Do not send Nextcloud Talk messages. Do not mark events done and do not create Firefly transactions. If digest is none, respond with exactly [SILENT]. Otherwise your final response is the digest.
EOF
)
ensure_cron_job payments-unpaid "30 0 * * *" no "${payments_unpaid_prompt}"

morning_digest_prompt=$(cat <<'EOF'
The intended wall time is 07:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 04:00 UTC (`0 4 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Publish the queued night digests. Read the cron notepads of these default-profile jobs: ai-news, hf-models, llamacpp-vulkan, gpu-watch, selfhosted, and payments-unpaid. Resolve each id with `hermes cron list`, then run `hermes cron notepad <id> get digest`.

Skip a job when the digest is missing, empty, none, or published. For each remaining digest, create one Nextcloud task with the Nextcloud MCP calendar todo tools. The task title is the job name. The task body is the digest. The due time is 07:00 Athens (EEST, fixed UTC+3) on the EEST date of this run, not the container UTC clock. Do not send Nextcloud Talk messages. The task is the notification.

After a task is created, set that job's digest to published so a later run does not duplicate it: `hermes cron notepad <id> set digest published`.

If every digest was skipped, respond with exactly [SILENT]. Otherwise your final response is the list of task titles you created.
EOF
)
ensure_cron_job morning-digest "0 4 * * *" no "${morning_digest_prompt}"

calories_report_prompt=$(cat <<'EOF'
The intended wall time is 22:00 Athens (EEST). The schedule is UTC with a fixed EEST offset of +3, not a zoneinfo Europe/Athens DST calendar. hermes cron has no timezone flag and the container clock is UTC, so this job is stored as 19:00 UTC (`0 19 * * *`). Use the Athens/EEST calendar date of that wall time as today.

Read the day's nutrition total with the wger MCP tool nutrition_summary: energy in kcal, protein, carbohydrates, fat, and fiber. Pass the EEST date when the tool accepts when. Do not log foods in this job.

Create one Nextcloud task with the Nextcloud MCP calendar todo tools, due at 22:00 Athens (EEST, fixed UTC+3) on that EEST date. Title: Calories. Body: the day's kcal and macros. If nutrition_summary fails or is unauthorized, still create the task, say the diary could not be read, include the error, and do not invent numbers.

Do not send Nextcloud Talk messages. Your final response is the same totals you put in the task, or the error you recorded.
EOF
)
ensure_cron_job calories-report "0 19 * * *" no "${calories_report_prompt}"

exec hermes gateway run
