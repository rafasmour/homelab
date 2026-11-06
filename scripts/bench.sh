#!/usr/bin/env bash
# Run the benchmark container's suites the way they are always run by hand:
# warmer paused, no concurrent run, output logged to benchmark/reports/.
#
#   scripts/bench.sh llm MODEL [MODEL ...]   Hermes suite (--only hermes --with-optin)
#   scripts/bench.sh stt [MODEL ...]         speech-to-text (--only stt)
#   scripts/bench.sh tts [MODEL ...]         text-to-speech (--only tts)
#   scripts/bench.sh all --llm-models a,b    stt, then llm, then tts, one after the other
#   scripts/bench.sh summary [RUN]           scores of a run (default: the latest) from the DB
#   scripts/bench.sh status                  lock file, running benchmark process, newest logs
#   options: --bg (detach, print the log path), --dry-run (print the commands only),
#            --no-optin (llm: leave the ai-assistant group out)
#
# Each run: refuses while benchmark/reports/.running.lock exists, touches
# /tmp/warmer.pause in speech-gateway (removed again on exit, also on error),
# logs to benchmark/reports/<kind>-<timestamp>.log, prints the summary at the
# end. Loading models is done by the benchmark itself through the router; for
# the production model use scripts/production-model.sh afterwards.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTS="$ROOT/benchmark/reports"
LOCK="$REPORTS/.running.lock"
BENCH="${BENCH_CONTAINER:-benchmark}"
STAMP="$(date +%Y%m%d-%H%M%S)"

die() { echo "bench: $*" >&2; exit 1; }
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

BG=0 DRY=0 OPTIN=1 FG=0 LLM_MODELS="" KIND="" ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --bg) BG=1 ;;
    --fg) FG=1 ;;                      # internal: the detached child
    --dry-run) DRY=1 ;;
    --no-optin) OPTIN=0 ;;
    --llm-models) shift; LLM_MODELS="${1:-}" ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) if [ -z "$KIND" ]; then KIND="$1"; else ARGS+=("$1"); fi ;;
  esac
  shift
done
[ -n "$KIND" ] || { usage; exit 2; }

summary() {
  docker exec -i benchmark-ui node - "${1:-}" <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/benchmark.db', { readOnly: true });
const arg = process.argv[2];
const run = arg ? db.prepare('SELECT id,name,status FROM runs WHERE name=?').get(arg)
                : db.prepare('SELECT id,name,status FROM runs ORDER BY id DESC LIMIT 1').get();
if (!run) { console.log('no such run'); process.exit(0); }
console.log(`run ${run.name} (${run.status})`);
const rows = db.prepare(`SELECT b.name AS bench, m.alias AS model, COUNT(*) AS n,
    ROUND(AVG(r.score),3) AS score, ROUND(AVG(r.duration_s),1) AS secs,
    SUM(r.status='pass') AS passed
  FROM case_results r JOIN models m ON m.id=r.model_id JOIN benchmarks b ON b.id=r.benchmark_id
  WHERE r.run_id=? GROUP BY b.name, m.alias ORDER BY b.name, score DESC`).all(run.id);
console.log('benchmark  model                              cases  avg-score  avg-secs  passed');
for (const r of rows) console.log(`${String(r.bench).padEnd(10)} ${String(r.model).padEnd(34)} ${String(r.n).padStart(5)}  ${String(r.score).padStart(9)}  ${String(r.secs).padStart(8)}  ${r.passed}`);
JS
}

case "$KIND" in
  summary) summary "${ARGS[0]:-}"; exit 0 ;;
  status)
    if [ -e "$LOCK" ]; then echo "lock: $LOCK present"; else echo "lock: none"; fi
    docker exec "$BENCH" sh -c 'ps -eo args | grep "[n]pm run benchmark\|[m]ain.js"' || echo "no benchmark process"
    ls -1t "$REPORTS"/*.log 2>/dev/null | head -5
    exit 0 ;;
  llm|stt|tts|all) ;;
  *) die "unknown command $KIND (see --help)" ;;
esac

join_args() { local IFS=' '; echo "$*"; }
cmd_for() {  # KIND [MODELS...] -> npm arguments
  local k="$1"; shift
  case "$k" in
    llm) echo "$* --only hermes$([ "$OPTIN" = 1 ] && echo ' --with-optin')" ;;
    stt|tts) echo "--only $k $*" ;;
  esac
}

run_one() {  # KIND [MODELS...]
  local k="$1"; shift
  [ "$k" != llm ] || [ $# -gt 0 ] || die "llm needs at least one model (scripts/llama-router.sh presets)"
  local log="$REPORTS/$k-$STAMP.log" npm_args
  npm_args="$(cmd_for "$k" "$@")"
  echo "== $k: docker exec $BENCH npm run benchmark -- $npm_args   (log ${log#"$ROOT"/})"
  [ "$DRY" = 0 ] || return 0
  # shellcheck disable=SC2086
  docker exec "$BENCH" npm run benchmark -- $npm_args 2>&1 | tee "$log" || echo "bench: $k run exited non-zero (see log)" >&2
}

run_all() {
  [ ! -e "$LOCK" ] || die "a benchmark is running ($LOCK)"
  if [ "$DRY" = 0 ]; then
    docker exec speech-gateway touch /tmp/warmer.pause 2>/dev/null || echo "bench: warmer not paused (speech-gateway down?)" >&2
    trap 'docker exec speech-gateway rm -f /tmp/warmer.pause 2>/dev/null || true' EXIT
  fi
  if [ "$KIND" = all ]; then
    [ -n "$LLM_MODELS" ] || die "all needs --llm-models a,b"
    run_one stt; IFS=, read -ra M <<<"$LLM_MODELS"; run_one llm "${M[@]}"; run_one tts
  else
    run_one "$KIND" "${ARGS[@]}"
  fi
  [ "$DRY" = 1 ] || { echo; summary; }
}

if [ "$BG" = 1 ] && [ "$FG" = 0 ]; then
  [ ! -e "$LOCK" ] || die "a benchmark is running ($LOCK)"
  if [ "$DRY" = 1 ]; then echo "dry run: would detach: $0 $KIND $(join_args "${ARGS[@]}") --fg"; run_all; exit 0; fi
  LOG="$REPORTS/$KIND-$STAMP.driver.log"
  fwd=(); [ "$OPTIN" = 1 ] || fwd+=(--no-optin); [ -z "$LLM_MODELS" ] || fwd+=(--llm-models "$LLM_MODELS")
  nohup "$0" --fg "${fwd[@]}" "$KIND" "${ARGS[@]}" >"$LOG" 2>&1 &
  echo "detached (pid $!); follow with: tail -f ${LOG#"$ROOT"/}"
  exit 0
fi
run_all
