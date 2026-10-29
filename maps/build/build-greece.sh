#!/usr/bin/env bash
# Build the Greece data for the `maps` stack: vector tiles (Planetiler ->
# PMTiles), web map assets, Valhalla routing tiles and the Pelias search index
# (Who's On First + OpenStreetMap + street polylines) plus Placeholder.
#
# Runs on the homelab at a quiet time or on any machine with Docker, bash and
# curl (then copy the result with `push`). Nothing here starts the stack.
#
# Usage: build/build-greece.sh [command]
#   all         download, tiles, assets, valhalla, pelias, install (default)
#   download    Geofabrik greece-latest.osm.pbf, MD5-verified, resumable
#   tiles       Planetiler (OpenMapTiles schema) -> build/greece.pmtiles
#   assets      MapLibre JS/CSS, pmtiles.js, OSM Liberty sprites, Roboto glyphs
#   valhalla    Valhalla admins, time zones, tiles.tar and Pelias polylines
#   pelias      Who's On First download, Placeholder, Elasticsearch import
#   install     move finished build outputs into place, restart containers
#   status      show what is built for which extract
#   push DEST   rsync the installed data to DEST (e.g. host:docker/homelab/maps/data)
#   clean       remove downloads, temp files and old build outputs
#
# Every step records a marker keyed by the OSM extract date and image versions,
# so re-running skips finished work; a failed step restarts from its beginning.
# Tunables (environment): THREADS (default 4), PLANETILER_HEAP (2g),
# PLANETILER_MEM (3g), VALHALLA_BUILD_MEM (3g), ES_BUILD_HEAP (1g),
# ES_BUILD_MEM (2g), PELIAS_IMPORT_MEM (2g), VALHALLA_TIMEZONES (1),
# KEEP_SEARCH_RUNNING (0), DATA_DIR (maps/data).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${DATA_DIR:-$STACK_DIR/data}"
STATE_DIR="$DATA_DIR/.build"
BUILD_DIR="$DATA_DIR/build"

THREADS="${THREADS:-4}"
PLANETILER_HEAP="${PLANETILER_HEAP:-2g}"
PLANETILER_MEM="${PLANETILER_MEM:-3g}"
VALHALLA_BUILD_MEM="${VALHALLA_BUILD_MEM:-3g}"
ES_BUILD_HEAP="${ES_BUILD_HEAP:-1g}"
ES_BUILD_MEM="${ES_BUILD_MEM:-2g}"
PELIAS_IMPORT_MEM="${PELIAS_IMPORT_MEM:-2g}"
VALHALLA_TIMEZONES="${VALHALLA_TIMEZONES:-1}"
KEEP_SEARCH_RUNNING="${KEEP_SEARCH_RUNNING:-0}"

GEOFABRIK_URL="https://download.geofabrik.de/europe/greece-latest.osm.pbf"
OSM_LINK="greece-latest.osm.pbf"

# Web assets, pinned.
MAPLIBRE_VERSION="5.24.0"
PMTILES_JS_VERSION="4.5.0"
OSM_LIBERTY_COMMIT="40a0d19861c9d26805dee3daab5cb366badb6678"
FONTS_URL="https://github.com/openmaptiles/fonts/releases/download/v2.0/v2.0.zip"
FONTS=("Roboto Regular" "Roboto Medium" "Roboto Condensed Italic")

BUILD_NET="maps-build"
BUILD_ES="maps-build-elasticsearch"
# Runtime container names from docker-compose.yml.
RT_WEB="maps-web"
RT_VALHALLA="maps-valhalla"
RT_SEARCH=(maps-pelias-api maps-pelias-placeholder maps-pelias-elasticsearch)

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Image versions: defaults from .env.example, overridden by the same keys in
# .env (only *_VERSION keys are read), overridden by the environment.
load_versions() {
  local file key value
  declare -A from_file=()
  for file in "$STACK_DIR/.env.example" "$STACK_DIR/.env"; do
    [[ -f "$file" ]] || continue
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^MAPS_[A-Z_]+_VERSION$ && "$value" =~ ^[A-Za-z0-9._-]+$ ]] || continue
      from_file[$key]="$value"
    done < "$file"
  done
  for key in "${!from_file[@]}"; do
    [[ -n "${!key:-}" ]] || printf -v "$key" '%s' "${from_file[$key]}"
  done
  : "${MAPS_VALHALLA_VERSION:?missing in .env.example}" "${MAPS_ES_VERSION:?}" \
    "${MAPS_PLANETILER_VERSION:?}" "${MAPS_PELIAS_SCHEMA_VERSION:?}" \
    "${MAPS_PELIAS_WHOSONFIRST_VERSION:?}" "${MAPS_PELIAS_OPENSTREETMAP_VERSION:?}" \
    "${MAPS_PELIAS_POLYLINES_VERSION:?}" "${MAPS_PELIAS_PLACEHOLDER_VERSION:?}"
  IMG_PLANETILER="ghcr.io/onthegomap/planetiler:$MAPS_PLANETILER_VERSION"
  IMG_VALHALLA="ghcr.io/valhalla/valhalla:$MAPS_VALHALLA_VERSION"
  IMG_ES="pelias/elasticsearch:$MAPS_ES_VERSION"
  IMG_SCHEMA="pelias/schema:$MAPS_PELIAS_SCHEMA_VERSION"
  IMG_WOF="pelias/whosonfirst:$MAPS_PELIAS_WHOSONFIRST_VERSION"
  IMG_OSM="pelias/openstreetmap:$MAPS_PELIAS_OPENSTREETMAP_VERSION"
  IMG_POLYLINES="pelias/polylines:$MAPS_PELIAS_POLYLINES_VERSION"
  IMG_PLACEHOLDER="pelias/placeholder:$MAPS_PELIAS_PLACEHOLDER_VERSION"
}

RUN_AS="$(id -u):$(id -g)"

md5_of() {
  if command -v md5sum >/dev/null; then md5sum "$1" | awk '{print $1}'; else md5 -q "$1"; fi
}

osm_stamp() {
  [[ -f "$STATE_DIR/osm-file" ]] || die "no OSM extract yet; run: $0 download"
  cat "$STATE_DIR/osm-file"
}

is_done() { [[ -f "$STATE_DIR/$1.done" && "$(cat "$STATE_DIR/$1.done")" == "$2" ]]; }
mark_done() { printf '%s\n' "$2" > "$STATE_DIR/$1.done"; }

container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }
container_exists() { docker inspect "$1" >/dev/null 2>&1; }

check_disk() {
  local need_gb="$1" avail_kb
  avail_kb="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')"
  if (( avail_kb < need_gb * 1024 * 1024 )); then
    die "need about ${need_gb} GB free in $DATA_DIR, have $((avail_kb / 1024 / 1024)) GB"
  fi
}

# --------------------------------------------------------------------------
step_download() {
  local url name expected actual
  mkdir -p "$DATA_DIR/sources"
  # greece-latest redirects to the dated file (greece-YYMMDD.osm.pbf), which
  # does not change, so a partial download can be resumed safely.
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$GEOFABRIK_URL")"
  name="$(basename "$url")"
  [[ "$name" =~ ^greece-[0-9]{6}\.osm\.pbf$ ]] || die "unexpected Geofabrik file name: $name"
  expected="$(curl -fsSL "$url.md5" | awk '{print $1}')"
  [[ "$expected" =~ ^[0-9a-f]{32}$ ]] || die "could not fetch $url.md5"

  if [[ -f "$DATA_DIR/sources/$name" ]] && [[ "$(md5_of "$DATA_DIR/sources/$name")" == "$expected" ]]; then
    log "download: $name already present and verified"
  else
    check_disk 2
    log "download: $url (resumable)"
    curl -fL --retry 5 --retry-delay 10 -C - -o "$DATA_DIR/sources/$name.part" "$url"
    actual="$(md5_of "$DATA_DIR/sources/$name.part")"
    if [[ "$actual" != "$expected" ]]; then
      rm -f "$DATA_DIR/sources/$name.part"
      die "MD5 mismatch for $name (got $actual, want $expected); partial file removed, run again"
    fi
    mv "$DATA_DIR/sources/$name.part" "$DATA_DIR/sources/$name"
  fi
  ln -sfn "$name" "$DATA_DIR/sources/$OSM_LINK"
  # Keep only the current extract.
  find "$DATA_DIR/sources" -maxdepth 1 -name 'greece-[0-9]*.osm.pbf*' ! -name "$name" -delete
  printf '%s\n' "$name" > "$STATE_DIR/osm-file"
  log "download: using $name"
}

# --------------------------------------------------------------------------
step_tiles() {
  local key; key="$(osm_stamp) planetiler=$MAPS_PLANETILER_VERSION"
  if is_done tiles "$key"; then log "tiles: up to date ($key)"; return; fi
  check_disk 6
  mkdir -p "$BUILD_DIR" "$DATA_DIR/sources/planetiler" "$DATA_DIR/tmp/planetiler"
  rm -f "$BUILD_DIR/greece.pmtiles"
  log "tiles: Planetiler ${MAPS_PLANETILER_VERSION}, heap ${PLANETILER_HEAP}, ${THREADS} threads"
  # --download fetches only what is missing: water polygons, Natural Earth and
  # lake centrelines (about 1.4 GB, reused next month). The OSM file is local.
  docker run --rm --name maps-build-planetiler \
    --user "$RUN_AS" --cpus "$THREADS" --memory "$PLANETILER_MEM" \
    -e JAVA_TOOL_OPTIONS="-Xmx$PLANETILER_HEAP" \
    -v "$DATA_DIR:/data" \
    "$IMG_PLANETILER" \
    --osm_path="/data/sources/$OSM_LINK" \
    --download --download_dir=/data/sources/planetiler \
    --tmpdir=/data/tmp/planetiler \
    --output=/data/build/greece.pmtiles --force \
    --threads="$THREADS" --storage=mmap \
    --languages=el,en
  rm -rf "$DATA_DIR/tmp/planetiler"
  [[ -s "$BUILD_DIR/greece.pmtiles" ]] || die "Planetiler produced no output"
  mark_done tiles "$key"
}

# --------------------------------------------------------------------------
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

step_assets() {
  local key out lib zip font
  key="maplibre=$MAPLIBRE_VERSION pmtiles=$PMTILES_JS_VERSION liberty=$OSM_LIBERTY_COMMIT fonts=v2.0"
  if is_done assets "$key" && [[ -d "$DATA_DIR/web-assets" ]]; then log "assets: up to date"; return; fi
  out="$BUILD_DIR/web-assets"
  rm -rf "$out"; mkdir -p "$out/lib" "$out/sprites" "$out/fonts" "$DATA_DIR/sources"
  log "assets: MapLibre GL JS $MAPLIBRE_VERSION, pmtiles $PMTILES_JS_VERSION, OSM Liberty sprites"
  lib="https://cdn.jsdelivr.net/npm"
  fetch "$lib/maplibre-gl@$MAPLIBRE_VERSION/dist/maplibre-gl.js" "$out/lib/maplibre-gl.js"
  fetch "$lib/maplibre-gl@$MAPLIBRE_VERSION/dist/maplibre-gl.css" "$out/lib/maplibre-gl.css"
  fetch "$lib/maplibre-gl@$MAPLIBRE_VERSION/LICENSE.txt" "$out/lib/maplibre-gl.LICENSE.txt"
  fetch "$lib/pmtiles@$PMTILES_JS_VERSION/dist/pmtiles.js" "$out/lib/pmtiles.js"
  for f in osm-liberty.json osm-liberty.png osm-liberty@2x.json osm-liberty@2x.png; do
    fetch "https://raw.githubusercontent.com/maputnik/osm-liberty/$OSM_LIBERTY_COMMIT/sprites/$f" "$out/sprites/$f"
  done
  fetch "https://raw.githubusercontent.com/maputnik/osm-liberty/$OSM_LIBERTY_COMMIT/LICENSE.md" "$out/sprites/LICENSE.md"

  zip="$DATA_DIR/sources/openmaptiles-fonts-v2.0.zip"
  if [[ ! -s "$zip" ]]; then
    log "assets: glyphs (openmaptiles/fonts v2.0, 74 MB; only Roboto is kept)"
    curl -fL --retry 3 -C - -o "$zip.part" "$FONTS_URL"
    mv "$zip.part" "$zip"
  fi
  if command -v unzip >/dev/null; then
    unzip -q -o "$zip" "${FONTS[@]/%//*}" -d "$out/fonts"
  else
    docker run --rm --user "$RUN_AS" -v "$DATA_DIR:/data" "$IMG_VALHALLA" \
      unzip -q -o "/data/sources/$(basename "$zip")" "${FONTS[@]/%//*}" -d /data/build/web-assets/fonts
  fi
  for font in "${FONTS[@]}"; do
    [[ -f "$out/fonts/$font/0-255.pbf" ]] || die "glyphs for '$font' missing after unzip"
  done
  mark_done assets "$key"
}

# --------------------------------------------------------------------------
step_valhalla() {
  local key; key="$(osm_stamp) valhalla=$MAPS_VALHALLA_VERSION tz=$VALHALLA_TIMEZONES"
  if is_done valhalla "$key"; then log "valhalla: up to date ($key)"; return; fi
  check_disk 4
  rm -rf "$BUILD_DIR/valhalla"
  mkdir -p "$BUILD_DIR/valhalla" "$DATA_DIR/pelias/polylines"
  log "valhalla: ${MAPS_VALHALLA_VERSION}, ${THREADS} threads, memory cap ${VALHALLA_BUILD_MEM}"
  # The build container sees the staging dir at the runtime path, so the
  # generated valhalla.json is valid for the maps-valhalla container as is.
  docker run --rm --name maps-build-valhalla \
    --user "$RUN_AS" --cpus "$THREADS" --memory "$VALHALLA_BUILD_MEM" \
    -e THREADS="$THREADS" -e TZ_ENABLED="$VALHALLA_TIMEZONES" -e PBF="/data/sources/$OSM_LINK" \
    -v "$DATA_DIR/sources:/data/sources:ro" \
    -v "$BUILD_DIR/valhalla:/data/valhalla" \
    -v "$DATA_DIR/pelias/polylines:/data/polylines" \
    "$IMG_VALHALLA" bash -euo pipefail -c '
      cd /data/valhalla
      valhalla_build_config \
        --mjolnir-tile-dir /data/valhalla/tiles \
        --mjolnir-tile-extract /data/valhalla/tiles.tar \
        --mjolnir-admin /data/valhalla/admin.sqlite \
        --mjolnir-timezone /data/valhalla/tz_world.sqlite \
        --mjolnir-landmarks /data/valhalla/landmarks.sqlite \
        --mjolnir-max-cache-size 67108864 \
        --mjolnir-concurrency "$THREADS" \
        --logging-color false > valhalla.json
      if [ "$TZ_ENABLED" = 1 ]; then
        mkdir -p .tz && cd .tz
        if valhalla_build_timezones > ../tz_world.sqlite; then echo "time zones built" >&2
        else echo "time zones failed; routing works without them" >&2; rm -f ../tz_world.sqlite; fi
        cd .. && rm -rf .tz
      fi
      valhalla_build_admins -c valhalla.json "$PBF"
      valhalla_build_tiles -c valhalla.json "$PBF"
      valhalla_build_extract -c valhalla.json -O -v
      # Street centrelines for Pelias (streets without house numbers).
      valhalla_export_edges -c valhalla.json \
        | grep -av "^[0-9]\{4\}/[0-9]\{2\}/[0-9]\{2\} " > /data/polylines/extract.0sv.tmp
      mv /data/polylines/extract.0sv.tmp /data/polylines/extract.0sv
      rm -rf tiles
    '
  [[ -s "$BUILD_DIR/valhalla/tiles.tar" ]] || die "Valhalla produced no tiles.tar"
  mark_done valhalla "$key"
}

# --------------------------------------------------------------------------
pelias_run() {
  local image="$1"; shift
  docker run --rm --network "$BUILD_NET" \
    --user "$RUN_AS" --cpus "$THREADS" --memory "$PELIAS_IMPORT_MEM" \
    -e HOME=/tmp -e PELIAS_CONFIG=/config/pelias.json \
    -v "$STACK_DIR/pelias/pelias.json:/config/pelias.json:ro" \
    -v "$DATA_DIR:/data" \
    "$image" "$@"
}

es_curl() { docker exec "$BUILD_ES" curl -fsS "$@"; }

start_build_es() {
  docker network inspect "$BUILD_NET" >/dev/null 2>&1 || docker network create "$BUILD_NET" >/dev/null
  docker rm -f "$BUILD_ES" >/dev/null 2>&1 || true
  mkdir -p "$BUILD_DIR/elasticsearch"
  log "pelias: temporary Elasticsearch, heap ${ES_BUILD_HEAP}, memory cap ${ES_BUILD_MEM}"
  # The alias matches the host name in pelias/pelias.json.
  docker run -d --name "$BUILD_ES" --network "$BUILD_NET" --network-alias maps-pelias-elasticsearch \
    --user "$(id -u):0" --cpus "$THREADS" --memory "$ES_BUILD_MEM" \
    --ulimit memlock=-1:-1 --ulimit nofile=65536:65536 \
    -e ES_JAVA_OPTS="-Xms$ES_BUILD_HEAP -Xmx$ES_BUILD_HEAP" \
    -e discovery.type=single-node -e xpack.ml.enabled=false -e xpack.security.enabled=false \
    -e xpack.watcher.enabled=false -e ingest.geoip.downloader.enabled=false \
    -v "$BUILD_DIR/elasticsearch:/usr/share/elasticsearch/data" \
    "$IMG_ES" >/dev/null
  local i
  for i in $(seq 1 90); do
    if es_curl 'http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=2s' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  docker logs --tail 50 "$BUILD_ES" >&2 || true
  die "build Elasticsearch did not become healthy"
}

stop_build_es() {
  container_exists "$BUILD_ES" || return 0
  docker stop -t 120 "$BUILD_ES" >/dev/null || true
  docker rm -f "$BUILD_ES" >/dev/null 2>&1 || true
}

step_pelias() {
  local stamp key_wof key_ph key_idx c
  stamp="$(osm_stamp)"
  [[ -s "$DATA_DIR/pelias/polylines/extract.0sv" ]] || die "polylines missing; run: $0 valhalla"
  mkdir -p "$DATA_DIR/pelias/whosonfirst" "$DATA_DIR/tmp"
  docker network inspect "$BUILD_NET" >/dev/null 2>&1 || docker network create "$BUILD_NET" >/dev/null

  # Who's On First admin areas and postcodes for GR (about 25 MB download).
  key_wof="$(date +%Y-%m) wof=$MAPS_PELIAS_WHOSONFIRST_VERSION"
  if ! is_done pelias-wof "$key_wof"; then
    log "pelias: Who's On First (GR) download"
    pelias_run "$IMG_WOF" ./bin/download
    mark_done pelias-wof "$key_wof"
  fi

  key_ph="$key_wof placeholder=$MAPS_PELIAS_PLACEHOLDER_VERSION"
  if ! is_done pelias-placeholder "$key_ph"; then
    log "pelias: Placeholder database"
    rm -rf "$BUILD_DIR/placeholder"; mkdir -p "$BUILD_DIR/placeholder"
    docker run --rm --user "$RUN_AS" --cpus "$THREADS" --memory "$PELIAS_IMPORT_MEM" \
      -e HOME=/tmp -e PELIAS_CONFIG=/config/pelias.json -e PLACEHOLDER_DATA=/data/build/placeholder \
      -v "$STACK_DIR/pelias/pelias.json:/config/pelias.json:ro" -v "$DATA_DIR:/data" \
      "$IMG_PLACEHOLDER" bash -c './cmd/extract.sh && ./cmd/build.sh'
    [[ -s "$BUILD_DIR/placeholder/store.sqlite3" ]] || die "Placeholder produced no store.sqlite3"
    rm -f "$BUILD_DIR/placeholder/wof.extract"
    mark_done pelias-placeholder "$key_ph"
  fi

  key_idx="$stamp $key_wof es=$MAPS_ES_VERSION schema=$MAPS_PELIAS_SCHEMA_VERSION osm=$MAPS_PELIAS_OPENSTREETMAP_VERSION polylines=$MAPS_PELIAS_POLYLINES_VERSION"
  if is_done pelias-index "$key_idx"; then log "pelias: index up to date"; return; fi
  check_disk 5

  # Free the RAM of the live search containers while the import runs (search
  # is offline until `install`). Tiles and routing stay up.
  if [[ "$KEEP_SEARCH_RUNNING" != 1 ]]; then
    for c in "${RT_SEARCH[@]}"; do
      if container_running "$c"; then log "pelias: stopping $c for the import"; docker stop "$c" >/dev/null; fi
    done
  fi

  rm -rf "$BUILD_DIR/elasticsearch" "$DATA_DIR/tmp/pelias-osm-leveldb"
  mkdir -p "$DATA_DIR/tmp/pelias-osm-leveldb"
  trap stop_build_es EXIT
  start_build_es
  log "pelias: create index"
  pelias_run "$IMG_SCHEMA" ./bin/create_index
  log "pelias: import Who's On First"
  pelias_run "$IMG_WOF" ./bin/start
  log "pelias: import OpenStreetMap (venues, addresses)"
  pelias_run "$IMG_OSM" ./bin/start
  log "pelias: import street polylines"
  pelias_run "$IMG_POLYLINES" ./bin/start
  log "pelias: refresh and merge segments"
  es_curl -X POST 'http://127.0.0.1:9200/pelias/_refresh' >/dev/null
  es_curl -X POST 'http://127.0.0.1:9200/pelias/_forcemerge?max_num_segments=1' >/dev/null
  es_curl 'http://127.0.0.1:9200/_cat/indices/pelias?v&h=index,docs.count,store.size' >&2
  stop_build_es
  trap - EXIT
  rm -rf "$DATA_DIR/tmp/pelias-osm-leveldb"
  mark_done pelias-index "$key_idx"
}

# --------------------------------------------------------------------------
swap_dir() { # swap_dir NEW LIVE
  [[ -d "$1" ]] || return 0
  mkdir -p "$(dirname "$2")"
  rm -rf "$2.old"
  [[ -e "$2" ]] && mv "$2" "$2.old"
  mv "$1" "$2"
  rm -rf "$2.old"
}

step_install() {
  local c
  mkdir -p "$DATA_DIR/tiles" "$DATA_DIR/web-assets" "$DATA_DIR/valhalla" \
    "$DATA_DIR/pelias/elasticsearch" "$DATA_DIR/pelias/placeholder"

  if [[ -s "$BUILD_DIR/greece.pmtiles" ]]; then
    log "install: tiles"
    mv -f "$BUILD_DIR/greece.pmtiles" "$DATA_DIR/tiles/greece.pmtiles"
  fi
  if [[ -d "$BUILD_DIR/web-assets" ]]; then
    log "install: web assets"
    swap_dir "$BUILD_DIR/web-assets" "$DATA_DIR/web-assets"
  fi
  if [[ -s "$BUILD_DIR/valhalla/tiles.tar" ]]; then
    log "install: Valhalla tiles"
    swap_dir "$BUILD_DIR/valhalla" "$DATA_DIR/valhalla"
    if container_exists "$RT_VALHALLA"; then docker restart "$RT_VALHALLA" >/dev/null; fi
  fi
  if [[ -d "$BUILD_DIR/elasticsearch/nodes" || -s "$BUILD_DIR/placeholder/store.sqlite3" ]]; then
    log "install: Pelias index and Placeholder"
    for c in "${RT_SEARCH[@]}"; do container_running "$c" && docker stop "$c" >/dev/null; done
    if is_done pelias-index "$(cat "$STATE_DIR/pelias-index.done" 2>/dev/null)" && [[ -d "$BUILD_DIR/elasticsearch/nodes" ]]; then
      swap_dir "$BUILD_DIR/elasticsearch" "$DATA_DIR/pelias/elasticsearch"
    fi
    if [[ -s "$BUILD_DIR/placeholder/store.sqlite3" ]]; then
      swap_dir "$BUILD_DIR/placeholder" "$DATA_DIR/pelias/placeholder"
    fi
  fi
  # Start whatever exists (on the homelab); a build machine has no containers.
  for c in maps-pelias-elasticsearch maps-pelias-placeholder maps-pelias-api; do
    container_exists "$c" && docker start "$c" >/dev/null
  done
  container_exists "$RT_WEB" || log "install: done. Start the stack with: docker compose -f $STACK_DIR/docker-compose.yml up -d"
  log "install: done"
}

step_status() {
  local f
  printf 'data: %s\n' "$DATA_DIR"
  printf 'extract: %s\n' "$(cat "$STATE_DIR/osm-file" 2>/dev/null || echo none)"
  for f in "$STATE_DIR"/*.done; do
    [[ -e "$f" ]] && printf '  %-20s %s\n' "$(basename "$f" .done)" "$(cat "$f")"
  done
  du -sh "$DATA_DIR"/{sources,tiles,web-assets,valhalla,pelias/elasticsearch,pelias/placeholder,build} 2>/dev/null || true
}

step_push() {
  local dest="${1:-}"
  [[ -n "$dest" ]] || die "usage: $0 push user@host:/path/to/maps/data"
  log "push: stop the remote search containers first (docker compose stop), then:"
  cd "$DATA_DIR"
  rsync -aR --delete --info=progress2 \
    ./tiles ./web-assets ./valhalla ./pelias/elasticsearch ./pelias/placeholder "$dest"
  log "push: done; on the target run: docker compose up -d --force-recreate"
}

step_clean() {
  log "clean: removing temp files, build staging and old downloads"
  rm -rf "$DATA_DIR/tmp" "$BUILD_DIR" "$DATA_DIR/sources/planetiler"
  find "$DATA_DIR/sources" -maxdepth 1 -name '*.part' -delete 2>/dev/null || true
  rm -f "$STATE_DIR"/tiles.done "$STATE_DIR"/valhalla.done "$STATE_DIR"/pelias-*.done "$STATE_DIR"/assets.done
}

# --------------------------------------------------------------------------
main() {
  local cmd="${1:-all}"; shift || true
  command -v docker >/dev/null || die "docker is required"
  command -v curl >/dev/null || die "curl is required"
  mkdir -p "$STATE_DIR" "$BUILD_DIR"
  load_versions

  # One build at a time.
  if ! mkdir "$STATE_DIR/lock" 2>/dev/null; then
    die "another build is running (remove $STATE_DIR/lock if it is stale)"
  fi
  trap 'rmdir "$STATE_DIR/lock" 2>/dev/null || true' EXIT
  # Steps that set their own EXIT trap restore this one afterwards.
  release_lock() { rmdir "$STATE_DIR/lock" 2>/dev/null || true; }

  case "$cmd" in
    all)
      step_download; step_tiles; step_assets; step_valhalla; step_pelias; step_install ;;
    download) step_download ;;
    tiles) step_tiles ;;
    assets) step_assets ;;
    valhalla) step_valhalla ;;
    pelias) step_pelias ;;
    install) step_install ;;
    status) step_status ;;
    push) step_push "$@" ;;
    clean) step_clean ;;
    -h|--help|help) sed -n '2,30p' "$0" ;;
    *) die "unknown command: $cmd (try --help)" ;;
  esac
  release_lock
}

main "$@"
