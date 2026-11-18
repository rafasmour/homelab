#!/bin/sh
# Creates or updates the n8n credentials used by the "Hermes digest – *"
# workflows, imports the workflows from n8n/workflows/hermes-digest-*.json,
# publishes them and restarts n8n so the schedules are registered.
#
# Secrets are read from the other stacks' ignored .env files and never
# printed. The digests' LLM model is Hermes' production model, HERMES_MODEL
# in hermes/.env (scripts/production-model.sh keeps it current and re-runs
# this script with --credentials-only after a switch). The credential JSON exists only in a mode-600 temporary file and
# inside the container for the duration of the import.
#
# Usage (from the repository root): sh n8n/scripts/hermes-digests-setup.sh
#   --credentials-only   only create/update the credentials
#   --no-publish         import the workflows inactive
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTAINER=${N8N_CONTAINER:-n8n}
CREDENTIALS_ONLY=0
PUBLISH=1
for arg in "$@"; do
  case "$arg" in
    --credentials-only) CREDENTIALS_ONLY=1 ;;
    --no-publish) PUBLISH=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

env_value() {
  # env_value <file> <NAME>: last NAME=value line, surrounding quotes removed.
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

require() {
  if [ -z "$2" ] || [ "$2" = "CHANGE_ME" ]; then
    echo "missing $1" >&2
    exit 1
  fi
}

LLAMA_API_KEY=$(env_value "$ROOT/llama-cpp/.env" LLAMA_API_KEY)
MCP_STATIC_TOKEN=$(env_value "$ROOT/wger/.env" MCP_STATIC_TOKEN)
PRODUCTION_MODEL=$(env_value "$ROOT/hermes/.env" HERMES_MODEL)
# llama.cpp slot of every non-ai-assistant profile: id_slot in hermes/profiles/default/config.yaml
HERMES_SLOT_OTHERS=$(sed -n 's/^ *id_slot: *//p' "$ROOT/hermes/profiles/default/config.yaml" | head -n 1)
require "llama-cpp/.env LLAMA_API_KEY" "$LLAMA_API_KEY"
require "wger/.env MCP_STATIC_TOKEN" "$MCP_STATIC_TOKEN"
require "hermes/.env HERMES_MODEL" "$PRODUCTION_MODEL"
export LLAMA_API_KEY MCP_STATIC_TOKEN PRODUCTION_MODEL HERMES_SLOT_OTHERS
echo "digest LLM model: $PRODUCTION_MODEL (hermes/.env HERMES_MODEL)"

umask 077
TMP=$(mktemp)
trap 'rm -f "$TMP"; docker exec "$CONTAINER" rm -f /tmp/hermes-digest-credentials.json >/dev/null 2>&1 || true' EXIT

# Fixed ids: the workflow files reference these ids and names.
python3 - "$TMP" <<'PY'
import json
import os
import sys

env = os.environ
# The digests share the slot of the other Hermes profiles (id_slot in
# hermes/profiles/default/config.yaml, default 2; 0 = primed ai-assistant, 1 = Hindsight), so
# they never evict the assistant's warm prompt. For a range ("2-4") the first
# slot is used; -1 sends no id_slot.
slot_others = (env.get("HERMES_SLOT_OTHERS") or "2").strip()
llm_body = {"model": env["PRODUCTION_MODEL"]}
if slot_others != "-1" and slot_others.split("-")[0].isdigit():
    llm_body["id_slot"] = int(slot_others.split("-")[0])


def bearer(value):
    return {"name": "Authorization", "value": f"Bearer {value}"}


creds = [
    {"id": "hdLlamaApiKey001", "name": "Hermes digest – llama.cpp API key", "type": "httpHeaderAuth",
     "data": bearer(env["LLAMA_API_KEY"])},
    # The digests' "LLM request" nodes: bearer header plus "model" and "id_slot"
    # merged into the JSON body (credential values win over the node's body).
    {"id": "hdLlamaProdMdl01", "name": "Hermes digest – llama.cpp production model", "type": "httpCustomAuth",
     "data": {"json": json.dumps({
         "headers": {"Authorization": f"Bearer {env['LLAMA_API_KEY']}"},
         "body": llm_body,
     })}},
    {"id": "hdWgerMcpToken01", "name": "Hermes digest – wger MCP token", "type": "httpHeaderAuth",
     "data": bearer(env["MCP_STATIC_TOKEN"])},
    # For n8n's AI nodes (OpenAI Chat Model, AI Agent, ...): the local llama.cpp
    # router through its OpenAI-compatible API. Pick any router model by name.
    {"id": "llamaCppOpenAi01", "name": "llama.cpp (local, OpenAI-compatible)", "type": "openAiApi",
     "data": {"apiKey": env["LLAMA_API_KEY"], "url": "http://llama-server:8080/v1", "header": False}},
]
with open(sys.argv[1], "w") as handle:
    json.dump(creds, handle)
PY

docker cp "$TMP" "$CONTAINER:/tmp/hermes-digest-credentials.json" >/dev/null
docker exec "$CONTAINER" n8n import:credentials --input=/tmp/hermes-digest-credentials.json 2>&1 \
  | grep -iE 'success|import|error' | grep -v 'Error tracking' || true
echo "credentials imported"
[ "$CREDENTIALS_ONLY" = 1 ] && exit 0

docker exec "$CONTAINER" rm -rf /tmp/hermes-digest-workflows
docker exec "$CONTAINER" mkdir -p /tmp/hermes-digest-workflows
for file in "$ROOT"/n8n/workflows/hermes-digest-*.json; do
  docker cp "$file" "$CONTAINER:/tmp/hermes-digest-workflows/" >/dev/null
done
docker exec "$CONTAINER" n8n import:workflow --separate --input=/tmp/hermes-digest-workflows 2>&1 \
  | grep -iE 'success|import|error' | grep -v 'Error tracking' || true
docker exec "$CONTAINER" rm -rf /tmp/hermes-digest-workflows

if [ "$PUBLISH" = 1 ]; then
  for file in "$ROOT"/n8n/workflows/hermes-digest-*.json; do
    id=$(basename "$file" .json)
    docker exec "$CONTAINER" n8n publish:workflow --id="$id" 2>&1 | grep -iE 'publish|error' | grep -v 'Error tracking' || true
  done
fi
docker restart "$CONTAINER" >/dev/null
echo "n8n restarted"
