#!/bin/sh
# Creates or updates the n8n credentials used by the "Hermes digest – *"
# workflows, imports the workflows from n8n/workflows/hermes-digest-*.json,
# publishes them and restarts n8n so the schedules are registered.
#
# Secrets are read from the other stacks' ignored .env files and never
# printed. The credential JSON exists only in a mode-600 temporary file and
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

TALK_DELIVER_SECRET=$(env_value "$ROOT/hermes-nextcloud-bridge/.env" TALK_DELIVER_SECRET)
NEXTCLOUD_TALK_PROFILE_ROOMS=$(env_value "$ROOT/hermes-nextcloud-bridge/.env" NEXTCLOUD_TALK_PROFILE_ROOMS)
LLAMA_API_KEY=$(env_value "$ROOT/llama-cpp/.env" LLAMA_API_KEY)
FIREFLY_III_ACCESS_TOKEN=$(env_value "$ROOT/firefly-iii/.env" FIREFLY_III_ACCESS_TOKEN)
MCP_STATIC_TOKEN=$(env_value "$ROOT/wger/.env" MCP_STATIC_TOKEN)
require "hermes-nextcloud-bridge/.env TALK_DELIVER_SECRET" "$TALK_DELIVER_SECRET"
require "hermes-nextcloud-bridge/.env NEXTCLOUD_TALK_PROFILE_ROOMS" "$NEXTCLOUD_TALK_PROFILE_ROOMS"
require "llama-cpp/.env LLAMA_API_KEY" "$LLAMA_API_KEY"
require "firefly-iii/.env FIREFLY_III_ACCESS_TOKEN" "$FIREFLY_III_ACCESS_TOKEN"
require "wger/.env MCP_STATIC_TOKEN" "$MCP_STATIC_TOKEN"
export TALK_DELIVER_SECRET NEXTCLOUD_TALK_PROFILE_ROOMS LLAMA_API_KEY FIREFLY_III_ACCESS_TOKEN \
  MCP_STATIC_TOKEN

umask 077
TMP=$(mktemp)
trap 'rm -f "$TMP"; docker exec "$CONTAINER" rm -f /tmp/hermes-digest-credentials.json >/dev/null 2>&1 || true' EXIT

# Fixed ids: the workflow files reference these ids and names.
python3 - "$TMP" <<'PY'
import json
import os
import sys

env = os.environ
rooms = {}
for entry in env["NEXTCLOUD_TALK_PROFILE_ROOMS"].split("|"):
    profile, sep, token = entry.partition("=")
    if sep and profile.strip() and token.strip():
        rooms[profile.strip()] = token.strip()

room_ids = {
    "ai-news": "hdTalkAiNews0001",
    "hf-models": "hdTalkHfModels01",
    "llamacpp-vulkan": "hdTalkVulkan0001",
    "llamacpp-rocm": "hdTalkRocm000001",
    "gpu-watch": "hdTalkGpuWatch01",
    "selfhosted": "hdTalkSelfhost01",
    "finance": "hdTalkFinance001",
    "nextcloud": "hdTalkNextcloud1",
    "calories": "hdTalkCalories01",
}
missing = sorted(set(room_ids) - set(rooms))
if missing:
    sys.exit(f"NEXTCLOUD_TALK_PROFILE_ROOMS has no room for: {', '.join(missing)}")


def bearer(value):
    return {"name": "Authorization", "value": f"Bearer {value}"}


creds = [
    {"id": "hdLlamaApiKey001", "name": "Hermes digest – llama.cpp API key", "type": "httpHeaderAuth",
     "data": bearer(env["LLAMA_API_KEY"])},
    {"id": "hdFireflyToken01", "name": "Hermes digest – Firefly III token", "type": "httpHeaderAuth",
     "data": bearer(env["FIREFLY_III_ACCESS_TOKEN"])},
    {"id": "hdWgerMcpToken01", "name": "Hermes digest – wger MCP token", "type": "httpHeaderAuth",
     "data": bearer(env["MCP_STATIC_TOKEN"])},
    # For n8n's AI nodes (OpenAI Chat Model, AI Agent, ...): the local llama.cpp
    # router through its OpenAI-compatible API. Pick any router model by name.
    {"id": "llamaCppOpenAi01", "name": "llama.cpp (local, OpenAI-compatible)", "type": "openAiApi",
     "data": {"apiKey": env["LLAMA_API_KEY"], "url": "http://llama-server:8080/v1", "header": False}},
]
# Custom Auth adds the bearer header and merges room_token into the JSON body.
for profile, cid in room_ids.items():
    creds.append({
        "id": cid,
        "name": f"Hermes digest – Talk room {profile}",
        "type": "httpCustomAuth",
        "data": {"json": json.dumps({
            "headers": {"Authorization": f"Bearer {env['TALK_DELIVER_SECRET']}"},
            "body": {"room_token": rooms[profile]},
        })},
    })
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
