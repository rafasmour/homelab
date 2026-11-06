#!/usr/bin/env bash
# Post a Markdown report to Nextcloud Notes through the existing integration:
# inside hermes-api it reuses mcp_call() from cron-to-notes.py (nextcloud-mcp,
# tool nc_notes_create_note). No credentials are handled here.
#
#   scripts/post-note.sh TITLE [--category CAT] [--file FILE]   body from FILE or stdin
#   scripts/post-note.sh --check                                 only search notes (posts nothing)
#   options: --dry-run (show title, category and size, post nothing)
#
# Default category: Reports. Example:
#   scripts/bench.sh summary | scripts/post-note.sh "Benchmark 2026-11-04" --category Benchmarks

set -euo pipefail
die() { echo "post-note: $*" >&2; exit 1; }
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

TITLE="" CAT="Reports" FILE="" CHECK=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --category) CAT="${2:?}"; shift ;; --file) FILE="${2:?}"; shift ;;
    --check) CHECK=1 ;; --dry-run) DRY=1 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$TITLE" ] && TITLE="$1" || die "unexpected argument $1" ;;
  esac
  shift
done

PY='
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("ctn", "/home/hermes/.hermes/scripts/cron-to-notes.py")
ctn = importlib.util.module_from_spec(spec); spec.loader.exec_module(ctn)
if os.environ["NOTE_CHECK"] == "1":
    print("mcp ok:", json.dumps(ctn.mcp_call("nc_notes_search_notes", {"query": "report"}))[:200]); sys.exit(0)
r = ctn.mcp_call("nc_notes_create_note", {"title": os.environ["NOTE_TITLE"], "content": sys.stdin.read(), "category": os.environ["NOTE_CAT"]})
print(json.dumps(r)[:300])
'
run() { docker exec -i -e NOTE_CHECK="$CHECK" -e NOTE_TITLE="$TITLE" -e NOTE_CAT="$CAT" hermes-api python3 -c "$PY"; }

if [ "$CHECK" = 1 ]; then run </dev/null; exit 0; fi
[ -n "$TITLE" ] || { usage; exit 2; }
if [ -n "$FILE" ]; then [ -f "$FILE" ] || die "no such file $FILE"; exec <"$FILE"; fi
[ -n "$FILE" ] || [ ! -t 0 ] || die "give --file or pipe the Markdown on stdin"
if [ "$DRY" = 1 ]; then echo "dry run: note '$TITLE' in category '$CAT', $(wc -c | tr -d ' ') bytes"; exit 0; fi
run
