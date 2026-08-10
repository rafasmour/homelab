# Invidious

Privacy-focused YouTube frontend at `https://invidious.${DOMAIN}`.

Copy `.env.example` to `.env`, replace all secrets, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Database tables are initialized on an empty PostgreSQL data directory. Register the `INVIDIOUS_ADMIN_USER` name in the browser to create its credentials.

The stack includes private PostgreSQL and Companion services. Back up `.env` and `postgres`; the named Companion cache can be rebuilt.
