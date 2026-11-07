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
| `LLAMA_REPO` | Git repository to build llama.cpp from; defaults to upstream `ggml-org/llama.cpp` |
| `LLAMA_REF` | Branch, tag or commit to build; `main` (or empty) builds the repository's default branch |

Idle sleep is the preset key `sleep-idle-seconds` (300 s in `[*]`; `ornith-1.5-9b-mtp` has `-1` and `load-on-startup = true`, so Hermes' model stays loaded and speech-gateway's warmer reloads it when the router is idle; the `hermes-api` plugin `prompt_prime` then re-evaluates the primed profile's system prompt + tool schemas (~39k tokens, ~29 s cold) into an idle slot, see `hermes/README.md` "Prompt priming"; the preset has 3 slots so Jarvis (Q4_K) fits beside it). It used to be the `SLEEP_IDLE_SECONDS` command-line option, which overrode every preset; the variable in an existing `.env` is now unused.

Slot reservation for the production preset `ornith-1.5-9b-mtp` (3 slots): a request is placed by longest-common-prefix similarity (`--slot-prompt-similarity` 0.10) unless it carries `id_slot`; the router forwards `id_slot` to the child (log `selected slot by id (N)`) and a busy slot defers the request (queue, no fallback to another slot). Slot 0 is reserved for the primed Hermes ai-assistant prompt, slot 1 for Hindsight, slot 2 for every other Hermes profile (see `hermes/README.md` "llama.cpp slot reservation"). Clients that cannot set it (Open WebUI direct connection, the n8n digest workflows) stay on similarity selection; Open WebUI can pin per model under Admin, Models, Advanced Params, custom parameter `id_slot` if Ornith is used there.

`MODEL_FILE` is not used by this router setup. Models are configured through
the preset file instead of a single `-m` or `-hf` argument.

Copy the complete router configuration template:

```bash
cp models/router-config.ini.example models/router-config.ini
```

Each INI section is a model alias accepted by the API. Paths are absolute
container paths under `/models/`. Vision is a separate `-vision` alias that
adds the `mmproj` projector, and the Qwen 3.8 speculative-decoding modes are
separate `-mtp` and `-dflash2` aliases. Ornith 1.5 9B and Qwen3.5-9B have
`-mtp` (built-in MTP layer) and `-dflash` (DFlash drafter) aliases too, and
`ocr-xiaomi-0` is the OCR preset for paperless-gpt. The router lists aliases
alphabetically in `/v1/models`, not in file order, so clients should name the
model explicitly; Hermes uses `qwen-3.6-35b-a3b`. The container runs as a
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
- Every MoE preset keeps attention, the KV cache and the experts of the later
  layers on the GPU and the experts of the first N layers in RAM with
  `n-cpu-moe`. N is the smallest value that brings the measured VRAM under
  about 17.6 GiB of the 19.98 GiB card (at least 2.4 GiB free), computed from
  the per-layer expert sizes in the GGUF tensor table; each preset's comment
  shows the math. The CPU-side experts (anonymous memory with dio, see below)
  stay at or below about 2 GiB: the host has 15 GiB of RAM, its 4 GiB of
  swap is already full, and the other stacks use about 7 GiB. The router's
  RAM per MoE preset (experts + `token_embd` + 2 GiB `cache-ram` + about
  1 GiB runtime) stays at or below about 5.5 GiB. Dense models stay fully on
  the GPU. Dense layers on the CPU also move
  their KV cache to RAM; an attempt to run Qwen 3.8 27B with 15-20 CPU layers
  at 262144 tokens exhausted RAM and swap and was OOM-killed, so that model
  stays fully on the GPU with a shorter context.
- Direct I/O is on for every preset: `load-mode = dio` in `[*]`, and no
  preset overrides it (since 2026-10-29). mmap (2026-10-28 to 10-29) needs the
  weights in the page cache during the upload; under RAM and swap pressure the
  kernel evicted them mid-load and the loader re-read them, so large loads
  hung (gemma-4-26b-a4b for 7 hours, gemma-4-31b-it-vision read 23 GB for an
  11.8 GB file) and every queued request waited behind them. dio reads the
  file once; CPU-side MoE experts become anonymous memory (at most about
  2 GiB). No mlock: `mmap+mlock` would pin the whole GGUF in RAM. In b11957
  `load-mode` (auto, none, mmap, mlock, mmap+mlock, dio) is the only loading
  option; there is no separate `--mlock` or `--no-mmap`.
- Thinking is on for every model that can think: `reasoning = on`, which in
  b11957 also sets the template's `enable_thinking` to true (Gemma 4 templates
  default it to off; Qwen and Spark default it to on). The old
  `chat-template-kwargs = {"enable_thinking":true}` line is deprecated and was
  removed from every preset on 2026-10-29. Flint's template has no
  thinking switch, so its preset sets nothing. `ocr-xiaomi-0` also sets
  `enable_thinking: true`: with `false` the template pre-closes an empty
  `<think>` block and the model then transcribed only the table; with `true`
  it closes the block at once and transcribes the page. No preset caps thinking with
  `reasoning-budget`.

| Alias | Model | KV, context per slot x slots | VRAM | Decode |
| --- | --- | --- | --- | --- |
| `ornith-1.5-9b` | Ornith 1.5 9B Q6_K, plain (no drafter; the ngram-mod drafter was dropped 2026-11-06) | f16, 64k x 3 | 12.74 GiB (13.01 peak) | ~60 tok/s; 110 tok/s total with 3 requests |
| `ornith-1.5-9b-dflash` | same + DFlash draft Q8_0 | q8_0, 64k x 3 (since 2026-11-03; was 4) | ~14.8 GiB alone (15.9 GB in use incl. other stacks), 18.0 GB with Jarvis Q4_K | ~60 tok/s; DFlash, `checkpoint-min-step` 2048 |
| `ornith-1.5-9b-q4-dflash` | Ornith 1.5 9B Q4_K_M (5.38 GiB) + official DFlash drafter Q8_0 (1.29 GiB); **production since 2026-11-07** | f16, 64k x 3 | 15.32 GiB after load, 15.79 GiB peak under 3 x ~30k parallel prefills (card 18.68 GiB with audio.cpp; q8_0 was 13.22-13.70) | ~53-60 tok/s; DFlash accepted 24% of drafts on prose |
| `mellum-2.1-thinking` | JetBrains Mellum 2.1 Thinking (MoE 12B, 2.5B active, Apache-2.0) Q5_K_M, fully on GPU | f16, 128k x 1 | 11.6 GiB (idle card baseline 0.03) | ~94 tok/s |
| `mellum-2.1-thinking-mtp` | same file + built-in MTP head (`draft-mtp`, n-max 2) | f16, 128k x 1 | 12.1 GiB | ~136 tok/s (1.45x; n-max 1: 131, 3: 130, 4: 112, 6: 97; 57% of drafts accepted at 2) |
| `ocr-xiaomi-0` | Xiaomi-OCR-0 Q6_K + BF16 projector (OCR) | f16, 16k x 2 | 1.77 GiB | ~210 tok/s, about 3 s per page |
| `gemma-4-31b-it` / `-vision` | Gemma 4 31B UD-IQ3_XXS | q8_0, 128k / 96k | 18.57 / 18.26 GiB | ~31 tok/s |
| `qwen-3.6-35b-a3b` | Qwen3.6 35B-A3B UD-IQ4_XS | q8_0, 128k x 1, `n-cpu-moe 3` (Hermes default) | ~17.35 GiB (est.; 18.39 measured fully on GPU) | ~69 tok/s fully on GPU |
| `qwen-3.8-27b` | Qwen3.8 27B Q4_0 | q8_0, 96k, fully on GPU | 18.45 GiB | ~31 tok/s |
| `qwen-3.8-27b-mtp` | Qwen3.8 27B Q4_0 + MTP draft | q8_0, 68k (0.6 GiB headroom) | 19.38 GiB | ~57 tok/s |

Removed 2026-11-03 to free disk: `flint-40b-a2.5b`, `gemma-4-12b-it-qat` and `gemma-4-26b-a4b` (with `-vision`), `qwen-3.5-9b` (with `-mtp` and `-dflash`), `ornith-1.5-9b-mtp`, `ling-3.0-tiny` and `spark-x2.6-4b`; the notes below still quote some of their measurements.

Rules behind these presets: every slot has more than 64k context; small models use f16 KV and as many slots as fit; larger models use f16 or q8_0 and never q4_0 (it made models misbehave). f16 KV is also much faster on ROCm flash attention: the since-removed Mellum 2.1 ran at ~44 tok/s with q8_0 and ~102 tok/s with f16. CPU-offloaded layers of a dense model cost more speed than shorter context (Qwen 3.8: 12 tok/s with 5 layers on the CPU, 31 fully on the GPU). `qwen-3.8-27b-dflash2` is disabled: with its draft it does not fit above 64k. Decode speeds are single short requests; VRAM and speed of the MoE presets with their new `n-cpu-moe` are estimates until re-measured. The GPU only runs these models, so presets may use up to ~19.5 GiB of the 20 GiB.

**Since the host crash of 2026-10-27** (a platform reset during a GPU
prefill; see `models/model-eval.md`), new presets stay at or below 17 GiB
**under load**, not only after loading: the HIP backend's buffer pool grows
by up to ~2 GiB during repeated long prefills and does not shrink (a 4 x 64k
`qwen-3.5-9b` measured 14.96 GiB after load and plateaued at 17.22 GiB). The
"peak" values above were sampled while three to eight 20-30k-token prompts
were prefilled in parallel. The new 9B presets also use `cache-ram = 1024`
(each 64k slot state is 0.8-1.5 GiB of host RAM and swap is nearly full).
Their decode speeds are 384-token essays with thinking on, measured before
the GPU clock and power limits of 2026-10-27; with several requests the
per-request speed drops but the total rises.

Speculative drafts on the 9B models (October 2026): the built-in MTP layer
gives Qwen3.5-9B about 1.3x for one request but costs throughput with three
(97 vs 107 tok/s total); for Ornith 1.5 9B it gives about 1.1x. The DFlash
drafters give a similar single-request gain but need one slot fewer. For
concurrency, use the plain presets; Ling-3.0-tiny gives by far the highest
total throughput.

## Pull and delete models through the router API

The router manages downloads itself (Ollama-style), and every request except `/health` needs `Authorization: Bearer $LLAMA_API_KEY`:

```bash
H="Authorization: Bearer $LLAMA_API_KEY"   # from llama-cpp/.env; also OPENAI_API_KEY in openwebui/.env
# pull (background download incl. mmproj / MTP / DFlash sidecars and a repo preset.ini)
curl -X POST https://ai.$DOMAIN/models -H "$H" -H 'Content-Type: application/json' \
  -d '{"model":"ggml-org/gemma-3-270m-it-GGUF:Q8_0"}'
curl -N https://ai.$DOMAIN/models/sse -H "$H"            # live download/load progress
curl https://ai.$DOMAIN/models -H "$H"                   # list: source preset|cache, status, can_remove
curl -X DELETE "https://ai.$DOMAIN/models?model=ggml-org/gemma-3-270m-it-GGUF:Q8_0" -H "$H"
```

- Downloads go to `models/cache` (`LLAMA_CACHE`, owned by the container user 999) and appear without a restart as `source: cache`.
- Downloaded models run with the `[*]` defaults of `router-config.ini`; give one a measured preset (see the table above) before relying on it for long contexts.
- Presets are never removable through the API (`can_remove: false`); delete their files by hand.
- Tested on build b11824: pull of a 279 MB model, chat, delete.

## Model downloads UI

`llama-models-ui` is a small web UI at `https://models.<DOMAIN>` (Homepage:
AI / "Model downloads") for the router API above. It searches Hugging Face for
GGUF repositories, lists each repository's quants with their sizes (split
`-0000N-of-0000M` parts are merged; `mmproj-*` projectors are listed
separately), and pulls the chosen quant with `POST /models
{"model":"<repo>:<quant>"}`. A "Local models" panel shows `GET /models`
(source, status) and relays `/models/sse` for live download progress.

- **Login:** `MODELS_UI_USERNAME` and `MODELS_UI_PASSWORD` in `.env`
  (generate the password with `openssl rand -base64 24`). The UI can fill the
  disk and delete models, so it always requires this login; sessions last
  7 days and end when the container restarts. Ten failed logins per address
  block it for 15 minutes.
- **API key:** the UI adds `LLAMA_API_KEY` server-side; the browser never
  receives it. It reaches the router as `http://llama-server:8080` over
  `webgateway` and has no other network.
- **Gated repositories:** set `HF_TOKEN` (read scope). The router performs the
  actual download, so it needs access too.
- **Downloads** land in `models/cache` (owned by the router, uid 999) and show
  up without a restart as `source: cache`. A projector is fetched with the
  quant automatically.
- **Delete** is offered only for models with `can_remove: true` (router
  downloads). Presets cannot be removed through the API; delete their files by
  hand.
- **Presets:** a pulled model runs with the `[*]` defaults of
  `router-config.ini` until a measured preset is added for it (see the table
  above).

Build and start only this service:

```bash
docker compose up -d --build llama-models-ui
```

## Download the model set

Use the explicit commands in [`models/downloads.md`](models/downloads.md).
Each command downloads only the files used by a router preset. Add `--dry-run`
before running a command to inspect its transfer size. The complete set is
approximately 120 GB.

## Start the router

Create the external network once if Traefik has not already created it:

```bash
docker network create webgateway
```

`llama-server` also joins `hermes-llm`, an internal network (no internet
egress) that this stack creates for the Hermes coding sandboxes. They reach
the router there as `http://llama-cpp:8080` and still need `LLAMA_API_KEY`.
Start this stack before any stack that uses `hermes-llm` as an external
network.

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
curl https://ai.example.com/v1/models -H "Authorization: Bearer $LLAMA_API_KEY"
```

Select a preset by passing its section name in the OpenAI-compatible `model`
field:

```bash
curl https://ai.example.com/v1/chat/completions \
  -H "Authorization: Bearer $LLAMA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chat-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Replace `example.com` and `chat-model` with the configured domain and preset
alias. Every request except `/health` needs
`Authorization: Bearer $LLAMA_API_KEY` (the router runs with `LLAMA_API_KEY`
from `.env`). Keep the key secret: it
also allows pulling and deleting models.

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
