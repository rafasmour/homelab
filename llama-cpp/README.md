# llama.cpp model router

Dockerized [`llama-server`](https://github.com/ggml-org/llama.cpp) configured as
an OpenAI-compatible model router. Models are selected by the alias defined in
`models/router-config.ini` and loaded from the local `models/` directory.

The image builds llama.cpp with Vulkan support and is intended for an AMD GPU
available through `/dev/dri`. Traefik publishes the API at
`https://ai.<DOMAIN>`; port 8080 is not published directly on the host.

## Requirements

- Docker Engine with Docker Compose
- A working AMDGPU/Mesa Vulkan setup on the host
- Access to `/dev/dri` for Docker containers
- An existing external Docker network named `webgateway`, used by Traefik
- One or more local GGUF model files

## Configuration

Copy the environment template:

```bash
cp .env.example .env
```

Set `DOMAIN` to the base domain handled by Traefik. The remaining variables tune
the build and router behavior:

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Creates the Traefik host rule `ai.<DOMAIN>` |
| `MAX_JOBS` | Parallel jobs used while compiling llama.cpp |
| `MAX_MODELS` | Maximum number of loaded router models; use `1` on memory-constrained hosts |
| `SLEEP_IDLE_SECONDS` | Unload an idle model after this duration so another preset can load |
| `LLAMA_REF` | llama.cpp tag or commit to build; defaults to upstream `main` for current architecture support |

`MODEL_FILE` is not used by this router setup. Models are configured through
the preset file instead of a single `-m` or `-hf` argument.

Copy the complete router configuration template:

```bash
cp models/router-config.ini.example models/router-config.ini
```

Each INI section is a model alias accepted by the API. Paths are absolute
container paths under `/models/`. The template includes separate MTP and vision
aliases for Gemma because those modes cannot currently be combined in one
preset. The container runs as a non-root user, so model files must be readable
by it. GGUF files and the active `router-config.ini` are ignored by Git.

Router command-line options take precedence over model-preset options. Therefore
all model execution settings belong in `router-config.ini`: the `[*]` section
defines shared defaults and a model section can override them. A `ctx-size` of
`0` uses the context size stored in the model; set an explicit value on larger
model presets when they need a memory cap. The supplied profile uses Vulkan
Flash Attention, a unified quantized KV cache across four request slots, and 8
CPU generation threads for an 8-core Ryzen. Tune context, batch sizes, and GPU
layers to the available VRAM and model architecture.

The included performance profile is intended for an 8 GB
Vulkan GPU. Smaller models can use more context and full GPU offload; larger
MoE models keep selected expert layers in RAM through `n-cpu-moe` and use one
request slot. Every supplied alias reserves a 64K context for agent harnesses;
this significantly increases KV memory and makes the initial expert-offload
values starting points that must be tuned on the target host. The KAT Q4 file
is 21.2 GB before context and runtime allocations, so that alias is explicitly
best-effort and may swap heavily or fail to load.

The `granite-4.2-8b` preset follows IBM's recommended sampling values of
temperature `1.0` and top-p `0.95`. Granite defaults to thinking mode; clients
may select non-thinking or low-effort behavior through its chat-template
controls when supported. The `gemma-4-e2b-it` preset is text-capable. Its
optional multimodal projector is not downloaded or configured by this stack.

## Download the model set

Use the explicit commands in [`models/downloads.md`](models/downloads.md).
Each command downloads only the file used by a router preset. Add `--dry-run`
before running a command to inspect its transfer size. The complete set is
approximately 145 GB.

## Start the router

Create the external network once if Traefik has not already created it:

```bash
docker network create webgateway
```

Build and start the service:

```bash
docker compose up --build -d
docker compose logs -f llama-cpp
```

Check the effective Compose configuration with:

```bash
docker compose config
```

## Use the API

List the configured models:

```bash
curl https://ai.example.com/v1/models
```

Select a preset by passing its section name in the OpenAI-compatible `model`
field:

```bash
curl https://ai.example.com/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chat-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Replace `example.com` and `chat-model` with the configured domain and preset
alias. The llama.cpp server does not add authentication in this repository;
configure access control in Traefik before exposing it outside a trusted
network.

## Update models or presets

After changing `models/router-config.ini` or replacing a model, refresh the
router's model list without restarting the container:

```bash
curl -fsS 'https://ai.example.com/models?reload=1'
```

Replace `example.com` with the configured domain. Use the router endpoint
`/models`, rather than the OpenAI-compatible `/v1/models` endpoint. If a full
process restart is preferred, run:

```bash
docker compose restart llama-cpp
```

To build a different llama.cpp revision, update `LLAMA_REF` in `.env` and
rebuild:

```bash
docker compose build --no-cache llama-cpp
docker compose up -d
```
