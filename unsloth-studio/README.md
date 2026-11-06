# Unsloth Studio (AMD ROCm)

Fine-tuning workspace for the RX 7900 XT (gfx1100) at `https://unsloth.${DOMAIN}`.

- Image: official `unsloth/unsloth-rocm:<version>-studio` (PyTorch with ROCm 7.2, Unsloth,
  TRL, PEFT, ROCm bitsandbytes, triton-rocm). It includes Unsloth Studio (web UI, port
  8000, routed by Traefik) and JupyterLab with the Unsloth notebooks (port 8888, internal).
  Sources: <https://hub.docker.com/r/unsloth/unsloth-rocm>,
  <https://unsloth.ai/docs/get-started/install/docker>,
  <https://github.com/unslothai/unsloth/blob/main/docker/Dockerfile.studio-rocm>.
- Size: about 16.6 GB compressed to pull.
- No `HSA_OVERRIDE_GFX_VERSION` is set; gfx1100 is covered by the generic ROCm 7.2 wheels.

## Requirements

- Linux with the amdgpu driver; `/dev/kfd` and `/dev/dri` present.
- Group ids 44 (`video`) and 991 (`render`) are hardcoded in `group_add` for this host
  (same as `llama-cpp`). Check with `getent group video render` on another machine.
- `webgateway` network exists.

## Setup and first login

1. `cp .env.example .env`, then set `UNSLOTH_STUDIO_PASSWORD` and `JUPYTER_PASSWORD`
   (generate with `openssl rand -base64 18`). `scripts/setup-env.sh` can do this.
2. `docker compose --env-file unsloth-studio/.env -f unsloth-studio/docker-compose.yml up -d`
3. Open `https://unsloth.${DOMAIN}` and sign in as user `unsloth` with
   `UNSLOTH_STUDIO_PASSWORD`. The variable only seeds the first account; after that,
   change the password in Studio. If the account already exists, the env value is ignored.
   Access is limited by WireGuard (VPN-only); no extra Traefik authentication.
4. JupyterLab is not exposed: use `docker exec -it unsloth-studio bash`, or add a second
   Traefik router to port 8888 if you want it in the browser. It is password protected.

## Sharing the GPU with llama.cpp

The RX 7900 XT has 20 GiB VRAM and `llama-server` can hold up to about 17 GiB while a
model is loaded, so training and a loaded model do not fit together. Before training:

1. Check `docker exec llama-server sh -c 'ps -eo args'`: only PID 1 should remain, with no
   child `llama-server` process (the router unloads a model after 300 s idle,
   `SLEEP_IDLE_SECONDS`).
2. Do not send requests to llama.cpp (or Open WebUI/Hermes agents using it) during a run;
   that would reload a model and cause out-of-memory errors in one of the two.
3. If needed, stop it: `docker stop llama-server`, then `docker start llama-server` afterwards.

Host RAM is 15 GB: keep batch sizes, dataloader workers and `shm_size` (2 GB) modest and
prefer 4-bit QLoRA for models above about 4B parameters.

## Smoke test (GPU)

Run only when llama.cpp is idle (see above):

```sh
docker exec unsloth-studio python -c "import torch;print(torch.__version__, torch.version.hip, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
docker exec unsloth-studio python /workspace/smoke_test_rocm.py
```

The second command is upstream's check: a real 5-step 4-bit LoRA on a 1B model
(downloads it into `./huggingface`). Expected: `True` and `AMD Radeon RX 7900 XT`,
and a falling loss. `docker exec unsloth-studio rocm-smi` shows VRAM use.

## Backup and important notes

- Back up `.env`, `studio` (accounts, chats, projects, outputs) and `work` (your notebooks and
  trained adapters). `huggingface` is a re-downloadable cache.
- All four folders are git-ignored runtime data.
- Studio's GGUF chat uses a Vulkan llama.cpp inside the container and also takes VRAM.
