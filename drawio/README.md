# draw.io

Self-hosted [diagrams.net/draw.io](https://github.com/jgraph/drawio) editor with the official [draw.io MCP tool server](https://github.com/jgraph/drawio-mcp) connected to Hermes.

- Editor: `https://drawio.<DOMAIN>`
- Hermes MCP endpoint: `http://drawio-mcp:8000/mcp` on the private shared Docker network

## Architecture

The browser editor uses JGraph's official `jgraph/drawio` image and is exposed only through Traefik. The private `mcp` service packages the official `@drawio/mcp` stdio tool behind a Streamable HTTP bridge for Hermes. `DRAWIO_BASE_URL` makes generated diagram links open in this self-hosted editor rather than `app.diagrams.net`.

The MCP endpoint has no host port or Traefik route. It is reachable only by containers attached to the `hermes-mcp` network, which is created by the Hermes stack.

## Configure and start

Start Hermes first so its Compose project creates `hermes-mcp`:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

Create the local environment file, validate, and start draw.io:

```bash
cp drawio/.env.example drawio/.env
docker compose --env-file drawio/.env -f drawio/docker-compose.yml config --quiet
docker compose --env-file drawio/.env -f drawio/docker-compose.yml up -d --build
```

Recreate the Hermes API so it registers and discovers the draw.io tools:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d api
docker compose --env-file hermes/.env -f hermes/docker-compose.yml exec api hermes mcp test drawio
```

Hermes exposes the discovered tools with the `mcp_drawio_*` prefix. Generated links open `https://drawio.<DOMAIN>` with the diagram encoded in the URL fragment; the fragment is not sent to the web server.

## Authentication and storage

draw.io is a client-side editor and does not provide an application login. This deployment exposes it publicly through Traefik, so add an authentication middleware or identity-aware proxy if access to the editor itself must be restricted.

The stack has no server-side user-data volume. Diagrams must be saved explicitly through the editor to the browser/device or a configured storage integration. Back up the resulting `.drawio` files wherever they are stored.
