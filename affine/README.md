# AFFiNE

Collaborative documents, whiteboards, and databases at `https://affine.${DOMAIN}`.

Copy `.env.example` to `.env`, replace `AFFINE_DB_PASSWORD`, ensure `webgateway` exists, and start with `docker compose --env-file .env up -d`. The migration job runs before the web container. Create the owner account in the browser on first launch.

AFFiNE has private PostgreSQL and Redis dependencies. Back up `.env`, `storage`, `config`, and `postgres`; `redis` is also persisted but is not a substitute for the PostgreSQL backup.
