# Home Assistant

Assist for the phone's assistant button. Whisper transcribes speech, a conversation agent answers, and Piper speaks the final text.

- Home Assistant: `https://home-assistant.<DOMAIN>`
- Speech-to-text: Wyoming Whisper on the internal `backend` network
- Text-to-speech: Wyoming Piper on the internal `backend` network

The Hermes stack and `hermes_conversation` custom component were removed from this repository. Assist no longer routes through Hermes automatically.

## Requirements

- Docker Engine with Docker Compose
- The external `webgateway` network
- Traefik routing `home-assistant.<DOMAIN>`

## Configuration

```bash
cp .env.example .env
```

Replace placeholders in `.env`. No LLM API keys are injected by this stack anymore; configure the conversation backend inside Home Assistant (see below).

## Start

```bash
docker compose --env-file home-assistant/.env \
  -f home-assistant/docker-compose.yml config --quiet
docker compose --env-file home-assistant/.env \
  -f home-assistant/docker-compose.yml up -d
```

The first start creates `config/configuration.yaml` when missing. It does not create a user or disable login.

## Assist migration (after Hermes removal)

Previously, Assist used the Hermes **router** profile at `http://hermes-api:8642/p/router/v1`. That container is gone. Pick a new conversation agent:

### Option A — local llama.cpp (recommended)

The [`llama-cpp`](../llama-cpp/README.md) stack exposes an OpenAI-compatible API at `http://llama-server:8080/v1` on `webgateway`. Home Assistant's built-in OpenAI conversation integration only accepts `api.openai.com`, so use a community integration that supports a custom base URL (for example **Extended OpenAI Conversation** from HACS), or another OpenAI-compatible conversation provider you trust.

Point the integration at:

- Base URL: `http://llama-server:8080/v1` (from inside the Home Assistant container on `webgateway`)
- API key: any non-empty placeholder unless llama.cpp is authenticated
- Model: a id from `GET /v1/models` on llama.cpp

### Option B — chat UI only

- **Open WebUI:** [`openwebui`](../openwebui/README.md) is a browser chat UI on llama.cpp, not an Assist backend.

After adding a conversation agent:

1. Open **Settings > Voice assistants**, edit or create a pipeline.
2. Set STT to your Whisper entity, TTS to Piper, and **Conversation agent** to the new integration.
3. Turn **Prefer handling commands locally** off if you want every utterance to reach the LLM.
4. On Android, set the Action button to **Assist** and select that pipeline.

Remove stale Hermes entries:

- **Settings > Devices & services:** delete **Hermes Conversation** if it still appears.
- In `config/configuration.yaml`, remove a `hermes_conversation:` block if present, then restart Home Assistant.

## Wyoming speech services

Whisper and Piper run as Wyoming protocol servers on the internal network. Home Assistant discovers them when you add the Wyoming integration (or they may appear automatically depending on version).

## Backup

Back up `home-assistant/config/`, `home-assistant/whisper/`, `home-assistant/piper/`, and the local `.env`.
