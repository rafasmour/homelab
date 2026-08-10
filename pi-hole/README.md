# Pi-hole

Network DNS filtering with its web interface at `https://pihole.${DOMAIN}`.

Copy `.env.example` to `.env`, replace both credentials, and run `docker compose --env-file .env up -d`. The container uses host networking so it can serve DNS without publishing Compose ports. Ensure host ports 53, 8080, and 8443 are available and route the public hostname to the configured Pi-hole HTTPS listener outside this stack.

Pi-hole authentication uses `WEBPASSWORD`; Homepage uses a separate app password in `API_TOKEN_FOR_HOMEPAGE`. Back up `.env` and `etc-pihole`.
