# Open WebUI

Open WebUI provides a browser interface for the OpenAI-compatible API exposed
by [`llama-cpp`](../llama-cpp/README.md). In this repository it connects to
the `llama-server` container over the shared `webgateway` Docker network and is
published by Traefik at `https://webui.<DOMAIN>`.

## Requirements

- Docker Engine with Docker Compose
- The external Docker network `webgateway`
- A running `llama-cpp` stack reachable as `llama-server:8080`
- Traefik configured to route `webui.<DOMAIN>`

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

Set the following variables:

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Creates the Traefik host rule `webui.<DOMAIN>` |
| `OPENAI_API_KEY` | Value sent to the upstream OpenAI-compatible backend |
| `OPEN_WEBUI_IMAGE_TAG` | Open WebUI image tag; defaults to `main` |
| `ENABLE_SIGNUP` | Allows first-run owner creation; disable after setup |

`llama-cpp` does not enforce authentication by default, but Open WebUI still
expects an API key field for the OpenAI provider. Any non-empty placeholder is
sufficient unless the upstream API is later protected.

Authentication remains enabled. The first account registered becomes the
administrator. After creating it, set `ENABLE_SIGNUP=false` in `.env` and
restart the service. Until then, keep the hostname restricted to trusted users
or protect it with authentication at the Traefik layer.

## Start the service

Create the external network once if it does not already exist:

```bash
docker network create webgateway
```

Start the UI:

```bash
docker compose up -d
docker compose logs -f open-webui
```

Check the rendered Compose configuration with:

```bash
docker compose config
```

## Access the UI

Open:

```text
https://webui.example.com
```

Replace `example.com` with the configured domain.

## Backup

Back up `openwebui/data/`, which contains accounts, settings, and chat history,
together with the local `.env`. Stop the service or use an application-aware
database backup method to obtain a consistent copy.
