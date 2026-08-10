# Nextcloud

File sync and collaboration at `https://nextcloud.${DOMAIN}`.

Copy `.env.example` to `.env`, replace both database passwords, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the administrator in the first-run browser wizard. The private MariaDB and Redis services must be healthy before Nextcloud starts; the cron service handles background jobs.

Back up `.env`, `html`, and a consistent MariaDB dump or stopped copy of `database`. `redis` is a cache and is not a substitute for the database backup.
