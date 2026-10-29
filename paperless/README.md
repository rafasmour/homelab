# Paperless-ngx and paperless-gpt

## Description

[Paperless-ngx](https://docs.paperless-ngx.com/) is the document system: OCR,
tags, correspondents, document types, custom fields and full-text search, at
`https://paperless.${DOMAIN}`. Nextcloud stays the file store: its `Scans/`
folder is the Paperless consume folder.

[paperless-gpt](https://github.com/icereed/paperless-gpt) at
`https://paperless-gpt.${DOMAIN}` suggests titles, tags, correspondents,
document types and dates with the local llama.cpp router, and can redo OCR
with a vision model. You review its suggestions before they are applied.

| Container | Image | Networks | Role |
| --- | --- | --- | --- |
| `paperless-ngx` | `ghcr.io/paperless-ngx/paperless-ngx:3.3.4` | backend, webgateway | Web UI, consumer, Tesseract OCR |
| `paperless-gpt` | `icereed/paperless-gpt:v0.31.0` | backend, webgateway | LLM suggestions and vision OCR (no login: reach it only over WireGuard) |
| `paperless-postgres` | `postgres:18` | backend | Database (health-checked) |
| `paperless-redis` | `valkey/valkey:9-alpine` | backend | Task broker (Redis-compatible, as upstream ships it) |
| `paperless-gotenberg` | `gotenberg/gotenberg:8.37` | backend | Office and e-mail to PDF |
| `paperless-tika` | `apache/tika:3.3.1.0` | backend | Text extraction from Office files |

`backend` is internal (no internet). Paperless needs egress through
`webgateway` once per container creation to install the Greek Tesseract
package.

Memory limits (the host has 15 GiB and is already tight): Paperless 2 GiB
(`PAPERLESS_MEM_LIMIT`), Gotenberg 1 GiB, Tika 768 MiB, Postgres 512 MiB,
paperless-gpt 512 MiB, Valkey 128 MiB. Idle use is far lower; Paperless peaks
at about 2 GiB while it OCRs. `PAPERLESS_TASK_WORKERS=1` and
`PAPERLESS_THREADS_PER_WORKER=2` process one document at a time, two pages in
parallel. If Paperless is OOM-killed on large scans, raise the limit before
raising the workers.

## Setup

1. Create the consume folder in Nextcloud as the user in `NEXTCLOUD_USER`
   (web UI: **New folder > Scans**), or from the shell:

   ```bash
   docker exec -u www-data nextcloud mkdir -p /var/www/html/data/pi.hole/files/Scans
   docker exec -u www-data nextcloud php occ files:scan --path="pi.hole/files/Scans"
   ```

   It must exist before Paperless starts; otherwise Docker creates it owned by
   root and Nextcloud does not know it.

2. Create `.env` and fill every `CHANGE_ME`:

   ```bash
   cp paperless/.env.example paperless/.env
   openssl rand -hex 24   # PAPERLESS_DB_PASSWORD
   openssl rand -hex 32   # PAPERLESS_SECRET_KEY
   openssl rand -base64 24   # PAPERLESS_ADMIN_PASSWORD
   ```

   Copy `LLAMA_API_KEY` from `llama-cpp/.env`. Leave `PAPERLESS_GPT_API_TOKEN`
   as is for now. Set `PAPERLESS_GPT_OCR_MODEL` to the router's OCR preset
   (see below).

3. Validate and start Paperless without paperless-gpt:

   ```bash
   docker compose --env-file paperless/.env -f paperless/docker-compose.yml config --quiet
   docker compose --env-file paperless/.env -f paperless/docker-compose.yml up -d paperless-ngx
   docker compose --env-file paperless/.env -f paperless/docker-compose.yml logs -f paperless-ngx
   ```

   The first start installs `tesseract-ocr-ell`, runs the migrations and
   creates the admin user. Wait until the container is healthy.

4. Create an API token for paperless-gpt, put it in `PAPERLESS_GPT_API_TOKEN`,
   and start the rest:

   ```bash
   docker compose --env-file paperless/.env -f paperless/docker-compose.yml \
     exec paperless-ngx python3 manage.py drf_create_token admin
   docker compose --env-file paperless/.env -f paperless/docker-compose.yml up -d
   ```

   (Or in the web UI: profile menu > **My Profile** > API Auth Token.)

5. Install the Nextcloud rescan cron job (see below).

## First-run administrator

`PAPERLESS_ADMIN_USER` and `PAPERLESS_ADMIN_PASSWORD` create the superuser on
the first start. Paperless never changes an existing user from these values,
so change the password later in the web UI. Self sign-up stays disabled
(upstream default). Create further users in **Settings > Users & Groups**.

## Nextcloud consume flow

Drop or scan a file into Nextcloud `Scans/` (web, desktop client, mobile app
or a scanner that uploads over WebDAV). Paperless polls the folder every
`PAPERLESS_CONSUMER_POLLING_INTERVAL` seconds (30), waits until the file has
not changed for 10 s, imports it and **deletes it from `Scans/`**. The
original is kept in Paperless (`./media`). Office files (`.docx`, `.xlsx`,
`.odt`, ...) go through Tika and Gotenberg; e-mails (`.eml`) through
Gotenberg's Chromium with JavaScript disabled.

How it is wired:

- `paperless-ngx` bind-mounts
  `${NEXTCLOUD_DATA_DIR}/${NEXTCLOUD_USER}/files/${NEXTCLOUD_CONSUME_FOLDER}`
  (default `../nextcloud/html/data/pi.hole/files/Scans`) as
  `/usr/src/paperless/consume`. No change to the Nextcloud stack is needed.
- Polling instead of inotify: events across a bind mount written by another
  container are unreliable.
- Paperless runs as UID/GID 33 (`PAPERLESS_USERMAP_UID/GID`), the `www-data`
  owner of the Nextcloud data. This matters: Paperless's start-up script
  chowns every file in its consume folder to its own UID, so any other UID
  would take the files away from Nextcloud. The side effect is that `./data`,
  `./media` and `./export` are owned by 33:33 on the host; use `sudo` to read
  them.
- Nextcloud upload temp files (`*.part`, `.ocTransferId*`) and LibreOffice
  lock files are ignored. Subfolders are consumed too
  (`PAPERLESS_CONSUMER_RECURSIVE`); set
  `PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true` to turn `Scans/Bills/x.pdf` into
  the tag `Bills`.
- Do not enable Nextcloud server-side encryption: Paperless would read
  encrypted blobs. (It is disabled today.)

Why not Nextcloud external storage pointing at `./consume`? It needs the
`files_external` app (disabled here), a mount of `./consume` into the
Nextcloud containers and the same UID alignment, so it adds pieces without
removing the cache problem below.

### Keeping Nextcloud's file cache correct

Nextcloud does not see files that disappear behind its back, so after
Paperless deletes a document it would still list it in `Scans/` (opening it
fails). Rescan the folder every 5 minutes from the repository owner's crontab
(`crontab -e`; the user is in the `docker` group):

```cron
*/5 * * * * docker exec -u www-data nextcloud php occ files:scan --path="pi.hole/files/Scans" --quiet
```

Replace `pi.hole` with `NEXTCLOUD_USER`. The scan only walks `Scans/` and is
cheap. Run the same command by hand to fix the listing immediately.

Alternative without cron: `docker exec -u www-data nextcloud php occ
config:system:set filesystem_check_changes --value=1 --type=integer` makes
Nextcloud check modification times whenever a folder is opened. It is global
and costs a stat per folder access, so the scoped cron job is preferred.

## Greek OCR

Tesseract is the baseline OCR for every document:
`PAPERLESS_OCR_LANGUAGE=ell+eng` (Greek and English; Tesseract picks the best
match per word) and `PAPERLESS_OCR_LANGUAGES=ell`, which installs the Debian
package `tesseract-ocr-ell` at container start, because the image ships only
English, German, French, Italian and Spanish. The install runs again whenever
the container is recreated (not on a plain restart) and needs internet. Check
it in the log line `[init-tesseract-langs] Installed tesseract-ocr-ell`.
Dates are parsed day first (`PAPERLESS_DATE_ORDER=DMY`).

## paperless-gpt: tags and review flow

paperless-gpt polls Paperless every few seconds for documents with these
tags:

| Tag | Effect |
| --- | --- |
| `paperless-gpt` (`PAPERLESS_GPT_MANUAL_TAG`) | Listed in the paperless-gpt UI. You generate suggestions, edit them and apply them per document. Nothing changes until you click apply. |
| `paperless-gpt-ocr-auto` (`PAPERLESS_GPT_OCR_TAG`) | Vision OCR of the first `PAPERLESS_GPT_OCR_LIMIT_PAGES` pages (5); the result replaces the document's text content. The original file and Paperless's archive PDF are untouched (`PDF_UPLOAD=false`); Paperless can re-run Tesseract (**Reprocess**) if the vision text is worse. paperless-gpt logs its runs and keeps change history in `./gpt/db`. |
| `paperless-gpt-auto` (`PAPERLESS_GPT_AUTO_TAG`) | Applies suggestions **without review**. Do not use it in workflows. |
| `paperless-gpt-failed` | Set when processing failed repeatedly; the document is no longer retried. |

Recommended setup:

1. In Paperless, create a workflow: trigger **Document Added**, action
   **Assign tag `paperless-gpt`**. Every new document then lands in the
   review queue at `https://paperless-gpt.${DOMAIN}`.
2. Keep Tesseract's text for normal scans. Add `paperless-gpt-ocr-auto` by
   hand only to documents whose Tesseract text is poor (photos, faded
   receipts, handwriting), then review the new content.
3. New tags are never invented by the model (`CREATE_NEW_TAGS=false`); it
   picks from your existing tags, correspondents and document types, so
   create those first. Prompts are in Greek context
   (`PAPERLESS_GPT_LANGUAGE=Greek`) and editable under **Settings** in the UI
   (`./gpt/prompts`).

**Authentication:** paperless-gpt has no login of its own (upstream README,
"Security"): anyone who reaches it can rewrite documents and run model jobs.
By the owner's choice it has no Traefik auth middleware, so keep
`paperless-gpt.${DOMAIN}` reachable only over WireGuard (no public port
forward). If it is ever exposed beyond the VPN, add a Traefik basicAuth or
forward-auth middleware first. Paperless-ngx itself has normal user accounts.

## llama.cpp: one model at a time

paperless-gpt talks to the router at `http://llama-server:8080/v1` (over
`webgateway`) with `LLAMA_API_KEY`:

- `PAPERLESS_GPT_LLM_MODEL` (default `qwen-3.6-35b-a3b`, the Hermes model)
  for metadata;
- `PAPERLESS_GPT_OCR_MODEL` for vision OCR. Use a vision preset (one with an
  `mmproj`) from `llama-cpp/models/router-config.ini`; the OCR model
  evaluation is tracked in `llama-cpp/models/model-eval.md`. Dedicated OCR
  models (Chandra, PaddleOCR-VL, ...) expect their own prompt; adjust the OCR
  prompt in the paperless-gpt UI if the output is chatty or truncated.

The router runs with `--models-max 1`: it holds one GPU model at a time.
Every paperless-gpt call to a model other than the loaded one unloads it, so
a vision OCR job evicts Hermes's model and the next Hermes request has to
reload it (and the reverse). paperless-gpt is therefore set to process
sequentially (`SUGGESTION_WORKERS=1`, the background loop handles one
document at a time) and paced at `PAPERLESS_GPT_REQUESTS_PER_MINUTE=20`.
Metadata suggestions use the same model as Hermes and do not cause swaps.

Prefer batch runs for vision OCR: tag a batch of documents with
`paperless-gpt-ocr-auto` at a quiet time (evening) rather than one at a time
during the day, or wait for the planned `--models-max 2`, which can keep the
OCR model and the agent model loaded together.

## Backups

Back up `.env`, `./data` (search index, classifier, settings), `./media`
(originals and archive PDFs), `./gpt` (prompts, settings, undo history) and a
consistent copy of `./postgres` (stop the stack, or use `pg_dump`):

```bash
docker exec paperless-postgres pg_dump -U paperless paperless > paperless.sql
```

The portable, version-independent backup is Paperless's exporter, written to
`./export`:

```bash
docker compose --env-file paperless/.env -f paperless/docker-compose.yml \
  exec -T paperless-ngx document_exporter ../export --delete
```

It contains every document plus a `manifest.json` with all metadata and can
be restored into an empty instance with `document_importer ../export`.
`./redis` is a task queue and needs no backup. Files waiting in `Scans/` are
part of the Nextcloud backup.

## Migrating from Google Drive

Copy Drive into Nextcloud with [rclone](https://rclone.org/), then move the
paperwork into `Scans/` for Paperless.

1. In Nextcloud create an app password (**Settings > Security > Devices &
   sessions**) and configure two remotes with `rclone config`:

   - `gdrive`: type `drive`, scope `drive.readonly`;
   - `nc`: type `webdav`, vendor `nextcloud`, URL
     `https://nextcloud.lab.rafasmour.com/remote.php/dav/files/pi.hole/`,
     user `pi.hole`, password = the app password (rclone obscures it).

2. Copy everything, exporting Google Docs, Sheets and Slides as Office files
   (PDF for types without an Office format):

   ```bash
   rclone copy gdrive: nc:GoogleDrive \
     --drive-export-formats docx,xlsx,pptx,pdf \
     --transfers 4 --checkers 8 --progress
   rclone copy gdrive: nc:GoogleDrive/Shared-with-me \
     --drive-shared-with-me \
     --drive-export-formats docx,xlsx,pptx,pdf --progress
   ```

3. Re-run the same commands until the cutover: `copy` only transfers new and
   changed files, so later runs are incremental. Use `rclone check` (add
   `--one-way`) to compare before you stop using Drive. Never use `sync`
   towards Drive.

4. Move bills, letters, contracts and other paperwork from
   `GoogleDrive/` into `Scans/` in Nextcloud (web UI move, or
   `rclone move nc:GoogleDrive/Λογαριασμοί nc:Scans/Λογαριασμοί`).
   Paperless consumes and deletes them; everything else stays in Nextcloud.
   Move them in batches of a few dozen: OCR is CPU-bound with one worker.

The rclone copies arrive through WebDAV, so Nextcloud indexes them normally.

## Later: semantic search

Paperless's full-text search covers exact words. A planned "doc-search"
service adds meaning-based search: it reads documents through the Paperless
API, splits them into chunks, embeds them with EmbeddingGemma 2 on the CPU
`llama-cpp-classifier` router, stores the vectors in pgvector, and exposes an
MCP tool for Hermes. It is not part of this stack yet.
