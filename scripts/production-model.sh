#!/usr/bin/env bash
# Show or switch Hermes' production llama.cpp model everywhere it is configured.
#
#   scripts/production-model.sh                 interactive selector (numbered list)
#   scripts/production-model.sh status          where the production model is set
#   scripts/production-model.sh switch MODEL    switch without the selector
#   options: --dry-run (print the plan only), --no-restart (edit files and the
#            router, leave the containers), --force (allow fewer than 3 slots)
#
# A switch:
#   1. refuses while a benchmark holds benchmark/reports/.running.lock;
#   2. pauses speech-gateway's warmer (it would reload the old model);
#   3. llama-cpp/models/router-config.ini: moves "load-on-startup = true" and
#      "sleep-idle-seconds = -1" from the old preset to the new one;
#   4. .env files (backed up as .env.bak-<time> first; values are not printed):
#        hermes/.env      HERMES_MODEL, HERMES_CONTEXT_LENGTH (ctx-size / parallel, or
#                         64k with kv-unified-per-slot), HERMES_SESSION_CONTEXT_LENGTH
#                         (kv-unified-per-slot, else the same per-slot size)
#        hindsight/.env   HINDSIGHT_LLM_MODEL
#        benchmark/.env   PRODUCTION_MODEL
#        speech/.env      WARM_LLM
#   5. reloads the router presets, unloads the old model, loads the new one;
#   6. docker compose up -d --no-deps for hermes-api, hindsight, benchmark and
#      speech-gateway, recreating those whose environment changed (Hermes'
#      start.sh rewrites every profile's model and context from the env).
#
# Slot claims (unchanged by a switch, need >= 3 slots): 0 = other Hermes
# profiles, 1 = primed ai-assistant, 2 = Hindsight; slots 3+ are unpinned.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/llama-cpp/models/router-config.ini"
ROUTER="$ROOT/scripts/llama-router.sh"
LOCK="$ROOT/benchmark/reports/.running.lock"
STAMP="$(date +%Y%m%d-%H%M%S)"

DRY=0; RESTART=1; FORCE=0; CMD=""; TARGET=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-restart) RESTART=0 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    status|switch) CMD="$a" ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) TARGET="$a" ;;
  esac
done
[ -n "$CMD" ] || CMD=switch

die() { echo "production-model: $*" >&2; exit 1; }

# env_get FILE KEY -> value (only for model names; secrets are never read)
env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -1 || true; }

# preset_info NAME -> "ctx parallel startup" or empty
preset_info() {
  python3 - "$CONFIG" "$1" <<'PY'
import sys
secs, cur = {}, None
for line in open(sys.argv[1]):
    t = line.split(";", 1)[0].strip()
    if t.startswith("[") and t.endswith("]"):
        cur = t[1:-1]; secs[cur] = {}
    elif cur and "=" in t:
        k, v = t.split("=", 1); secs[cur][k.strip()] = v.strip()
g = secs.get(sys.argv[2])
if g is not None:
    print(int(g.get("ctx-size", 0) or 0), int(g.get("parallel", 1) or 1), int(g.get("kv-unified-per-slot", 0) or 0))
PY
}

current_model() {
  python3 - "$CONFIG" <<'PY'
import sys
cur = None
for line in open(sys.argv[1]):
    t = line.split(";", 1)[0].strip()
    if t.startswith("[") and t.endswith("]"):
        cur = t[1:-1]
    elif cur and t.replace(" ", "") == "load-on-startup=true":
        print(cur); break
PY
}

show_status() {
  printf '%-34s %s\n' "router-config.ini (load-on-startup)" "$(current_model)"
  printf '%-34s %s\n' "hermes/.env HERMES_MODEL" "$(env_get "$ROOT/hermes/.env" HERMES_MODEL)"
  printf '%-34s %s\n' "hermes/.env HERMES_CONTEXT_LENGTH" "$(env_get "$ROOT/hermes/.env" HERMES_CONTEXT_LENGTH)"
  printf '%-34s %s\n' "hermes/.env HERMES_SESSION_CONTEXT" "$(env_get "$ROOT/hermes/.env" HERMES_SESSION_CONTEXT_LENGTH)"
  printf '%-34s %s\n' "hindsight/.env HINDSIGHT_LLM_MODEL" "$(env_get "$ROOT/hindsight/.env" HINDSIGHT_LLM_MODEL)"
  printf '%-34s %s\n' "benchmark/.env PRODUCTION_MODEL" "$(env_get "$ROOT/benchmark/.env" PRODUCTION_MODEL)"
  printf '%-34s %s\n' "speech/.env WARM_LLM" "$(env_get "$ROOT/speech/.env" WARM_LLM)"
  printf '%-34s %s\n' "router loaded now" "$("$ROUTER" loaded 2>/dev/null | paste -sd, - || echo '?')"
}

if [ "$CMD" = status ]; then show_status; exit 0; fi

OLD="$(current_model)"
if [ -z "$TARGET" ]; then
  echo "Current production model: ${OLD:-none}"
  mapfile -t NAMES < <("$ROUTER" presets | awk '{ print $1 }')
  i=1
  while read -r line; do printf '%3d) %s\n' "$i" "$line"; i=$((i + 1)); done < <("$ROUTER" presets)
  read -r -p "Select the new production model [1-${#NAMES[@]}]: " n
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#NAMES[@]}" ] || die "invalid choice"
  TARGET="${NAMES[$((n - 1))]}"
fi

info="$(preset_info "$TARGET")"
[ -n "$info" ] || die "no preset [$TARGET] in $CONFIG"
read -r CTX PAR PER_SLOT_CAP <<<"$info"
# Unified pool with a per-slot cap: sessions plan for the cap, every other
# profile for at most 64k. Otherwise each slot is ctx-size / parallel.
if [ "$PER_SLOT_CAP" -gt 0 ]; then
  PER_SLOT=$(( PER_SLOT_CAP < 65536 ? PER_SLOT_CAP : 65536 )); SESSION_CTX=$PER_SLOT_CAP
else
  PER_SLOT=$((CTX / PAR)); SESSION_CTX=$PER_SLOT
fi
[ "$PAR" -ge 3 ] || [ "$FORCE" = 1 ] || die "[$TARGET] has $PAR slot(s); slots 0-2 are claimed (others, ai-assistant, Hindsight). Raise parallel or pass --force."
[ "$PER_SLOT" -ge 32768 ] || die "[$TARGET] has only $PER_SLOT tokens per slot (Hermes' first call is ~35-38k)"
[ ! -e "$LOCK" ] || die "a benchmark is running ($LOCK); try again when it finishes"

echo "Switch production model: ${OLD:-none} -> $TARGET ($PAR slots; sessions $SESSION_CTX, others $PER_SLOT tokens)"
if [ "$DRY" = 1 ]; then
  echo "dry run: would edit router-config.ini, hermes/hindsight/benchmark/speech .env, reload the router and"
  [ "$RESTART" = 1 ] && echo "         run docker compose up -d in hermes, hindsight, benchmark, speech"
  exit 0
fi
[ "$OLD" != "$TARGET" ] || echo "(already the production preset; re-applying env and restarts)"

# 2. pause the warmer for the duration of the switch
docker exec speech-gateway touch /tmp/warmer.pause 2>/dev/null || true
trap 'docker exec speech-gateway rm -f /tmp/warmer.pause 2>/dev/null || true' EXIT

# 3. router-config.ini: move the always-loaded flags
cp -p "$CONFIG" "$CONFIG.bak-$STAMP-production"
python3 - "$CONFIG" "$TARGET" <<'PY'
import sys
path, target = sys.argv[1], sys.argv[2]
flags = ("load-on-startup", "sleep-idle-seconds = -1")
out, cur = [], None
for line in open(path).read().split("\n"):
    t = line.split(";", 1)[0].strip()
    if t.startswith("[") and t.endswith("]"):
        cur = t[1:-1]
    norm = t.replace(" ", "")
    if norm == "load-on-startup=true" or norm == "sleep-idle-seconds=-1":
        continue  # drop from every preset, re-added below
    out.append(line)
    if cur == target and t == f"[{target}]":
        out += ["load-on-startup = true", "sleep-idle-seconds = -1"]
open(path, "w").write("\n".join(out))
PY
echo "router-config.ini: [$TARGET] is now loaded on startup and never sleeps (backup .bak-$STAMP-production)"

# 4. .env files
set_env() {  # FILE KEY VALUE
  local f="$1" k="$2" v="$3"
  [ -f "$f" ] || { echo "  skip $f (missing)"; return; }
  [ -e "$f.bak-$STAMP" ] || cp -p "$f" "$f.bak-$STAMP"
  if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >>"$f"; fi
  echo "  ${f#"$ROOT"/} $k=$v"
}
set_env "$ROOT/hermes/.env" HERMES_MODEL "$TARGET"
set_env "$ROOT/hermes/.env" HERMES_CONTEXT_LENGTH "$PER_SLOT"
set_env "$ROOT/hermes/.env" HERMES_SESSION_CONTEXT_LENGTH "$SESSION_CTX"
set_env "$ROOT/hindsight/.env" HINDSIGHT_LLM_MODEL "$TARGET"
set_env "$ROOT/benchmark/.env" PRODUCTION_MODEL "$TARGET"
set_env "$ROOT/speech/.env" WARM_LLM "$TARGET"

# 5. router
"$ROUTER" reload
if [ -n "$OLD" ] && [ "$OLD" != "$TARGET" ]; then "$ROUTER" unload "$OLD"; sleep 3; fi
"$ROUTER" load "$TARGET"
"$ROUTER" vram || true

# 6. containers
if [ "$RESTART" = 1 ]; then
  # Only the services that read these variables; --no-deps leaves the rest alone.
  for pair in hermes:api hindsight:hindsight benchmark:benchmark speech:speech-gateway; do
    stack="${pair%%:*}"; svc="${pair#*:}"
    echo "== $stack: docker compose up -d --no-deps $svc"
    (cd "$ROOT/$stack" && docker compose up -d --no-deps "$svc" 2>&1 | grep -E "Recreat|Start|Running|Error" || true)
  done
else
  echo "--no-restart: run docker compose up -d in hermes, hindsight, benchmark and speech to apply the env"
fi
echo; show_status
