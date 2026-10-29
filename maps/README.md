# maps: self-hosted Greece maps

One Compose project (`maps`) behind one hostname, `https://maps.${DOMAIN}`
(WireGuard only; it has no login of its own). It covers Greece only and is
meant to stay small. Nothing is downloaded or built at runtime: the data comes
from `build/build-greece.sh`, which you run once and then monthly.

## What each part does

| Container | What it does | What you get |
|---|---|---|
| `maps-web` (nginx) | Serves the web map page, its style, fonts and icons, and the vector-tile file `greece.pmtiles` (HTTP range requests, so no tile server is needed). | A browser map of Greece at `/`, no Google, no external tile provider. |
| `maps-valhalla` | Routing engine (car, bike, walking, ...). Path `/valhalla/route`. | Directions and travel times from your own server. |
| `maps-pelias-api` | Search API (`/pelias/v1/autocomplete`, `search`, `reverse`, `nearby`). | Place and address search, tap-to-identify. |
| `maps-pelias-placeholder` | Looks up towns, regions and postcodes (Who's On First). | "Kifisia, Attica" style searches. |
| `maps-pelias-elasticsearch` | The search index (single node, 512m heap). | Fast search over Greek OSM places and streets. |

Not included on purpose: libpostal (saves about 2 GB) and address
interpolation. Pelias's `/v1/search` refuses to run without a libpostal URL
("libpostal service disabled"), so `maps-web` answers an empty parse on
port 4400 (backend network only) and search falls back to Pelias's built-in
parser, the same one autocomplete uses.
Street-level search finds streets and OSM-mapped house numbers, not numbers
that are only interpolated along a street. Public transport is not served here:
Cardinal calls the public Transitous service itself.

Public paths on `maps.${DOMAIN}`: `/` web map, `/tiles/greece.pmtiles`,
`/pelias/v1/...`, `/valhalla/...` (Traefik strips the prefix). Only the web,
Valhalla and Pelias API containers join `webgateway`; Placeholder and
Elasticsearch are on the internal `backend` network only.

## RAM (measured 2026-10-29)

Measured with the cgroup `anon` figure a few minutes after the first start
(Greece extract 2026-10-28). "Limit" is the hard `mem_limit` from `.env`.

| Part | Measured idle | Limit |
|---|---|---|
| maps-web | 1 MB | 32m |
| maps-valhalla (2 threads, mmapped tiles) | 75 MB | 384m |
| maps-pelias-api | 90 MB | 256m |
| maps-pelias-placeholder | 22 MB | 256m |
| maps-pelias-elasticsearch (512m heap) | 1,030 MB | 1536m |
| Total | about 1.2 GB | 2.4 GB |

With a 512m heap the Elasticsearch JVM still uses about 1 GB in total. At the
first limit of 1g it sat at the ceiling and was reclaimed constantly, so the
limit is 1536m.

The page cache for `greece.pmtiles` and the Valhalla tiles is extra but is
reclaimable. Elasticsearch needs `vm.max_map_count >= 262144` on the host
(`sysctl vm.max_map_count`; set with `sudo sysctl -w vm.max_map_count=262144`
and persist it in `/etc/sysctl.d/`).

## Build and update

Data lives in `maps/data/` (ignored by Git). Run from the repo:

```sh
maps/build/build-greece.sh            # everything, in order
maps/build/build-greece.sh status     # what is built, for which extract
maps/build/build-greece.sh --help
```

Then start the stack with `docker compose -f maps/docker-compose.yml up -d`
(the first time; `install` restarts existing containers afterwards).

It needs Docker, bash and curl. It can run on another machine with more RAM:
use `DATA_DIR=/some/disk/maps-data`, then
`build-greece.sh push user@homelab:/home/tom/docker/homelab/maps/data`
(rsync) and `docker compose up -d --force-recreate` on the homelab.
Every step is resumable: a finished step is skipped (marker keyed by the
extract date and image versions), a failed one restarts from its own
beginning, and the Geofabrik download resumes and is MD5-verified.

Resource caps per step (each is an environment variable; defaults shown) and
rough figures for Greece. All of these are estimates and unmeasured; the
first real run should replace them.

| Step | Cap (default) | Disk | Time | Peak RAM |
|---|---|---|---|---|
| download (Geofabrik, ~0.3 GB) | none | 0.3 GB | minutes | tiny |
| tiles (Planetiler to PMTiles; also fetches ~1.4 GB of water/Natural Earth data once) | `PLANETILER_MEM=3g`, heap `2g`, `THREADS=4` | ~4 GB work, 0.5-1 GB result | 15-40 min | ~2.5 GB |
| assets (MapLibre, pmtiles.js, sprites, Roboto glyphs; 74 MB zip) | none | ~0.1 GB | 1-2 min | tiny |
| valhalla (admins, time zones, tiles, street export) | `VALHALLA_BUILD_MEM=3g` | ~2-3 GB peak, ~0.5-1 GB result | 15-45 min | ~2-3 GB |
| pelias (WOF, placeholder, Elasticsearch import) | `PELIAS_IMPORT_MEM=2g`, `ES_BUILD_MEM=2g`, heap `ES_BUILD_HEAP=1g` | ~3-5 GB peak, ~1-1.5 GB result | 30-90 min | ~3-4 GB (importer plus temporary Elasticsearch) |

Total working disk about 10 GB; free space is checked before each step. On a
tight host run steps one at a time (`download`, `tiles`, ...) and lower
`THREADS`. While the Pelias import runs the live search containers are
stopped to free RAM (`KEEP_SEARCH_RUNNING=1` keeps them). Tiles and routing
stay up. The build never starts the stack.

### Monthly update

1. `maps/build/build-greece.sh all` (new extract, rebuild, swap in place).
   The old data keeps serving until `install` swaps it; search and routing
   restart for a minute or so.
2. `maps/build/build-greece.sh status` should show the new extract date.
3. Bumping an image tag in `.env`/`.env.example` triggers a rebuild of the
   matching step. Keep the Elasticsearch, Valhalla and Pelias versions the
   same between build and runtime (the script reads the same variables).
4. `build-greece.sh clean` frees the downloads and staging space.

### Backups

Nothing here is precious. Everything under `maps/data/` is a build output and
can be rebuilt from the script; do not back it up unless you want to skip a
30-120 minute rebuild. Tracked files (this folder) are in Git.

## Phone: Cardinal Maps

Cardinal (now published as Murena Maps, source:
gitlab.e.foundation/e/os/cardinal) is a MapLibre app with online and offline
modes. Verified in its source:

- It has exactly four self-hosting fields, under Settings, Advanced:
  Pelias Base URL, Pelias API Key, Valhalla Base URL, Valhalla API Key.
  The defaults are `https://maps.earth/pelias/v1` and
  `https://maps.earth/valhalla/route` (the Headway layout this stack copies).
- The app appends `/autocomplete`, `/search`, `/reverse` and `/nearby` to the
  Pelias URL, and POSTs to the Valhalla URL exactly as typed (so it must end
  in `/route`).
- The basemap tile source is NOT a setting: the style is bundled in the app and
  points at Murena's tile server (plus low-zoom bundled tiles and the app's own
  offline downloads). So Cardinal's drawn map still comes from Murena;
  only search and routing become yours. The self-hosted tiles power the web
  map and are ready for any app that accepts a custom tile source.

Steps:

1. Join the phone to WireGuard (the host is not reachable otherwise).
2. Install Cardinal / Murena Maps with Obtainium, adding the source
   `https://gitlab.e.foundation/e/os/maps` (the project path used in the
   README's Obtainium badge; the app id is `com.murena.maps`), or from the
   /e/OS App Lounge if you run /e/OS.
3. Open Settings, then Advanced. Set:
   - Pelias Base URL: `https://maps.lab.rafasmour.com/pelias/v1`
   - Pelias API Key: leave empty
   - Valhalla Base URL: `https://maps.lab.rafasmour.com/valhalla/route`
   - Valhalla API Key: leave empty
   (use your own `DOMAIN` if it is not `lab.rafasmour.com`).
4. Search for a Greek address and request a route to test. Without WireGuard
   both fail with a connection error, by design.

Offline fallback: install CoMaps or OsmAnd and download the Greece map for
use with no connection (the cost is a few hundred MB per app). Cardinal also has
its own offline-area downloads.

## Web map

Open `https://maps.${DOMAIN}` over WireGuard: search box, click or long-press
for a place, set From/To and choose car, bike or walking for a route. MapLibre
reads `/tiles/greece.pmtiles` with range requests. The style is OSM Liberty
(BSD-3-Clause); credit OpenMapTiles and OpenStreetMap contributors.

## Access and security

No authentication is configured, deliberately: WireGuard is the boundary
(same as the rest of the lab). Do not expose `maps.${DOMAIN}` to the public
internet without a Traefik auth middleware or an identity-aware proxy.
`/tiles/` sends `Access-Control-Allow-Origin: *`, fine for a VPN-only host.

## Future: Hermes travel-time tool

A Hermes tool can call Valhalla from inside the Docker network at
`http://maps-valhalla:8002/route` (or `sources_to_targets` for a matrix) and
Pelias at `http://maps-pelias-api:4000/v1/search`, with no keys. That would
let Hermes answer "how long to X by car at this hour" for calendar and
reminder tasks. Those containers would need to be on a shared network with
Hermes; this is not wired up yet.

## Root README row

| Stack | Folder | Hostname | Homepage group |
|---|---|---|---|
| Maps (Greece tiles, routing, search) | `maps/` | `maps.${DOMAIN}` | Home |
