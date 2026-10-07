#!/bin/sh
set -eu

# The embedded WebUI scans its working directory when reporting capabilities.
# Starting in / makes it traverse Docker's protected /proc entries, causing the
# capability endpoint to fail before a generation request is submitted.
cd /outputs

# SD_MODEL is retained for complete, single-file checkpoints such as SD 1.5.
# Newer model families (including Z-Image) use a separate diffusion model and
# optional companion VAE/text-encoder files.
diffusion_model="${SD_DIFFUSION_MODEL:-${SD_MODEL:?Set SD_MODEL or SD_DIFFUSION_MODEL to a model file in ./models}}"

set -- /sd.cpp/bin/sd-server \
    --diffusion-model "/models/${diffusion_model}" \
    --backend "${SD_BACKEND:-vulkan0}" \
    --listen-ip 0.0.0.0 \
    --listen-port 1234

if [ -n "${SD_MAX_VRAM:-}" ]; then
    set -- "$@" --max-vram "vulkan0=${SD_MAX_VRAM}"
fi

if [ "${SD_AUTO_FIT:-false}" = "true" ]; then
    set -- "$@" --auto-fit
fi

if [ "${SD_STREAM_LAYERS:-false}" = "true" ]; then
    set -- "$@" --stream-layers
fi

if [ -n "${SD_VAE:-}" ]; then
    set -- "$@" --vae "/models/${SD_VAE}"
fi

if [ -n "${SD_LLM:-}" ]; then
    set -- "$@" --llm "/models/${SD_LLM}"
fi

exec "$@"
