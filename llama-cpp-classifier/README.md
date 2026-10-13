# llama.cpp classifier router

CPU-only [`llama-server`](https://github.com/ggml-org/llama.cpp) in router mode
for decision models. The router loads a preset when a request names it and
unloads idle models after `SLEEP_IDLE_SECONDS`. Decision models such as Laya
answer through `POST /v1/systemone` in one forward pass.

The image is built from upstream llama.cpp without Vulkan or CUDA. Traefik
publishes the API at `https://classify.<DOMAIN>`; port 8080 is not published
on the host. This stack does not use the GPU router in
[`llama-cpp`](../llama-cpp/README.md).

## Requirements

- Docker Engine with Docker Compose
- An existing external Docker network named `webgateway`, used by Traefik
- One or more local decision-model GGUF files

No GPU or `/dev/dri` access is required.

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

Set `DOMAIN` to the base domain handled by Traefik.

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Creates the Traefik host rule `classify.<DOMAIN>` |
| `MAX_JOBS` | Parallel jobs used while compiling llama.cpp |
| `MAX_MODELS` | Maximum number of decision models loaded at once; least-recently-used models unload past this limit |
| `SLEEP_IDLE_SECONDS` | Unload a model after this many idle seconds |
| `LLAMA_REPO` | llama.cpp repository. Decision models need upstream `ggml-org/llama.cpp` |
| `LLAMA_REF` | llama.cpp tag or commit; defaults to `main` |

Copy the router configuration template:

```bash
cp models/router-config.ini.example models/router-config.ini
```

Each INI section is a model alias accepted by `/v1/systemone`. Paths are
absolute container paths under `/models/`. Command-line options override the
preset file. Compose passes `--n-gpu-layers 0`, and the image has no GPU
backend, so every preset stays on CPU. The supplied profile uses 8 threads and
an 8192-token context, which is the context length stored in
`ggml-org/Laya-GGUF`. `batch-size` and `ubatch-size` match that context because
an encoder must process every question in a request in one micro-batch.

The container runs as a non-root user, so model files must be readable by it.
GGUF files and the active `router-config.ini` are ignored by Git.

## Download models

Use the commands in [`models/downloads.md`](models/downloads.md). The initial
model is Laya 0.4B Q8_0, about 450 MB.

## Start the router

Create the external network once if Traefik has not already created it:

```bash
docker network create webgateway
```

Build and start the service:

```bash
docker compose up --build -d
docker compose logs -f llama-classifier
```

Check the effective Compose configuration with:

```bash
docker compose config
```

## Use the API

List configured models:

```bash
curl https://classify.example.com/v1/models
```

Select a preset with the `model` field. With several questions, keep the
combined token count within `ubatch-size`:

```bash
curl https://classify.example.com/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "laya",
    "state": "Customer message: I was charged twice for my order last week.",
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
          "billing": "payments, charges, refunds, invoices",
          "shipping": "delivery, tracking, lost or late parcels"
        }
      },
      "angry": {
        "type": "noul",
        "instructions": "Is the customer angry?"
      }
    }
  }'
```

Replace `example.com` with the configured domain. The first request for an
unloaded alias loads that model. Idle models unload on their own.

There is no administrator account. llama.cpp does not authenticate this API.
Configure access control in Traefik before exposing it outside a trusted
network.

## Update models or presets

After changing `models/router-config.ini` or adding a GGUF, refresh the router
without restarting the container:

```bash
curl -fsS 'https://classify.example.com/models?reload=1'
```

To build a different llama.cpp revision, update `LLAMA_REF` in `.env` and
rebuild:

```bash
docker compose build --no-cache llama-classifier
docker compose up -d
```

## Backup

Back up `.env` and `models/`. The server stores no other application state.
