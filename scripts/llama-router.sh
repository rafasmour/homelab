#!/usr/bin/env bash
# Talk to the llama.cpp router (container llama-server) without publishing its
# port: every request runs curl inside the container with its own API key, so
# the key is never printed or passed on the command line of the host.
#
#   scripts/llama-router.sh status            loaded/unloaded state of every preset
#   scripts/llama-router.sh reload            re-read models/router-config.ini
#   scripts/llama-router.sh load MODEL        load a preset (waits until loaded)
#   scripts/llama-router.sh unload MODEL      unload a preset
#   scripts/llama-router.sh loaded            print the loaded preset(s), one per line
#   scripts/llama-router.sh presets           preset names with ctx-size / parallel
#   scripts/llama-router.sh vram              GPU VRAM in use (amdgpu sysfs)
#
# Environment: LLAMA_CONTAINER (default llama-server),
#              ROUTER_CONFIG (default llama-cpp/models/router-config.ini).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C="${LLAMA_CONTAINER:-llama-server}"
CONFIG="${ROUTER_CONFIG:-$ROOT/llama-cpp/models/router-config.ini}"

die() { echo "llama-router: $*" >&2; exit 1; }

# api METHOD PATH [JSON] [TIMEOUT] -> response body on stdout
api() {
  local method="$1" path="$2" body="${3:-}" timeout="${4:-30}"
  docker exec -i "$C" sh -c '
    m="$1"; p="$2"; b="$3"; t="$4"
    if [ -n "$b" ]; then
      curl -sS -m "$t" -X "$m" -H "Authorization: Bearer $LLAMA_API_KEY" -H "Content-Type: application/json" -d "$b" "http://127.0.0.1:8080$p"
    else
      curl -sS -m "$t" -X "$m" -H "Authorization: Bearer $LLAMA_API_KEY" "http://127.0.0.1:8080$p"
    fi' sh "$method" "$path" "$body" "$timeout"
}

STATUS_PY='
import json, sys
d = json.load(sys.stdin)
for m in d.get("data") or d.get("models") or []:
    s = m.get("status")
    s = s.get("value") if isinstance(s, dict) else s
    print("%s\t%s" % (m.get("id") or m.get("name"), s or "?"))
'

PRESETS_PY='
import sys
secs, cur = {}, None
for line in open(sys.argv[1]):
    t = line.split(";", 1)[0].strip()
    if t.startswith("[") and t.endswith("]"):
        cur = t[1:-1]; secs[cur] = {}
    elif cur and "=" in t:
        k, v = t.split("=", 1); secs[cur][k.strip()] = v.strip()
for s, g in secs.items():
    if s == "*":
        continue
    ctx = int(g.get("ctx-size", "0") or 0); par = int(g.get("parallel", "1") or 1)
    extra = []
    if g.get("model-draft"): extra.append(g.get("spec-type", "draft"))
    if g.get("load-on-startup", "").lower() == "true": extra.append("PRODUCTION")
    print("%s\tctx %d\tparallel %d\tper-slot %d\t%s" % (s, ctx, par, ctx // max(par, 1), " ".join(extra)))
'

status_lines() { api GET /models | python3 -c "$STATUS_PY"; }
state_of() { status_lines | awk -F'\t' -v m="$1" '$1 == m { print $2 }'; }

cmd="${1:-status}"; shift || true
case "$cmd" in
  status) status_lines | column -t -s $'\t' ;;
  loaded) status_lines | awk -F'\t' '$2 == "loaded" || $2 == "loading" { print $1 }' ;;
  presets) python3 -c "$PRESETS_PY" "$CONFIG" | column -t -s $'\t' ;;
  reload)
    api GET '/models?reload=1' >/dev/null && echo "router presets reloaded" ;;
  load)
    m="${1:?usage: load MODEL}"
    [ -n "$(state_of "$m")" ] || die "unknown preset: $m (run reload after editing router-config.ini)"
    api POST /models/load "{\"model\":\"$m\"}" 60 >/dev/null || true
    for i in $(seq 1 180); do
      s="$(state_of "$m")"
      [ "$s" = loaded ] && { echo "$m loaded"; exit 0; }
      case "$s" in failed|error|unloaded) [ "$i" -gt 5 ] && die "$m did not load (state $s); see: docker logs --tail 50 $C" ;; esac
      sleep 2
    done
    die "$m still not loaded after 6 minutes" ;;
  unload)
    m="${1:?usage: unload MODEL}"
    api POST /models/unload "{\"model\":\"$m\"}" 60 >/dev/null || true
    echo "$m unload requested (state now: $(state_of "$m"))" ;;
  vram)
    # amdgpu sysfs (works with any ROCm version; ROCm 10 dropped rocm-smi).
    for d in /sys/class/drm/card*/device; do
      [ -r "$d/mem_info_vram_used" ] || continue
      awk -v u="$(cat "$d/mem_info_vram_used")" -v t="$(cat "$d/mem_info_vram_total")" \
        'BEGIN { printf "VRAM %.2f / %.2f GiB\n", u / 2^30, t / 2^30 }'
    done ;;
  -h|--help|help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $cmd (see --help)" ;;
esac
