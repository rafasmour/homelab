# Homepage

Service dashboard at `https://${DOMAIN}`.

Copy `.env.example` to `.env`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Homepage discovers `homepage.*` labels through a GET-only Docker socket proxy on a private network. It has no local login, so add Traefik authentication or an identity-aware proxy before public exposure.

Back up `.env` and `config`. `config/docker.yaml` is tracked; other locally generated configuration remains ignored.
