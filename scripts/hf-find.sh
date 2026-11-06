#!/usr/bin/env bash
# Find quantized GGUFs (and speculative-decoding drafters) on Hugging Face.
#
#   scripts/hf-find.sh search QUERY [AUTHOR]   repos matching QUERY (downloads, date), newest-popular first
#   scripts/hf-find.sh files REPO              GGUF files of a repo with sizes, each tagged:
#                                                SKIP  BF16/F16/FP32/F32 (never downloaded here)
#                                                draft dflash/mtp/eagle/drafter/spec file (Q8_0 is fine for small ones)
#                                                mmproj vision projector
#                                                pick  Q6_K (the preferred quant)
#   scripts/hf-find.sh card REPO [PATTERN]     model card lines matching PATTERN (default: sampling and
#                                              llama-server hints)
#   scripts/hf-find.sh dl REPO FILE DIR        download one file into DIR (refuses BF16/F16/FP32; --dry-run prints)
#   scripts/hf-find.sh drafters QUERY          search the main repos for dflash/mtp files, then repos named
#                                              QUERY + dflash/mtp/drafter
#
# Quantized models only: Q6_K-class is the target, nothing in full precision.
# Models normally live under llama-cpp/models/<family>/<name>/ (see
# llama-cpp/models/downloads.md); add a preset with scripts/add-preset.sh.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "hf-find: $*" >&2; exit 1; }
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }
command -v hf >/dev/null || die "hf CLI not found"

FULL_RE='(^|[^A-Za-z0-9])(BF16|F16|FP16|FP32|F32)([^A-Za-z0-9]|$)'

DRY=0; ARGS=()
for a in "$@"; do
  case "$a" in -h|--help) usage; exit 0 ;; --dry-run) DRY=1 ;; *) ARGS+=("$a") ;; esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
CMD="${1:-}"; [ -n "$CMD" ] || { usage; exit 2; }; shift

search() {  # QUERY [AUTHOR]
  local author=(); [ -z "${2:-}" ] || author=(--author "$2")
  hf models list --search "$1" "${author[@]}" --sort downloads --limit 25 --format json 2>/dev/null |
    python3 -I -c 'import json,sys
for m in json.load(sys.stdin):
    print("%-60s dl=%s %s %s" % (m["id"], m.get("downloads"), str(m.get("created_at"))[:10], m.get("pipeline_tag") or ""))'
}

files() {
  hf models list "$1" -R --human-readable 2>/dev/null | python3 -I -c '
import re, sys
full = re.compile(sys.argv[1], re.I)
draft = re.compile(r"dflash|mtp|eagle|draft|spec|dspark", re.I)
rows = []
for line in sys.stdin:
    m = re.match(r"^\s*(\d[\d.]* [KMGT]?B)?\s+(\w{3} +\d+ +[\d:]+|\w{3} +\d+ +\d{4})\s+(\S.*)$", line.rstrip())
    if m and m.group(3).lower().endswith(".gguf"):
        rows.append((m.group(1) or "?", m.group(3)))
if not rows:
    print("no .gguf files (try the -GGUF repo of this model)"); sys.exit(1)
for size, path in rows:
    tags = []
    if full.search(path): tags.append("SKIP (full precision)")
    if draft.search(path): tags.append("draft")
    if "mmproj" in path.lower(): tags.append("mmproj")
    if re.search(r"Q6_K", path) and not full.search(path): tags.append("pick")
    print("%9s  %-80s %s" % (size, path, " ".join(tags)))
' "$FULL_RE"
}

case "$CMD" in
  search) [ $# -ge 1 ] || die "search needs QUERY"; search "$@" ;;
  files) [ $# -eq 1 ] || die "files needs REPO"; files "$1" ;;
  card)
    [ $# -ge 1 ] || die "card needs REPO"
    hf models card "$1" --text 2>/dev/null |
      grep -iE -B1 -A6 "${2:-temperature|top_k|top_p|min_p|llama-server|--spec|context length}" | head -80 ;;
  dl)
    [ $# -eq 3 ] || die "dl needs REPO FILE DIR"
    if [[ "$2" =~ $FULL_RE ]]; then die "refusing $2: BF16/F16/FP32 are never downloaded (pick a Q6_K file)"; fi
    if [ "$DRY" = 1 ]; then echo "dry run: hf download $1 $2 --local-dir $3"; exit 0; fi
    hf download "$1" "$2" --local-dir "$3" ;;
  drafters)
    [ $# -eq 1 ] || die "drafters needs QUERY"
    for q in "$1" "$1 dflash" "$1 mtp" "$1 drafter"; do
      echo "== $q"; search "$q" | head -8
    done
    echo "(check 'files REPO' of the main GGUF repos too: dflash/mtp files often sit next to the weights)" ;;
  *) die "unknown command $CMD (see --help)" ;;
esac
