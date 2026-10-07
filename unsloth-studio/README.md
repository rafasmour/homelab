# Unsloth Studio

## Description

GPU-backed model training workspace at `https://unsloth.${DOMAIN}`.

## Setup

Install a supported NVIDIA GPU driver and NVIDIA Container Toolkit, copy `.env.example` to `.env`, set `JUPYTER_PASSWORD`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. The image is large and the container reserves 8 GB of shared memory.

## Backup and important notes

Back up `.env` and `work`. Model downloads outside the mounted work directory are container-local and may be lost when the container is replaced.
