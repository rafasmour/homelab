# n8n

Workflow automation at `https://n8n.${DOMAIN}`.

Copy `.env.example` to `.env`, set the database password and a permanent `N8N_ENCRYPTION_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the owner account in the browser. Never change the encryption key after credentials have been stored.

Back up `.env`, `data`, and a consistent copy or dump of `postgres`.
