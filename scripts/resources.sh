#!/usr/bin/env bash
# One-shot health picture of the host: the checks done by hand before and after
# loading models or recreating stacks. Read-only.
#
#   scripts/resources.sh              VRAM, RAM/swap, router state, top containers by memory,
#                                     stopped/restarting containers, benchmark lock and leftovers
#   scripts/resources.sh --short      VRAM, RAM/swap and loaded models only
#
# VRAM is read from /sys/class/drm/card*/device/mem_info_vram_* (the card with
# the largest total). The preset budget is about 16 GiB used, >= 2.4 GiB free.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
SHORT=0; [ "${1:-}" = --short ] && SHORT=1

best=""; bt=0
for d in /sys/class/drm/card*/device; do
  [ -r "$d/mem_info_vram_total" ] || continue
  t=$(cat "$d/mem_info_vram_total"); [ "$t" -gt "$bt" ] && { bt=$t; best=$d; }
done
if [ -n "$best" ]; then
  u=$(cat "$best/mem_info_vram_used")
  awk -v u="$u" -v t="$bt" 'BEGIN { printf "VRAM   %.2f / %.2f GiB used, %.2f GiB free\n", u/2^30, t/2^30, (t-u)/2^30 }'
else echo "VRAM   no readable /sys/class/drm card"; fi
free -m | awk '/^Mem:/ { printf "RAM    %d / %d MiB used, %d MiB available\n", $3, $2, $7 } /^Swap:/ { printf "Swap   %d / %d MiB used\n", $3, $2 }'
printf 'Router loaded: %s\n' "$("$ROOT/scripts/llama-router.sh" loaded 2>/dev/null | paste -sd, - || true)"
[ "$SHORT" = 0 ] || exit 0

echo; echo "Top containers by memory:"
docker stats --no-stream --format '{{.MemUsage}}\t{{.Name}}' | sort -t/ -k1 -h -r | head -8 | awk -F'\t' '{ printf "  %-22s %s\n", $1, $2 }'
echo; echo "Containers not running (exited, created, restarting, dead):"
docker ps -a --filter status=exited --filter status=created --filter status=restarting --filter status=dead --format '  {{.Names}}\t{{.Status}}\t{{.Image}}' || true
echo; echo "Benchmark:"
[ -e "$ROOT/benchmark/reports/.running.lock" ] && echo "  lock present (benchmark/reports/.running.lock)" || echo "  no lock"
docker exec benchmark sh -c 'ps -eo pid,etime,args | grep -E "[c]hrome|[s]andbox|[m]ain.js" | cut -c1-120' 2>/dev/null | sed 's/^/  proc: /' || true
docker ps --filter name=sandbox --filter name=hermes-run --format '  leftover? {{.Names}} {{.Status}}' 2>/dev/null || true
