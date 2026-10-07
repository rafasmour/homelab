# Mealie

## Description

Recipe and meal planning at `https://mealie.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Sign in with `ADMIN_EMAIL` and the upstream initial password `MyPassword`, then change it immediately. Set `ALLOW_SIGNUP=false` after creating the intended users.

## Backup and important notes

Back up `.env` and `data`, which contains the application database, recipes, and uploaded assets.
