# Databases

Shared database servers for the homelab stacks, set up on 2026-11-13 to cut RAM
use (one Postgres instead of four, tuned for a 15 GB host).

| Container | Image | Serves | Address |
| --- | --- | --- | --- |
| `postgres` | `ghcr.io/immich-app/postgres:17-vectorchord0.4.3-pgvector0.8.1` | immich, wger (+ PowerSync), n8n, hindsight | `postgres:5432` |
| `mariadb` | `mariadb:lts` | Nextcloud | `mariadb:3306` |

Both sit only on the internal `databases` network (`internal: true`, no
internet, no published ports). Each app stack joins it as an external network,
so **start this stack first**:

```bash
docker compose --env-file databases/.env -f databases/docker-compose.yml up -d
```

## Postgres

One database and one owner role per app; no app role is a superuser, and
`CONNECT` on each database is revoked from `PUBLIC`.

| Database | Owner role | Password comes from | Extensions (created by `postgres`) |
| --- | --- | --- | --- |
| `immich` | `immich` | `immich/.env` `DB_PASSWORD` | vector, vchord, uuid-ossp, unaccent, cube, earthdistance, pg_trgm |
| `wger` | `wger` (REPLICATION, for PowerSync) | `wger/.env` `POSTGRES_PASSWORD` | btree_gin, pg_trgm |
| `wger` schema `powersync` | `powersync_storage` | `wger/.env` `POWERSYNC_STORAGE_PASSWORD` | |
| `n8n` | `ascmaspcoamsc` (`n8n/.env` `POSTGRES_USER`) | `n8n/.env` `POSTGRES_PASSWORD` | uuid-ossp |
| `hindsight` | `hindsight` | `hindsight/.env` `HINDSIGHT_DB_PASSWORD` | vector, pg_trgm, btree_gin |

The immich image is used because it ships VectorChord (`vchord`, preloaded)
and pgvector. Its config file is kept (`config_file=/etc/postgresql/postgresql.conf`)
and the memory settings are overridden on the command line:
`shared_buffers=256MB`, `work_mem=8MB`, `maintenance_work_mem=128MB`,
`max_connections=150`, `max_parallel_workers_per_gather=0`, `jit=off`,
`max_wal_size=1GB`, plus `wal_level=logical` for wger's PowerSync.

Because the app roles are not superusers, extensions must be created by
`postgres`. After an immich upgrade that bumps VectorChord, update it by hand:

```bash
docker exec postgres psql -U postgres -d immich -c 'ALTER EXTENSION vchord UPDATE'
```

Changing an app's DB password: change it in the app's `.env` and run
`ALTER ROLE <role> PASSWORD '...'` here.

## MariaDB

Nextcloud's database, moved from `nextcloud/database` (copied with the server
stopped). `nextcloud/html/config/config.php` has `'dbhost' => 'mariadb'`.
`innodb_buffer_pool_size=128M`, `max_connections=60`, performance schema off.
The root password is `MARIADB_ROOT_PASSWORD` in `.env` (same as Nextcloud's old
`MYSQL_ROOT_PASSWORD`); the `nextcloud` user and its password live in the data.

## Backups

```bash
bin/lab db dump immich|wger|n8n|hindsight|nextcloud [FILE]
```

## Old per-stack data (rollback)

The previous database folders are still on disk and untouched:
`immich/postgres` (PG 14), `wger/postgres` (PG 15), `n8n/postgres` (PG 16),
`hindsight/postgres` (PG 17), `nextcloud/database` (MariaDB). To roll a stack
back, restore its `docker-compose.yml` database service from Git, point the app
at it again and start it. Delete the old folders once the new setup has run
without problems for a while.
