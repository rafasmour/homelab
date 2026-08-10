# ChartDB

Browser-based database diagramming at `https://chartdb.${DOMAIN}`.

Copy `.env.example` to `.env`, optionally set `OPENAI_API_KEY`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. ChartDB has no local account system in this stack; protect it with Traefik authentication or an identity-aware proxy.

Diagrams are browser-local, so export important work from the application. There is no server-side bind-mounted state to back up.
