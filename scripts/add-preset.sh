#!/usr/bin/env bash
# Append a llama.cpp router preset for a downloaded GGUF to
# llama-cpp/models/router-config.ini and (optionally) reload the router.
#
#   scripts/add-preset.sh NAME --model FILE [options]
#
#   --model FILE        GGUF path: /models/<family>/<name>/<file>.gguf (container path) or the
#                       same file as llama-cpp/models/... on the host; must exist
#   --draft FILE        drafter GGUF (dflash / mtp / draft model); needs --spec-type
#   --spec-type TYPE    draft-dflash | draft-mtp | draft | ngram-mod  (draft-dflash and draft
#                       also write spec-draft-n-max 4 and spec-draft-ngl all)
#   --ctx-per-slot N    tokens per slot (default 65536)
#   --parallel N        slots (default 2); ctx-size = N x slots, kv-unified = false
#   --kv TYPE           KV cache type for K and V: f16 (default), q8_0, q4_0
#   --n-cpu-moe N       MoE experts of the first N layers stay in RAM (also sets fit = off)
#   --reasoning on|off  default on
#   --temp X --top-p X --top-k N --min-p X --presence-penalty X   vendor sampling (only written when given)
#   --note TEXT         comment line(s) above the preset (source, quant, size, date)
#   --reload            run scripts/llama-router.sh reload afterwards
#   --dry-run           print the block, change nothing
#
# Refuses an existing name, a missing model file and BF16/F16/FP32 files. Saves
# router-config.ini.bak-<time> before appending. Check the VRAM after the first
# load (scripts/llama-router.sh vram): the budget is about 16 GiB per preset.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/llama-cpp/models/router-config.ini"
die() { echo "add-preset: $*" >&2; exit 1; }
usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

NAME="" MODEL="" DRAFT="" SPEC="" CTX=65536 PAR=2 KV=f16 CPUMOE="" REASON=on NOTE="" RELOAD=0 DRY=0
TEMP="" TOPP="" TOPK="" MINP="" PRES=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --model) MODEL="${2:?}"; shift ;; --draft) DRAFT="${2:?}"; shift ;; --spec-type) SPEC="${2:?}"; shift ;;
    --ctx-per-slot) CTX="${2:?}"; shift ;; --parallel) PAR="${2:?}"; shift ;; --kv) KV="${2:?}"; shift ;;
    --n-cpu-moe) CPUMOE="${2:?}"; shift ;; --reasoning) REASON="${2:?}"; shift ;; --note) NOTE="${2:?}"; shift ;;
    --temp) TEMP="${2:?}"; shift ;; --top-p) TOPP="${2:?}"; shift ;; --top-k) TOPK="${2:?}"; shift ;;
    --min-p) MINP="${2:?}"; shift ;; --presence-penalty) PRES="${2:?}"; shift ;;
    --reload) RELOAD=1 ;; --dry-run) DRY=1 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$NAME" ] && NAME="$1" || die "unexpected argument $1" ;;
  esac
  shift
done
[ -n "$NAME" ] && [ -n "$MODEL" ] || { usage; exit 2; }
[[ "$NAME" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "NAME must be lowercase letters, digits, . _ -"
[[ "$CTX" =~ ^[0-9]+$ && "$PAR" =~ ^[0-9]+$ ]] || die "--ctx-per-slot and --parallel must be numbers"
[ -z "$DRAFT" ] || [ -n "$SPEC" ] || die "--draft needs --spec-type"

to_container() { case "$1" in /models/*) echo "$1" ;; *llama-cpp/models/*) echo "/models/${1#*llama-cpp/models/}" ;; *) die "$1 is not under llama-cpp/models" ;; esac; }
to_host() { echo "$ROOT/llama-cpp/models/${1#/models/}"; }
MODEL="$(to_container "$MODEL")"; [ -z "$DRAFT" ] || DRAFT="$(to_container "$DRAFT")"
for f in "$MODEL" $DRAFT; do
  [[ "$(basename "$f")" =~ (^|[^A-Za-z0-9])(BF16|F16|FP16|FP32|F32)([^A-Za-z0-9]|\.gguf$) ]] && die "$f is full precision; use a Q6_K-class file"
  [ -f "$(to_host "$f")" ] || die "missing file $(to_host "$f") (download it first: scripts/hf-find.sh dl)"
done
grep -qE "^\[$NAME\][[:space:]]*$" "$CONFIG" && die "preset [$NAME] already exists in router-config.ini"

BLOCK="[$NAME]"$'\n'
[ -z "$NOTE" ] || BLOCK+="$(printf '%s\n' "$NOTE" | sed 's/^/; /')"$'\n'
BLOCK+="model = $MODEL"$'\n'
[ -z "$DRAFT" ] || BLOCK+="model-draft = $DRAFT"$'\n'
BLOCK+="; plan: $KV KV, $((CTX / 1024))k per slot x $PAR slot(s)"$'\n'
BLOCK+="ctx-size = $((CTX * PAR))"$'\n'"parallel = $PAR"$'\n'"kv-unified = false"$'\n'
BLOCK+="cache-type-k = $KV"$'\n'"cache-type-v = $KV"$'\n'
if [ -n "$CPUMOE" ]; then BLOCK+="fit = off"$'\n'"n-cpu-moe = $CPUMOE"$'\n'; fi
if [ -n "$SPEC" ]; then
  BLOCK+="spec-type = $SPEC"$'\n'
  case "$SPEC" in draft-dflash|draft) BLOCK+="spec-draft-n-max = 4"$'\n'"spec-draft-ngl = all"$'\n' ;; esac
fi
BLOCK+="reasoning = $REASON"$'\n'
[ -z "$TEMP" ] || BLOCK+="temp = $TEMP"$'\n'
[ -z "$TOPP" ] || BLOCK+="top-p = $TOPP"$'\n'
[ -z "$TOPK" ] || BLOCK+="top-k = $TOPK"$'\n'
[ -z "$MINP" ] || BLOCK+="min-p = $MINP"$'\n'
[ -z "$PRES" ] || BLOCK+="presence-penalty = $PRES"$'\n'

echo "--- appended to ${CONFIG#"$ROOT"/} ---"; printf '%s' "$BLOCK"
if [ "$DRY" = 1 ]; then echo "--- dry run: nothing changed ---"; exit 0; fi
cp -p "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
[ -z "$(tail -c1 "$CONFIG")" ] || echo >>"$CONFIG"
printf '\n%s' "$BLOCK" >>"$CONFIG"
echo "added [$NAME]. router-config.ini.example is not updated; mirror the preset there only if it should ship."
if [ "$RELOAD" = 1 ]; then "$ROOT/scripts/llama-router.sh" reload; else echo "reload with: scripts/llama-router.sh reload"; fi
