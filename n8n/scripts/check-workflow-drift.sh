#!/usr/bin/env bash
# Detects n8n workflows that were changed outside git.
#
# Reads every live workflow through the n8n public REST API (GET
# /api/v1/workflows, header X-N8N-API-KEY) with a key that only has the
# workflow:list and workflow:read scopes. The API returns the saved draft
# (top-level nodes, connections, settings) and, for active workflows, the
# published version that runs (activeVersion: nodes and connections only; the
# API does not expose the published settings, so the draft settings are used
# for both). Each is normalised with jq and compared with n8n/workflows/*.json.
# Also counts live workflows that have no file in git and checks that the
# Hermes digests are active, as hermes-digests-setup.sh leaves them.
#
# Compared (behaviour): workflow name, nodes (name, type, typeVersion,
# parameters, credential ids, disabled/retry/error settings, webhookId, ...),
# connections and settings. Ignored (cosmetic or runtime): node positions, node
# ids, notes, sticky notes, pinData, staticData, tags, timestamps and version ids.
#
# With N8N_DRIFT_AUTO_EXPORT=1 (the runner sets it) a workflow whose saved
# draft differs from its file is exported over that file: name, nodes,
# connections and settings come from n8n, the file's other keys (id, active,
# pinData) and its key order stay. The working tree changes; nothing is
# committed. The run still reports the workflow (n8n_workflow_drift 1 plus
# n8n_workflow_exported 1), so Grafana posts once to Talk and the change gets
# reviewed before it is committed. A published version that differs while the
# draft matches cannot be exported (the API has no published settings) and stays
# plain drift; missing and untracked workflows are never written.
#
# Writes Prometheus textfile metrics to node-exporter/textfile/n8n_drift.prom.
# The API never returns decrypted secrets, only credential ids and names, and
# nothing from it is printed except with --diff.
#
# Configuration (environment):
#   N8N_DRIFT_API_KEY   required, n8n API key (read-only scopes)
#   N8N_API_URL         default http://n8n:5678
#   N8N_WORKFLOWS_DIR   default <repo>/n8n/workflows
#   N8N_TEXTFILE_DIR    default <repo>/node-exporter/textfile
#   N8N_DRIFT_AUTO_EXPORT  1 = export drifted drafts over their files (default 0)
#
# Usage: normally run by the n8n-drift-runner container when Grafana's
# "n8n drift check not running" alert fires. By hand:
#   docker exec n8n-drift-runner /app/check-workflow-drift.sh            summary + metrics
#   docker exec n8n-drift-runner /app/check-workflow-drift.sh --diff ID  normalised diff git -> live
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
API_URL=${N8N_API_URL:-http://n8n:5678}
WORKFLOWS=${N8N_WORKFLOWS_DIR:-$ROOT/n8n/workflows}
TEXTFILE_DIR=${N8N_TEXTFILE_DIR:-$ROOT/node-exporter/textfile}
AUTO_EXPORT=${N8N_DRIFT_AUTO_EXPORT:-0}
PROM="$TEXTFILE_DIR/n8n_drift.prom"

DIFF_ID=""
case "${1:-}" in
  "") ;;
  --diff)
    DIFF_ID=${2:-}
    if [ -z "$DIFF_ID" ]; then
      echo "usage: $0 [--diff WORKFLOW_ID]" >&2
      exit 2
    fi
    ;;
  *) echo "usage: $0 [--diff WORKFLOW_ID]" >&2; exit 2 ;;
esac

# Behaviour-defining part of a workflow, with stable ordering.
NORM='def norm:
  {name,
   nodes: ([.nodes[]? | select(.type != "n8n-nodes-base.stickyNote")
            | del(.position, .id, .notes, .notesInFlow, .color)
            | if .credentials then .credentials |= with_entries(.value |= {id: .id}) else . end]
           | sort_by(.name)),
   connections: (.connections // {}),
   settings: (.settings // {})};'

HOST_TMP=$(mktemp -d)
NEW_PROM=""
cleanup() {
  rm -rf "$HOST_TMP"
  [ -z "$NEW_PROM" ] || rm -f "$NEW_PROM"
}
trap cleanup EXIT

# api_get <path>: GET from the n8n API; the key goes through curl's stdin config,
# never through the process arguments.
api_get() {
  printf 'header = "X-N8N-API-KEY: %s"\n' "$N8N_DRIFT_API_KEY" |
    curl -fsS --max-time 30 -K - "$API_URL$1"
}

# fetch_live: writes $HOST_TMP/draft.json and $HOST_TMP/published.json (JSON
# arrays). draft.json is the API list as is; published.json carries the active
# version's nodes and connections for active workflows only.
fetch_live() {
  [ -n "${N8N_DRIFT_API_KEY:-}" ] || return 1
  local cursor="" page pages=0
  : >"$HOST_TMP/pages"
  while :; do
    page=$(api_get "/api/v1/workflows?limit=250&excludePinnedData=true${cursor:+&cursor=$(jq -rn --arg c "$cursor" '$c|@uri')}") || return 1
    printf '%s' "$page" | jq -e '.data | type == "array"' >/dev/null 2>&1 || return 1
    printf '%s' "$page" | jq -c '.data[]' >>"$HOST_TMP/pages" || return 1
    cursor=$(printf '%s' "$page" | jq -r '.nextCursor // empty')
    pages=$((pages + 1))
    [ -n "$cursor" ] || break
    [ "$pages" -lt 40 ] || return 1
  done
  jq -s '.' "$HOST_TMP/pages" >"$HOST_TMP/draft.json" || return 1
  jq 'map(select(.activeVersion != null)
          | .nodes = .activeVersion.nodes
          | .connections = .activeVersion.connections
          | del(.activeVersion))' "$HOST_TMP/draft.json" >"$HOST_TMP/published.json"
}

EXPORT_OK=1
fetch_live || EXPORT_OK=0

# normalised <file> [id]: the file itself (git) or the entry with that id in an export.
normalised() {
  if [ $# -eq 1 ]; then
    jq -S "$NORM norm" "$1"
  else
    jq -S --arg id "$2" "$NORM .[] | select(.id == \$id) | norm" "$1"
  fi
}

if [ -n "$DIFF_ID" ]; then
  [ "$EXPORT_OK" = 1 ] || { echo "reading workflows from the n8n API at $API_URL failed" >&2; exit 1; }
  file=""
  for f in "$WORKFLOWS"/*.json; do
    if [ "$(jq -r '.id' "$f")" = "$DIFF_ID" ] || [ "$(basename "$f" .json)" = "$DIFF_ID" ]; then
      file=$f
      DIFF_ID=$(jq -r '.id' "$f")
      break
    fi
  done
  [ -n "$file" ] || { echo "no workflow file with id $DIFF_ID in n8n/workflows" >&2; exit 2; }
  normalised "$file" >"$HOST_TMP/git.norm"
  status=0
  for kind in draft published; do
    normalised "$HOST_TMP/$kind.json" "$DIFF_ID" >"$HOST_TMP/$kind.norm"
    [ -s "$HOST_TMP/$kind.norm" ] || { echo "== $kind: not present live"; continue; }
    if [ "$kind" = published ] && cmp -s "$HOST_TMP/draft.norm" "$HOST_TMP/published.norm"; then
      continue
    fi
    if ! diff -u --label "git:n8n/workflows/$(basename "$file")" --label "live:$kind" \
      "$HOST_TMP/git.norm" "$HOST_TMP/$kind.norm"; then
      status=1
    fi
  done
  [ "$status" = 0 ] && echo "$DIFF_ID: no difference"
  exit "$status"
fi

# export_draft <file> <id>: replace <file> with the live draft of <id>, keeping
# the file's key set and order (id, active and pinData stay as in git).
export_draft() {
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.export.XXXXXX") || return 1
  if jq --arg id "$2" --slurpfile live "$HOST_TMP/draft.json" '
      ($live[0][] | select(.id == $id)) as $w
      | . as $f
      | reduce ($f | keys_unsorted[]) as $k ({};
          .[$k] = (if ($k | IN("name", "nodes", "connections", "settings")) then $w[$k] else $f[$k] end))' \
      "$1" >"$tmp"; then
    chmod 644 "$tmp" && mv -f "$tmp" "$1" && return 0
  fi
  rm -f "$tmp"
  return 1
}

prom_escape() {
  local v=${1//\\/\\\\}
  v=${v//\"/\\\"}
  printf '%s' "${v//$'\n'/\\n}"
}

METRICS="$HOST_TMP/metrics"
{
  echo "# HELP n8n_workflow_drift_check_success 1 if the live workflows could be exported and compared."
  echo "# TYPE n8n_workflow_drift_check_success gauge"
  echo "n8n_workflow_drift_check_success $EXPORT_OK"
  echo "# HELP n8n_workflow_drift_check_timestamp_seconds Unix time of the last drift check."
  echo "# TYPE n8n_workflow_drift_check_timestamp_seconds gauge"
  echo "n8n_workflow_drift_check_timestamp_seconds $(date +%s)"
} >"$METRICS"

if [ "$EXPORT_OK" = 1 ]; then
  drift_lines="" active_lines="" untracked_lines="" exported_lines=""
  drifted=() inactive=() tracked_ids=() exported=()
  total=0
  for f in "$WORKFLOWS"/*.json; do
    id=$(jq -r '.id' "$f")
    tracked_ids+=("$id")
    total=$((total + 1))
    normalised "$f" >"$HOST_TMP/git.norm"
    normalised "$HOST_TMP/draft.json" "$id" >"$HOST_TMP/draft.norm"
    normalised "$HOST_TMP/published.json" "$id" >"$HOST_TMP/published.norm"
    live_active=$(jq -r --arg id "$id" '[.[] | select(.id == $id) | (.activeVersionId != null) or (.activeVersion != null)][0] // false' \
      "$HOST_TMP/draft.json")
    reason=""
    if [ ! -s "$HOST_TMP/draft.norm" ]; then
      reason="missing live"
    else
      cmp -s "$HOST_TMP/git.norm" "$HOST_TMP/draft.norm" || reason="draft differs"
      if [ "$live_active" = true ] && [ -s "$HOST_TMP/published.norm" ] &&
        ! cmp -s "$HOST_TMP/git.norm" "$HOST_TMP/published.norm"; then
        reason="${reason:+$reason, }published differs"
      fi
    fi
    drift=0
    [ -n "$reason" ] && { drift=1; drifted+=("$id ($reason)"); }
    case "$reason" in
      *"draft differs"*)
        if [ "$AUTO_EXPORT" = 1 ]; then
          if export_draft "$f" "$id"; then
            exported+=("$id -> $(basename "$f")")
            exported_lines+="n8n_workflow_exported{workflow=\"$(prom_escape "$id")\"} 1"$'\n'
          else
            echo "export of $id to $(basename "$f") failed" >&2
          fi
        fi
        ;;
    esac
    drift_lines+="n8n_workflow_drift{workflow=\"$(prom_escape "$id")\"} $drift"$'\n'
    # hermes-digests-setup.sh publishes every Hermes digest; the other
    # workflows are activated by hand, so their expected state is unknown.
    case "$(basename "$f")" in
      hermes-digest-*.json)
        mismatch=0
        [ -s "$HOST_TMP/draft.norm" ] && [ "$live_active" != true ] && { mismatch=1; inactive+=("$id"); }
        active_lines+="n8n_workflow_active_mismatch{workflow=\"$(prom_escape "$id")\"} $mismatch"$'\n'
        ;;
    esac
  done

  untracked_names=()
  while IFS=$'\t' read -r uid uname; do
    [ -n "$uid" ] || continue
    untracked_names+=("$uname ($uid)")
    untracked_lines+="n8n_workflow_untracked_info{workflow=\"$(prom_escape "$uid")\",name=\"$(prom_escape "$uname")\"} 1"$'\n'
  done < <(jq -r --argjson tracked "$(printf '%s\n' "${tracked_ids[@]}" | jq -R . | jq -s .)" \
      '.[] | select((.isArchived // false) | not) | select(.id as $id | $tracked | index($id) | not)
      | [.id, (.name | gsub("[\t\n]"; " "))] | @tsv' "$HOST_TMP/draft.json")

  {
    echo "# HELP n8n_workflow_drift 1 if the live workflow (draft or published) differs from n8n/workflows/<file>.json or is missing."
    echo "# TYPE n8n_workflow_drift gauge"
    printf '%s' "$drift_lines"
    echo "# HELP n8n_workflow_exported 1 if this run exported the workflow's live draft over its file (N8N_DRIFT_AUTO_EXPORT=1)."
    echo "# TYPE n8n_workflow_exported gauge"
    printf '%s' "$exported_lines"
    echo "# HELP n8n_workflow_active_mismatch 1 if a Hermes digest is not active although hermes-digests-setup.sh publishes it."
    echo "# TYPE n8n_workflow_active_mismatch gauge"
    printf '%s' "$active_lines"
    echo "# HELP n8n_workflow_untracked Number of live, non-archived workflows without a file in n8n/workflows."
    echo "# TYPE n8n_workflow_untracked gauge"
    echo "n8n_workflow_untracked ${#untracked_names[@]}"
    echo "# HELP n8n_workflow_untracked_info One series per live workflow without a file in n8n/workflows."
    echo "# TYPE n8n_workflow_untracked_info gauge"
    printf '%s' "$untracked_lines"
  } >>"$METRICS"
fi

mkdir -p "$TEXTFILE_DIR"
NEW_PROM=$(mktemp "$TEXTFILE_DIR/.n8n_drift.prom.XXXXXX")
cat "$METRICS" >"$NEW_PROM"
chmod 644 "$NEW_PROM"
mv -f "$NEW_PROM" "$PROM"

if [ "$EXPORT_OK" = 0 ]; then
  echo "n8n drift check FAILED: could not read workflows from the n8n API at $API_URL" >&2
  exit 1
fi
echo "n8n workflows: $total tracked, ${#drifted[@]} drifted, ${#exported[@]} exported, ${#untracked_names[@]} untracked, ${#inactive[@]} digests inactive"
for line in "${drifted[@]}"; do echo "  drift:     $line"; done
for line in "${exported[@]}"; do echo "  exported:  $line"; done
for line in "${untracked_names[@]}"; do echo "  untracked: $line"; done
for line in "${inactive[@]}"; do echo "  inactive:  $line"; done
if [ ${#drifted[@]} -gt 0 ]; then
  echo "Inspect with: n8n/scripts/check-workflow-drift.sh --diff <id>"
fi
