# Memos

## Description

Lightweight notes and knowledge capture at `https://memos.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. The first account created in the browser becomes host administrator; review account-creation settings after setup.

## Backup and important notes

Back up `.env` and `data`, which contains both the database and uploaded content.
