#!/usr/bin/env bash
# Validate, rebuild or recreate one stack the way AGENTS.md and the history do it.
#
#   scripts/stack.sh check STACK              docker compose config --quiet with the stack's .env
#   scripts/stack.sh up STACK [SERVICE ...]   check, then docker compose up -d --no-deps SERVICE...
#                                             (every service when none is named; --no-deps only
#                                             when services are named)
#   scripts/stack.sh rebuild STACK SERVICE... check, build the local image, recreate the service
#   options: --dry-run (print the commands only)
#
# Refuses while benchmark/reports/.running.lock exists, because recreating the
# benchmark, hermes or speech containers would kill a run. Falls back to
# .env.example for the check when the stack has no .env (never for up/rebuild).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "stack: $*" >&2; exit 1; }
usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

DRY=0 ARGS=()
for a in "$@"; do case "$a" in -h|--help) usage; exit 0 ;; --dry-run) DRY=1 ;; *) ARGS+=("$a") ;; esac; done
set -- "${ARGS[@]+"${ARGS[@]}"}"
CMD="${1:-}"; STACK="${2:-}"; [ -n "$CMD" ] && [ -n "$STACK" ] || { usage; exit 2; }; shift 2
STACK="${STACK%/}"
DIR="$ROOT/$STACK"; [ -f "$DIR/docker-compose.yml" ] || die "no $STACK/docker-compose.yml"
ENVF="$DIR/.env"
if [ ! -f "$ENVF" ]; then
  [ "$CMD" = check ] || die "$STACK/.env missing (scripts/setup-env.sh $STACK)"
  ENVF="$DIR/.env.example"
fi
dc() { docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" "$@"; }
run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

case "$CMD" in
  check) run docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" config --quiet && echo "$STACK: compose config ok" ;;
  up|rebuild)
    [ ! -e "$ROOT/benchmark/reports/.running.lock" ] || die "a benchmark is running (benchmark/reports/.running.lock)"
    [ "$CMD" = up ] || [ $# -gt 0 ] || die "rebuild needs at least one SERVICE"
    run docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" config --quiet
    if [ "$CMD" = rebuild ]; then run docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" build "$@"; fi
    if [ $# -gt 0 ]; then run docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" up -d --no-deps "$@"
    else run docker compose --env-file "$ENVF" -f "$DIR/docker-compose.yml" up -d; fi
    [ "$DRY" = 1 ] || dc ps ;;
  *) die "unknown command $CMD (see --help)" ;;
esac
