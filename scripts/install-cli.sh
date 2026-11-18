#!/usr/bin/env bash
# Install (or remove) the homelab command-line tools as symlinks in ~/.local/bin.
#
#   scripts/install-cli.sh              link every bin/* of this repo, plus agent-sandbox's
#                                       own commands (agent-sandbox, pi-sandbox, hermes-sandbox)
#   scripts/install-cli.sh --uninstall  remove only links that point into these two repos
#   scripts/install-cli.sh --dry-run    show what would happen
#   env: AGENT_SANDBOX_DIR (default: ../agent-sandbox next to this checkout),
#        BIN_DIR (default: ~/.local/bin)
#
# Idempotent. A regular file at a target path is never overwritten (for example
# ~/.local/bin/llama), and a link that points somewhere else is left alone.
# agent-sandbox is a separate local repo with no remote: on a new machine copy
# it next to the homelab checkout first, or set AGENT_SANDBOX_DIR.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
AS_DIR="${AGENT_SANDBOX_DIR:-$ROOT/../agent-sandbox}"
UNINSTALL=0 DRY=0
for a in "$@"; do
  case "$a" in
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "install-cli: unknown option $a" >&2; exit 2 ;;
  esac
done
[ -d "$AS_DIR" ] && AS_DIR="$(cd "$AS_DIR" && pwd)" || true

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  (dry run) $*"; else "$@"; fi; }

link_one() {  # SOURCE
  local src="$1" name dst cur
  name="$(basename "$src")"; dst="$BIN_DIR/$name"
  if [ -L "$dst" ]; then
    cur="$(readlink "$dst")"
    if [ "$cur" = "$src" ]; then say "ok        $name -> $src"; return; fi
    case "$cur" in
      "$ROOT"/*|"$AS_DIR"/*) run ln -sfn "$src" "$dst"; say "relinked  $name -> $src (was $cur)"; return ;;
      *) say "skipped   $name: link points elsewhere ($cur)"; return ;;
    esac
  elif [ -e "$dst" ]; then
    say "skipped   $name: $dst is a regular file, not touched"; return
  fi
  run ln -s "$src" "$dst"; say "linked    $name -> $src"
}

unlink_one() {  # NAME
  local dst="$BIN_DIR/$1" cur
  [ -L "$dst" ] || return 0
  cur="$(readlink "$dst")"
  case "$cur" in
    "$ROOT"/*|"$AS_DIR"/*) run rm "$dst"; say "removed   $1 (was $cur)" ;;
    *) say "kept      $1: points outside these repos ($cur)" ;;
  esac
}

sources=()
for f in "$ROOT"/bin/*; do [ -f "$f" ] && [ -x "$f" ] && sources+=("$f"); done
as_cmds=(agent-sandbox pi-sandbox hermes-sandbox)
if [ -d "$AS_DIR" ]; then
  for c in "${as_cmds[@]}"; do
    if [ -x "$AS_DIR/$c" ]; then sources+=("$AS_DIR/$c"); else say "warning   $AS_DIR/$c missing"; fi
  done
else
  say "warning   agent-sandbox not found at $AS_DIR. It is a separate local repo with no remote:"
  say "          copy it next to this checkout (or set AGENT_SANDBOX_DIR) and rerun this script."
fi

if [ "$UNINSTALL" = 1 ]; then
  for s in "${sources[@]}"; do unlink_one "$(basename "$s")"; done
  for c in "${as_cmds[@]}"; do [ -d "$AS_DIR" ] || unlink_one "$c"; done
  exit 0
fi

[ -d "$BIN_DIR" ] || { run mkdir -p "$BIN_DIR"; say "created   $BIN_DIR"; }
for s in "${sources[@]}"; do link_one "$s"; done

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "warning   $BIN_DIR is not on PATH; add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
