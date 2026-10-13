# Pi-hole

## Description

Network DNS filtering with its web interface at `https://pihole.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set `PIHOLE_BIND_IP` to the Docker host's LAN address and `PIHOLE_WIREGUARD_BIND_IP` to its WireGuard address, replace both credentials, and run `docker compose --env-file .env up -d`. TCP and UDP port 53 are published only on those two addresses; the web interface is exposed through Traefik on the external `webgateway` network and is not published directly on the host.

Bring `wg0` up before this stack. Docker binds DNS to `PIHOLE_WIREGUARD_BIND_IP` at container start. If that address is missing, the daemon fails with exit 255 (`cannot assign requested address`) and does not retry, even with `restart: unless-stopped`. After WireGuard is assigned, recreate:

```bash
docker compose --env-file .env up -d --force-recreate
```

## Backup and important notes

Pi-hole authentication and the Homepage widget both use the double-hashed `WEBPASSWORD`. Back up `.env` and `etc-pihole`.
