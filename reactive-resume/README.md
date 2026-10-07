# Reactive Resume

## Description

Resume builder at `https://resume.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, replace the database password and `AUTH_SECRET`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the owner in the browser, then set `FLAG_DISABLE_SIGNUPS=true` and recreate the app unless public registration is intentional.

## Backup and important notes

Back up `.env`, `data`, and a consistent copy or dump of `postgres`. PDF generation is client-side and needs no Browserless service.
