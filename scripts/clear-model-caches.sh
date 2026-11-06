#!/usr/bin/env bash
# List, and with --yes delete, the re-downloadable model caches of the lab.
#
#   scripts/clear-model-caches.sh [--yes] [--docker] [--root DIR]
#
# Without --yes it only prints what it would delete, with sizes.
#
# Deleted:
# * ~/.cache/huggingface (the `hf` CLI cache of this user).
# * Every Hugging Face hub cache under the repository: a folder holding
#   CACHEDIR.TAG (hub/), plus the xet/ chunk cache next to it. Examples:
#   unsloth-studio/huggingface/hub, speech/*/hub. Services download again on
#   their next use (services without internet need a manual download).
# * The `.cache/huggingface` metadata that `hf download --local-dir` leaves
#   inside model folders (llama-cpp/models/*/*, speech/parakeet*, ...). The
#   model files next to it are kept.
# * With --docker: the Docker build cache (`docker builder prune -af`). Images
#   and containers are not touched; the next image build is slower.
#
# Never deleted: model files themselves (*.gguf, ONNX folders, speech and
# llama.cpp model folders), databases, uploads and other service data.
#
# Files written by root inside containers are removed through a throwaway
# container (alpine) with only that folder mounted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YES=0
DOCKER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --docker) DOCKER=1 ;;
    --root) ROOT="$(cd "$2" && pwd)"; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

targets=()
add() { [ -e "$1" ] && targets+=("$1") || true; }

add "$HOME/.cache/huggingface"

# Skip data trees that never hold model caches (large and slow to walk).
prune=(-name .git -o -name node_modules -o -name postgres -o -name library
       -o -path '*/nextcloud/data' -o -path '*/immich/upload')

# Only Hugging Face hub caches: CACHEDIR.TAG next to models--*/datasets--*
# entries (uv, pip and other tools also write CACHEDIR.TAG).
while IFS= read -r -d '' tag; do
  hub="$(dirname "$tag")"
  if [ "$(basename "$hub")" = hub ] || compgen -G "$hub/models--*" >/dev/null || compgen -G "$hub/datasets--*" >/dev/null; then
    add "$hub"
    add "$(dirname "$hub")/xet"
  fi
done < <(find "$ROOT" -xdev \( "${prune[@]}" \) -prune -o -name CACHEDIR.TAG -type f -print0 2>/dev/null)

while IFS= read -r -d '' dir; do
  add "$dir"
done < <(find "$ROOT" -xdev \( "${prune[@]}" \) -prune -o -type d -path '*/.cache/huggingface' -print0 2>/dev/null)

# De-duplicate and drop entries nested in another target.
mapfile -t targets < <(printf '%s\n' "${targets[@]}" | sort -u)
final=()
for t in "${targets[@]}"; do
  nested=0
  for o in "${targets[@]}"; do
    [ "$o" != "$t" ] && [[ "$t" == "$o"/* ]] && nested=1 && break
  done
  [ "$nested" -eq 0 ] && final+=("$t")
done

total=0
for t in "${final[@]}"; do
  kb=$(du -sk "$t" 2>/dev/null | head -1 | cut -f1 || true)
  kb=${kb:-0}
  total=$((total + kb))
  printf '%8s  %s\n' "$(numfmt --to=iec $((kb * 1024)))" "${t/#$HOME/~}"
done
printf '%8s  total\n' "$(numfmt --to=iec $((total * 1024)))"
if [ "$DOCKER" -eq 1 ]; then
  echo "Docker build cache: $(docker system df --format '{{.Type}} {{.Reclaimable}}' | awk '/Build/ {print $3, $4}')"
fi

if [ "$YES" -ne 1 ]; then
  echo "Dry run. Add --yes to delete (and --docker to also prune the Docker build cache)."
  exit 0
fi

for t in "${final[@]}"; do
  if ! rm -rf -- "$t" 2>/dev/null; then
    # Root-owned files from a container: delete them from a container.
    parent="$(dirname "$t")" name="$(basename "$t")"
    docker run --rm -v "$parent:/x" alpine:3 rm -rf -- "/x/$name"
  fi
  echo "deleted ${t/#$HOME/~}"
done

if [ "$DOCKER" -eq 1 ]; then
  docker builder prune -af
fi
