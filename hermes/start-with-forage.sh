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
EOF
fi

hermes -p nextcloud config set model.provider custom
hermes -p nextcloud config set model.base_url "${inference_base_url}"
hermes -p nextcloud config set model.api_mode chat_completions
hermes -p nextcloud config set model.default "${model_name}"
hermes -p nextcloud config set mcp_servers.nextcloud \
  '{"url":"http://nextcloud-mcp:8000/mcp","connect_timeout":60,"timeout":180,"enabled":true}'

exec hermes gateway run
