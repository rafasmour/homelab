# Repository guidelines

## Purpose and scope

This repository contains one Docker Compose stack per self-hosted service.
These instructions apply to the whole repository.

Preserve unrelated working-tree changes. Existing `.env` files and runtime
data belong to the user and must never be deleted, overwritten, printed, or
committed. When removing a service, remove only its tracked definition unless
the user explicitly authorizes deletion of its local data.

## Standard service-folder layout

Create new services in a lowercase, kebab-case folder:

```text
service-name/
├── docker-compose.yml
├── .env.example
└── .env                 # local and ignored; create only when requested
```

Use `docker-compose.yml` as the Compose filename. Do not add the obsolete
top-level Compose `version` field.

Additional static configuration may be committed when the image requires it:

```text
service-name/
├── config.yml
└── init/
    └── init.sh
```

Every additional tracked file and each of its parent folders must be explicitly
unignored in the root `.gitignore`.

## Docker Compose conventions

- Prefer the upstream project's official container image and current official
  deployment guidance. Pin a stable version when the upstream project
  recommends pinning; otherwise make the tag configurable through `.env`.
- Give every service a unique, descriptive `container_name`.
- Use `restart: unless-stopped` for long-running services.
- Do not publish a web application's HTTP port directly on the host. Attach
  only its web-facing container to the external `webgateway` network and let
  Traefik route to its internal port.
- Put databases, caches, migration jobs, and workers on an internal `backend`
  network. Do not attach dependencies to `webgateway`.
- Add health checks to databases and important dependencies when their image
  supports them. Use condition-based `depends_on` when startup ordering
  matters.
- Persist application state with an explicit bind mount under the service
  folder, such as `./data`, `./postgres`, or `./config`. Never commit generated
  state.
- Use named volumes only when a bind mount is unsuitable, such as a
  container-managed single-file cache.
- Declare the shared Traefik network exactly as:

  ```yaml
  networks:
    webgateway:
      external: true
      name: webgateway
  ```

## Traefik labels

Every browser-accessible service must follow the existing Excalidraw pattern:

```yaml
labels:
  traefik.enable: "true"
  traefik.docker.network: webgateway
  traefik.http.routers.service-name.rule: "Host(`service-name.${DOMAIN:?Set DOMAIN in .env}`)"
  traefik.http.routers.service-name.entrypoints: websecure
  traefik.http.routers.service-name.tls.certresolver: myresolver
  traefik.http.services.service-name.loadbalancer.server.port: "CONTAINER_PORT"
```

Keep router, middleware, and Traefik service names unique across the
repository. Set `traefik.docker.network` whenever a container joins more than
one network.

Do not add Traefik labels to databases, caches, workers, cron jobs, or migration
containers.

## Homepage labels

Add Homepage discovery labels to the same web-facing container:

```yaml
homepage.group: Group
homepage.name: Display Name
homepage.icon: dashboard-icons-slug
homepage.href: "https://service-name.${DOMAIN}"
homepage.description: Short description of the service.
```

Use a real Dashboard Icons slug when available. A supported `mdi-*`, `si-*`, or
`sh-*` icon is an acceptable fallback. Keep group names consistent with the
existing stacks.

Widgets are optional. When adding one, keep API tokens in `.env`, interpolate
them into labels, and never put a credential directly in Compose.

## Environment files and credentials

The tracked `.env.example` is the source of truth for every variable needed by
the stack.

- Include `DOMAIN=tomandjerry.mourou.dev`.
- Expose configurable database names, usernames, passwords, application
  secrets, administrator usernames, and administrator passwords when the
  upstream application supports them.
- Use obvious placeholders such as `CHANGE_ME`; never commit a real secret.
- Document the generation command and length or character restrictions beside
  secrets that require a specific format.
- In Compose, fail clearly for required values:

  ```yaml
  PASSWORD: "${PASSWORD:?Set PASSWORD in .env}"
  ```

- Use `${VARIABLE:-default}` only for safe, non-secret defaults.
- If a password is embedded in a URL or YAML block, document its encoding or
  character restrictions.
- Do not invent administrator variables that the application ignores. Explain
  first-run account creation in `.env.example` and `README.md` instead.
- A local `service-name/.env` may mirror the template with placeholder values,
  but it must remain ignored and must not be staged.

## Authentication and exposure

Call out services that do not provide their own authentication. Before exposing
an unauthenticated administrative UI or API publicly, recommend a Traefik
authentication middleware or an identity-aware proxy.

Do not weaken registration, authentication, or transport security merely to
make initial setup easier. If signups must temporarily remain enabled, expose a
clear `.env` switch and document that it should be disabled after creating the
owner account.

## `.gitignore` allowlist

The repository intentionally ignores everything with a leading `*`. A new
service will not appear in Git until it is explicitly allowlisted.

For a standard service, add its folder:

```gitignore
!service-name/
```

The shared rules already allow `docker-compose.yml` and `.env.example` inside
an allowlisted one-level service folder. Real `.env` files and all runtime data
remain ignored.

For any extra tracked file, unignore every ignored parent followed by the file:

```gitignore
!service-name/config/
!service-name/config/settings.yml
```

After editing `.gitignore`, confirm the intended files are visible and secrets
remain ignored:

```sh
git status --short
git check-ignore -v service-name/.env
git check-ignore -v service-name/data/example.db
```

## Documentation

Add every new stack to the table in `README.md`, including its folder, public
hostname, and Homepage group. Document:

- how its administrator account is created;
- special hardware or external dependencies;
- nonstandard published ports;
- authentication limitations;
- important backup paths; and
- any manual post-install command.

## Validation checklist

Before considering a new or changed stack complete:

1. Copy or create a local `.env` from `.env.example` and replace values only as
   needed for validation.
2. Render and validate Compose:

   ```sh
   docker compose --env-file service-name/.env \
     -f service-name/docker-compose.yml config --quiet
   ```

3. Confirm the web service has one Traefik exposure and one Homepage entry.
4. Confirm dependency containers are not exposed through Traefik.
5. Confirm every referenced public image and tag exists.
6. Run native validators for mounted configuration when available, such as
   `promtool check config` or Loki's `-verify-config=true`.
7. Run:

   ```sh
   git diff --check
   ```

8. Review `git status --short` and ensure no `.env`, database, cache, upload,
   model, log, or user-content file is included.
