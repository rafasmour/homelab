#!/bin/sh
# Creates or updates the Nextcloud CalDAV credential used by the "Firefly
# subscriptions to Nextcloud Payments" workflow and imports the workflow from
# n8n/workflows/firefly-subscriptions-to-nextcloud.json (inactive by default).
#
# The Firefly III credential ("Hermes digest – Firefly III token") is created by
# hermes-digests-setup.sh; run that script (--credentials-only is enough) first.
#
# The CalDAV credential uses NEXTCLOUD_MCP_USERNAME and
# NEXTCLOUD_MCP_APP_PASSWORD from nextcloud/.env. Secrets are never printed;
# the credential JSON exists only in a mode-600 temporary file and inside the
# container for the duration of the import.
#
# Usage (from the repository root): sh n8n/scripts/firefly-subscriptions-setup.sh
#   --credentials-only   only create/update the CalDAV credential
#   --publish            also publish (activate) the workflow and restart n8n
#                        so the 00:30 schedule is registered
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONTAINER=${N8N_CONTAINER:-n8n}
WORKFLOW="$ROOT/n8n/workflows/firefly-subscriptions-to-nextcloud.json"
CREDENTIALS_ONLY=0
PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --credentials-only) CREDENTIALS_ONLY=1 ;;
    --publish) PUBLISH=1 ;;
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

NEXTCLOUD_CALDAV_USER=$(env_value "$ROOT/nextcloud/.env" NEXTCLOUD_MCP_USERNAME)
NEXTCLOUD_CALDAV_PASSWORD=$(env_value "$ROOT/nextcloud/.env" NEXTCLOUD_MCP_APP_PASSWORD)
require "nextcloud/.env NEXTCLOUD_MCP_USERNAME" "$NEXTCLOUD_CALDAV_USER"
require "nextcloud/.env NEXTCLOUD_MCP_APP_PASSWORD" "$NEXTCLOUD_CALDAV_PASSWORD"

# The calendar URL in the workflow names the user; it must be the credential's.
CALENDAR_URL=$(jq -r '.nodes[] | select(.name == "Payments calendar") | .parameters.jsCode' "$WORKFLOW" \
  | sed -n 's|.*"\(http://nextcloud/remote.php/dav/calendars/[^"]*\)".*|\1|p')
case "$CALENDAR_URL" in
  "http://nextcloud/remote.php/dav/calendars/$NEXTCLOUD_CALDAV_USER/"*) ;;
  *)
    echo "calendar URL '$CALENDAR_URL' in the workflow is not owned by NEXTCLOUD_MCP_USERNAME" >&2
    exit 1
    ;;
esac
export NEXTCLOUD_CALDAV_USER NEXTCLOUD_CALDAV_PASSWORD

umask 077
TMP=$(mktemp)
trap 'rm -f "$TMP"; docker exec "$CONTAINER" rm -f /tmp/firefly-subscriptions-credentials.json /tmp/firefly-subscriptions-to-nextcloud.json >/dev/null 2>&1 || true' EXIT

# Fixed id: the workflow file references this id and name.
python3 - "$TMP" <<'PY'
import json
import os
import sys

creds = [{
    "id": "ncCalDavBasic001",
    "name": "Nextcloud CalDAV – Payments",
    "type": "httpBasicAuth",
    "data": {"user": os.environ["NEXTCLOUD_CALDAV_USER"], "password": os.environ["NEXTCLOUD_CALDAV_PASSWORD"]},
}]
with open(sys.argv[1], "w") as handle:
    json.dump(creds, handle)
PY

docker cp "$TMP" "$CONTAINER:/tmp/firefly-subscriptions-credentials.json" >/dev/null
docker exec "$CONTAINER" n8n import:credentials --input=/tmp/firefly-subscriptions-credentials.json 2>&1 \
  | grep -iE 'success|import|error' | grep -v 'Error tracking' || true
echo "credential imported"
[ "$CREDENTIALS_ONLY" = 1 ] && exit 0

id=$(jq -r '.id' "$WORKFLOW")
docker cp "$WORKFLOW" "$CONTAINER:/tmp/firefly-subscriptions-to-nextcloud.json" >/dev/null
docker exec "$CONTAINER" n8n import:workflow --input=/tmp/firefly-subscriptions-to-nextcloud.json 2>&1 \
  | grep -iE 'success|import|error' | grep -v 'Error tracking' || true

if [ "$PUBLISH" = 1 ]; then
  docker exec "$CONTAINER" n8n publish:workflow --id="$id" 2>&1 | grep -iE 'publish|error' | grep -v 'Error tracking' || true
  docker restart "$CONTAINER" >/dev/null
  echo "n8n restarted"
fi
