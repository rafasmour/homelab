# llama.cpp model router

Dockerized [`llama-server`](https://github.com/ggml-org/llama.cpp) configured as
an OpenAI-compatible model router. Models are selected by the alias defined in
`models/router-config.ini` and loaded from the local `models/` directory.

The image builds llama.cpp with the ROCm/HIP backend for an RDNA3 AMD GPU
(`gfx1100`, RX 7900 XT/XTX/GRE) with rocWMMA flash attention, using
`/dev/kfd` and `/dev/dri`. Traefik publishes the API at
`https://ai.<DOMAIN>`; port 8080 is not published directly on the host.

## Requirements

- Docker Engine with Docker Compose
- An RDNA3 AMD GPU with the in-kernel `amdgpu` driver (ROCm userspace is
  provided by the image; no host ROCm install is needed)
- Access to `/dev/kfd` and `/dev/dri` for Docker containers; the Compose file
  adds the host `video` (44) and `render` (991) group IDs, so adjust them if
  `getent group video render` differs on your host
- For Navi 32/33 cards, change the `AMDGPU_TARGETS` build argument in the
  `Dockerfile` to `gfx1101` or `gfx1102`
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
| `MAX_JOBS` | Parallel jobs used while compiling llama.cpp; empty uses every CPU thread, set a number if the build runs out of RAM |
| `MAX_MODELS` | Maximum number of loaded router models; use `1` on memory-constrained hosts |
| `SLEEP_IDLE_SECONDS` | Unload an idle model after this duration so another preset can load |
| `LLAMA_REPO` | Git repository to build llama.cpp from; defaults to upstream `ggml-org/llama.cpp` |
| `LLAMA_REF` | Branch, tag or commit to build; `main` (or empty) builds the repository's default branch |

`MODEL_FILE` is not used by this router setup. Models are configured through
the preset file instead of a single `-m` or `-hf` argument.

Copy the complete router configuration template:

```bash
cp models/router-config.ini.example models/router-config.ini
```

Each INI section is a model alias accepted by the API. Paths are absolute
container paths under `/models/`. Vision is a separate `-vision` alias that
adds the `mmproj` projector, and the Qwen 3.8 speculative-decoding modes are
separate `-mtp` and `-dflash2` aliases. The router lists aliases
alphabetically in `/v1/models`, not in file order, so clients should name the
model explicitly; Hermes uses `mellum-2.1-12b-a2.5b`. The container runs as a
non-root user, so model files must be readable by it. GGUF files and the
active `router-config.ini` are ignored by Git.

Router command-line options take precedence over model-preset options, so all
model execution settings belong in `router-config.ini`: the `[*]` section
defines shared defaults and a model section can override them.

### GPU profile and VRAM budget

The presets target an RX 7900 XT (20 GiB VRAM, ROCm) in a host with 15 GB of
RAM and an 8-core Ryzen 7 1800X:

- Each preset uses at most about 16 GiB of VRAM for weights, KV cache and
  compute buffers, measured with
  `cat /sys/class/drm/card1/device/mem_info_vram_used` after a tiny request.
  The rest stays free for the desktop and other GPU users.
- `ctx-size` is the model's native `context_length` from the GGUF, capped at
  262144. `parallel = 1` gives the single slot the whole context.
- The KV cache is `q8_0`, or `q4_0` where `q8_0` does not fit. Flash
  attention is on.
- `fit = off` with explicit `n-gpu-layers`/`n-cpu-moe`: `--fit` would
  otherwise grow into all free VRAM.
- MoE presets keep the experts of the first N layers in RAM with `n-cpu-moe`.
  CPU-resident experts stay at or below about 6 GB, because the other stacks
  already use about 7.5 GB of the 15 GB. Dense layers on the CPU also move
  their KV cache to RAM; an attempt to run Qwen 3.8 27B with 15-20 CPU layers
  at 262144 tokens exhausted RAM and swap and was OOM-killed, so that model
  stays fully on the GPU with a shorter context.
- `load-mode = dio` reads GGUFs with Direct I/O instead of mmap.

| Alias | File | Notes |
| --- | --- | --- |
| `mellum-2.1-12b-a2.5b` | Mellum 2.1 Thinking Q6_K | Hermes default; 131072 ctx |
| `flint-40b-a2.5b` | Flint UD-Q3_K_XL | MoE, `n-cpu-moe`; no Q4 fits |
| `gemma-4-12b-it-qat` (`-vision`) | Gemma 4 12B QAT UD-Q4_K_XL | 262144 ctx |
| `gemma-4-26b-a4b` (`-vision`) | Gemma 4 26B-A4B Q4_0 | MoE, `n-cpu-moe` |
| `gemma-4-31b-it` (`-vision`) | Gemma 4 31B UD-IQ3_XXS | dense, `q4_0` KV |
| `hy-memory-30b-a3b` | Hy-Memory 30B-A3B Q3_K_M | MoE, `q4_0` KV, no-think |
| `lfm-2.5-8b-a1b` | LFM2.5 8B-A1B Q4_K_M | 128000 ctx |
| `lfm-2.5-24b-a2b` | LFM2.5 24B-A2B Q4_K_M | 131072 ctx |
| `minicpm5-2b` | MiniCPM5 2B Q8_0 | 131072 ctx |
| `qwen-3.6-35b-a3b` | Qwen3.6 35B-A3B UD-IQ4_XS | MoE, `n-cpu-moe` |
| `qwen-3.8-27b` (`-mtp`, `-dflash2`) | Qwen3.8 27B Q4_0 + drafts | dense, `q4_0` KV, shorter ctx |
| `spark-x2.6-4b` | Spark-X2.6 4B Q8_0 | 262144 ctx (native 1M) |

## Download the model set

Use the explicit commands in [`models/downloads.md`](models/downloads.md).
Each command downloads only the files used by a router preset. Add `--dry-run`
before running a command to inspect its transfer size. The complete set is
approximately 150 GB.

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

## Use the llama.cpp command-line tools

The image contains every llama.cpp binary (`llama-cli`, `llama-bench`,
`llama-quantize`, `llama-perplexity`, `llama-gguf-split`, ...). `llama-server`
remains the entrypoint of the `llama-cpp` service, so the router keeps running
behind Traefik unchanged.

The `llama-tools` service (Compose profile `tools`) runs the same image as a
one-off container with GPU access and `/models` mounted, but without Traefik
or Homepage labels and without joining `webgateway`. It never starts with a
plain `docker compose up`:

```bash
docker compose run --rm llama-tools                # list available tools
docker compose run --rm llama-tools llama-cli -m /models/<path>.gguf -ngl 99
docker compose run --rm llama-tools llama-bench -m /models/<path>.gguf
```

For a quick command inside the already running router container, use
`docker exec -it llama-server llama-cli ...` instead. Both share the GPU with
the router, so a model loaded by the router reduces the VRAM available to a
tool; stop or idle-unload the router model first for large runs.

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
