# Hermes Nextcloud Talk bridge

Connects a Nextcloud Talk bot named **Hermes** to the Hermes agent, using [nextcloud-talk-hermes-bridge](https://github.com/robertlmann02/nextcloud-talk-hermes-bridge) (MIT) at commit `b26267ff8ffb02b4e282b032815584163cff5021` (release 1.0.12).

- Talk → Hermes: Talk posts each message in the bot's room to `POST /hook` (HMAC-signed with `TALK_BOT_SECRET`). The bridge runs `hermes --profile default chat -q ...` and posts the answer back as the bot.
- Hermes → Talk: `POST /deliver` (bearer `TALK_DELIVER_SECRET`) posts a bot message. Hermes cron jobs use it through the `nextcloud_talk` delivery platform, and agents use it through the `talk_send` tool.
- No Traefik route and no published port. The container listens on `8788` inside the `hermes-mcp` network.

## How it is built

The upstream Dockerfile installs an unpinned `hermes-agent` from PyPI, which lags the release that `hermes-api` runs. Compose therefore builds from the upstream Git repository at the pinned commit with an inline Dockerfile: it starts from `nousresearch/hermes-agent:${HERMES_AGENT_VERSION}` (the exact image `hermes-api` runs) and adds the bridge package, which uses only the Python standard library. Keep `HERMES_AGENT_VERSION` equal to the value in `hermes/.env`, and rebuild the bridge whenever `hermes-api` is upgraded:

```sh
docker compose --env-file hermes-nextcloud-bridge/.env \
  -f hermes-nextcloud-bridge/docker-compose.yml build --pull
```

The container mounts the existing `hermes_hermes-data` volume at `/home/hermes/.hermes` and runs as `HERMES_UID:HERMES_GID`, so Talk conversations use the same default profile, SOUL, MCP servers, plugins, and model (`HERMES_MODEL`, Mellum 2.1) as the Open WebUI chat. Talk turns run as separate `hermes chat` processes next to the gateway on the same state database. If SQLite lock errors ever appear in `data/bridge.log`, give the bridge its own profile cloned from `default` and set `HERMES_PROFILE`.

Bridge settings:

| Setting | Value | Why |
| --- | --- | --- |
| `HERMES_TOOLSETS` | `kanban,nextcloud,wger,web_search,talk` | The default profile's tools without `clarify`; a one-shot `chat -q` cannot wait for an answer, so follow-up questions are asked in the reply and the bridge feeds recent room messages back as context. |
| `HERMES_YOLO`, `HERMES_ACCEPT_HOOKS`, `TALK_APPROVAL_PROMPTS` | `0` | No unattended approval of protected actions or shell hooks. |
| `HERMES_SKILLS`, `TALK_BRIDGE_SKILL_STATUS` | empty, `0` | The `skills` toolset is disabled on every profile. |
| `TALK_LOCAL_MEMORY_CONTEXT`, `NEXTCLOUD_AI_CONTEXT` | `0` | Hermes must act through its MCP tools, not a memory store. |

The bridge reaches Nextcloud at `http://nextcloud`, `hermes-api` and the MCP servers on `hermes-mcp`, and the llama.cpp router (`llama-cpp:8080`) on `webgateway`. It has no Traefik labels; `webgateway` is used only to reach llama.cpp, which is not attached to `hermes-mcp`.

## Setup

1. Start Hermes first (it creates `hermes-mcp`) and recreate Nextcloud so the `nextcloud` container joins `hermes-mcp`.

2. Create `.env` from the template and generate both secrets (64 hex characters; Talk requires 40–128):

   ```sh
   cp hermes-nextcloud-bridge/.env.example hermes-nextcloud-bridge/.env
   openssl rand -hex 32   # TALK_BOT_SECRET
   openssl rand -hex 32   # TALK_DELIVER_SECRET, also hermes/NEXTCLOUD_TALK_DELIVER_SECRET
   ```

3. Allow webhooks to private addresses and register the bot. Read the secret from the ignored `.env` so it never appears in shell history:

   ```sh
   docker exec -u www-data nextcloud php occ config:system:set \
     allow_local_remote_servers --value true --type bool
   export S="$(grep '^TALK_BOT_SECRET=' hermes-nextcloud-bridge/.env | cut -d= -f2-)"
   docker exec -u www-data -e S nextcloud sh -c \
     'php occ talk:bot:install -f webhook -f response Hermes "$S" http://hermes-nextcloud-bridge:8788/hook "Hermes assistant"'
   unset S
   docker exec -u www-data nextcloud php occ talk:bot:list
   ```

4. Create the room and enable the bot in it. The current room is `Hermes`, owned by `pi.hole` (the only human account; `jerry` is the Home Assistant service account). The bot id is `1`.

   ```sh
   docker exec -u www-data nextcloud php occ talk:room:create \
     --owner=pi.hole --user=pi.hole Hermes
   docker exec -u www-data nextcloud php occ talk:bot:setup 1 <room-token>
   ```

   The room token is the last path segment of the room URL (`https://nextcloud.<DOMAIN>/call/<room-token>`). Put it in `NEXTCLOUD_TALK_HOME_ROOM` in both `hermes-nextcloud-bridge/.env` and `hermes/.env`. Moderators can also enable the bot in other conversations from the conversation settings (**Bots**).

5. Start the bridge, then recreate `hermes-api` so it picks up the `NEXTCLOUD_TALK_*` values:

   ```sh
   docker compose --env-file hermes-nextcloud-bridge/.env \
     -f hermes-nextcloud-bridge/docker-compose.yml up -d --build
   docker compose --env-file hermes/.env -f hermes/docker-compose.yml up -d
   ```

## Validate

```sh
docker compose --env-file hermes-nextcloud-bridge/.env \
  -f hermes-nextcloud-bridge/docker-compose.yml config --quiet
docker exec nextcloud curl -fsS http://hermes-nextcloud-bridge:8788/heartbeat
# Test delivery without a model request (prints only the bridge's JSON status):
docker exec hermes-api sh -c 'curl -fsS -X POST "$NEXTCLOUD_TALK_DELIVER_URL" \
  -H "Authorization: Bearer $NEXTCLOUD_TALK_DELIVER_SECRET" -H "Content-Type: application/json" \
  -d "{\"room_token\":\"$NEXTCLOUD_TALK_HOME_ROOM\",\"message\":\"Bridge test\"}"' >/dev/null && echo delivered
docker exec hermes-api hermes -p ai-news send -t nextcloud_talk "Cron delivery test"
```

## Security notes

- The bridge has no authentication of its own beyond the two secrets. `/hook` rejects requests without a valid Talk signature and `/deliver` rejects requests without the bearer token. `/heartbeat` and `/health` are open. Keep it off Traefik.
- Anyone who can write in a room where the bot is enabled can instruct Hermes, which can create calendar items, to-dos, notes, and wger diary rows through the MCP servers. Enable the bot only in private rooms.
- The bridge never sees the Nextcloud administrator app password. That stays in `nextcloud/.env` for `nextcloud-mcp`; the bridge only uses the Talk bot API.
- `allow_local_remote_servers=true` lets Nextcloud send webhooks and other server-side requests to private addresses.

## Backups

`data/` holds `bridge.log` and the short per-room context the bridge replays into follow-up turns (`data/context/`). It can be deleted at any time. Hermes state stays in the `hermes_hermes-data` volume.
