# Nextcloud

## Description

File sync and collaboration at `https://nextcloud.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, replace both database passwords, ensure `webgateway` exists, and run `docker compose --env-file .env up -d`. Create the administrator in the first-run browser wizard. The private MariaDB and Redis services must be healthy before Nextcloud starts; the cron service handles background jobs.

## Hermes MCP integration

The `mcp` service runs the official [Nextcloud MCP Server](https://github.com/cbcoutinho/nextcloud-mcp-server) in single-user mode. It is reachable only by containers attached to the `hermes-mcp` network and has no host port or Traefik route.

Create a dedicated Nextcloud account with access only to the content Hermes should manage. While signed in as that account, create an app password under **Settings > Security > Devices & sessions**, then set `NEXTCLOUD_MCP_USERNAME` and `NEXTCLOUD_MCP_APP_PASSWORD` in the ignored `.env`. Do not use the account's normal login password.

Start the Hermes stack before this stack. Hermes creates the shared network, while this Compose file references it as external:

```bash
docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
```

Hermes connects to `http://nextcloud-mcp:8000/mcp` from the default profile and from the dedicated `nextcloud` profile. Recreate `hermes-api` after this service is healthy so the new network attachment is applied and Hermes discovers the tools.

`NEXTCLOUD_MCP_VERSION` is pinned to `0.198.5`. That release percent-encodes calendar names in CalDAV URLs. Image `0.184.2` concatenated the name raw, so a name containing a space failed in the client with `URL must not contain spaces` and never reached Nextcloud.

## Calendars and tasks

Calendar tools take the CalDAV URI, the `name` returned by `nc_calendar_list_calendars`, not the display name. None of these URIs contain a space. `nc_calendar_list_calendars` does not report supported components; this is the live set for user `pi.hole`:

| URI `name` | Display name | Components |
| --- | --- | --- |
| `personal` | Personal | VEVENT |
| `contact_birthdays` | Contact birthdays | VEVENT |
| `tasks` | Home | VTODO |
| `homelab` | Homelab | VTODO |
| `personal-1` | Personal | VTODO |
| `1` | Δουλειά | VTODO |
| `b6a389ce-2287-4789-b2c9-133f95ed7b4f` | Γάμος | VTODO |
| `8d0ef9c7-fe8e-4560-a03a-ea19eb1f397a` | Π Ηλίας | VTODO |
| `a4ce1ab1-3fdc-4e90-b5fc-6f6f203915ea` | Αγ. Παρασκευή | VTODO |

`tasks` accepts only VTODO. `nc_calendar_create_event` on it returns Forbidden. That is the component type; the app password is valid. Put tasks and task reminders on `tasks` with `nc_calendar_create_todo`. Put timed events and event alarms on `personal` with `nc_calendar_create_event`. `personal-1` is a different calendar that shares the display name Personal and accepts only VTODO. Leave `contact_birthdays` for generated birthdays. Deleted collections `tasks-1` and `-` are not in the tool's calendar list.

The Nextcloud profile soul in `hermes/start-with-forage.sh` is written only when that profile does not already exist. An existing profile keeps the `SOUL.md` in the Hermes data volume.

## Backup and important notes

Back up `.env`, `html`, `mcp-data`, and a consistent MariaDB dump or stopped copy of `database`. `redis` is a cache and is not a substitute for the database backup.
