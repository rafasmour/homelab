# Self-hosted services

Docker Compose stacks for Excalidraw, SilverBullet, Nextcloud, and Pi-hole.
The web applications join the existing external Traefik network
`webgateway` and are published through the `websecure` entrypoint with the
`myresolver` certificate resolver.

## Initial setup

The Traefik stack must be running and its network must already exist:

```sh
docker network inspect webgateway
```

Create the environment file for each new stack:

```sh
cp excalidraw/.env.example excalidraw/.env
cp silverbullet/.env.example silverbullet/.env
cp nextcloud/.env.example nextcloud/.env
```

Edit the copied files before starting the services. In particular, replace
all `CHANGE_ME` values with strong passwords. A password can be generated
with:

```sh
openssl rand -base64 32
```

Start a stack from the repository root:

```sh
docker compose --env-file excalidraw/.env -f excalidraw/docker-compose.yml up -d
docker compose --env-file silverbullet/.env -f silverbullet/docker-compose.yml up -d
docker compose --env-file nextcloud/.env -f nextcloud/docker-compose.yml up -d
```

## Local data

- SilverBullet notes are stored in `silverbullet/space`.
- Nextcloud application files and user data are stored in `nextcloud/html`.
- The Nextcloud MariaDB database is stored in `nextcloud/database`.
- Nextcloud Redis persistence is stored in `nextcloud/redis`.

These are bind-mounted host directories, not Docker-managed volumes. Back up
the directories together with each stack's uncommitted `.env` file.

The official Excalidraw self-hosted client is local-first: drawings are
stored in each user's browser, not in the Excalidraw container. Export
important drawings as `.excalidraw` files and back them up separately. The
official standalone image does not provide server-side storage or
collaboration.
