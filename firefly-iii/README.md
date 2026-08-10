# Firefly III

Personal finance management at `https://firefly.${DOMAIN}`.

Copy `.env.example` to `.env`, set every secret and `SITE_OWNER`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. The first user is created through the browser. A private MariaDB service stores the database and the cron container invokes Firefly III's daily task endpoint.

Back up `.env`, `database`, and `uploads` together. Prefer a consistent MariaDB dump or stop the stack before copying `database`.
