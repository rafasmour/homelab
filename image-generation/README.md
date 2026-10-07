# Image Generation

This stack builds and runs [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)'s embedded WebUI and API with its Vulkan backend (`vulkan0`). It is published through Traefik at `https://stable-diffusion.<DOMAIN>`.

The service loads a model at startup. Set `SD_MODEL` for a complete checkpoint (such as SD 1.5). Models whose components are distributed separately, including Z-Image, use `SD_DIFFUSION_MODEL`, `SD_VAE`, and `SD_LLM`; all paths are relative to `./models`.

## Requirements

- Docker Engine with Docker Compose
- AMDGPU/Mesa Vulkan working on the host
- `/dev/dri` accessible to Docker
- An existing external Docker network named `webgateway`
- Traefik configured for `stable-diffusion.<DOMAIN>`

## Configure and start

Copy the template, set your domain, and select a model file:

```bash
cp .env.example .env
docker compose up -d
```

Place the model file in `models/` before starting. For example, to use Stable Diffusion v1.5:

```bash
curl -L -o models/sd-v1-5-pruned-emaonly.safetensors \
  https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors
```

Model files, generated images, and `.env` stay untracked.

### Z-Image / Z-Anime

`Z-Anime-8steps.q5_0.gguf` is only the diffusion model. It cannot be loaded with `SD_MODEL` on its own: it requires a Flux-compatible VAE and a Qwen3 4B Instruct text encoder. Put all three files in `models/`, then configure `.env` as follows (using the actual filenames you downloaded):

```dotenv
SD_MODEL=Z-Anime-8steps.q5_0.gguf
SD_DIFFUSION_MODEL=Z-Anime-8steps.q5_0.gguf
SD_VAE=ae.safetensors
SD_LLM=Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

The `SD_LLM` file must be a GGUF of the Qwen3 4B Instruct encoder intended for Z-Image, and the VAE must be compatible with Flux/Z-Image (commonly named `ae.safetensors`). Do not use an SD 1.x VAE or CLIP encoder for this model.

Stable Diffusion is available at:

```text
https://stable-diffusion.example.com
```

Open the WebUI and generate images with the selected model. The server also provides compatible APIs under `/v1/` and `/sdapi/v1/`.

To switch models, place the needed model file(s) in `models/`, update the relevant variables in `.env`, then rebuild and recreate the container after this configuration update:

```bash
docker compose up -d --build --force-recreate
```

No port is published directly on the host. Put authentication or IP access
controls in Traefik before making this UI available outside a trusted network.

For an 8 GB card, begin with a quantized model at 512×512 and increase resolution only after a successful run.

### Hybrid Vulkan/CPU memory budget

For an 8 GB GPU running Z-Image, reserve 1 GB for working and reference-image buffers. The following settings cap Vulkan at 7 GiB, run denoising and VAE on Vulkan, and run Z-Image conditioning/text-encoder computation on the CPU.

```dotenv
SD_BACKEND=diffusion=vulkan0,te=cpu,vae=vulkan0
SD_MAX_VRAM=7
SD_AUTO_FIT=false
SD_STREAM_LAYERS=false
```

This hybrid mode is slower than all-Vulkan inference, but it leaves GPU headroom for reference-image processing.

## Verify

Render the Compose configuration:

```bash
docker compose config
```

Check that the service is running and can see the Vulkan device:

```bash
docker compose exec stable-diffusion sh -lc 'ls -l /dev/dri'
```
