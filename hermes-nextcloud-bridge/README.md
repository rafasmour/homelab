# Hermes Nextcloud Talk bridge

Connects a Nextcloud Talk bot named **Hermes** to the Hermes agent, using [nextcloud-talk-hermes-bridge](https://github.com/robertlmann02/nextcloud-talk-hermes-bridge) (MIT) at commit `b26267ff8ffb02b4e282b032815584163cff5021` (release 1.0.12).

- Talk → Hermes: Talk posts each message in the bot's room to `POST /hook` (HMAC-signed with `TALK_BOT_SECRET`). The bridge runs `hermes --profile default chat -q ...` and posts the answer back as the bot.
- Hermes → Talk: `POST /deliver` (bearer `TALK_DELIVER_SECRET`) posts a bot message. The n8n `Hermes digest – *` workflows (the former Hermes cron jobs, see [n8n](../n8n/README.md#hermes-digests)) post their digests with it, and agents use it through the `talk_send` tool.
- No Traefik route and no published port. The container listens on `8788` inside the `hermes-mcp` network.

## How it is built

The upstream Dockerfile installs an unpinned `hermes-agent` from PyPI, which lags the release that `hermes-api` runs. Compose therefore builds from the upstream Git repository at the pinned commit with an inline Dockerfile: it starts from `nousresearch/hermes-agent:${HERMES_AGENT_VERSION}` (the exact image `hermes-api` runs) and adds the bridge package, which uses only the Python standard library. Keep `HERMES_AGENT_VERSION` equal to the value in `hermes/.env`, and rebuild the bridge whenever `hermes-api` is upgraded:

```sh
docker compose --env-file hermes-nextcloud-bridge/.env \
  -f hermes-nextcloud-bridge/docker-compose.yml build --pull
```

The container bind-mounts `../hermes/data` (the Hermes state folder) at `/home/hermes/.hermes` and runs as `HERMES_UID:HERMES_GID`, so Talk conversations use the same default profile, SOUL, MCP servers, plugins, and model (`HERMES_MODEL`, Qwen 3.6 35B-A3B) as the Open WebUI chat. Talk turns run as separate `hermes chat` processes next to the gateway on the same state database. If SQLite lock errors ever appear in `data/bridge.log`, give the bridge its own profile cloned from `default` and set `HERMES_PROFILE`.

Bridge settings:

| Setting | Value | Why |
| --- | --- | --- |
| `HERMES_TOOLSETS` | `nextcloud,wger,web_search,clock` | Fallback only: rooms use their profile's `platform_toolsets.cli` from `hermes/start.sh`, without `clarify` and `talk` (default keeps `kanban` and `delegation`). Follow-up questions are asked in the reply and the bridge feeds recent room messages back as context. |
| `HERMES_YOLO`, `HERMES_ACCEPT_HOOKS` | `0` | No unattended approval of protected actions or shell hooks. |
| `TALK_APPROVAL_PROMPTS`, `TALK_APPROVAL_TIMEOUT` | `1`, `600` | Risky terminal commands of the sandbox profiles (`models`, `hf-models`, `llamacpp-rocm`) post **⚠️ Approval required** with the redacted command into the room and wait. Reply `/approve once`, `/approve session` or `/deny` (`yes`/`no` also work); silence denies after 600 s. See [Hermes](../hermes/README.md#sandboxes-and-approvals). |
| `HERMES_WRITE_SAFE_ROOT` | `/opt/data:/work:/homelab:/llama-cpp:/llama-cpp-classifier` | Lets `write_file`/`patch` of the sandbox profiles target sandbox paths (they are written over SSH, not in this container). |
| `HERMES_SKILLS`, `TALK_BRIDGE_SKILL_STATUS` | empty, `0` | The `skills` toolset is disabled on every profile. |
| `TALK_LOCAL_MEMORY_CONTEXT`, `NEXTCLOUD_AI_CONTEXT` | `0` | Hermes must act through its MCP tools, not a memory store. |

The bridge reaches Nextcloud at `http://nextcloud`, `hermes-api` and the MCP servers on `hermes-mcp`, the SSH sandboxes of the terminal profiles on `hermes-sandbox` (created by [hermes-sandboxes](../hermes-sandboxes/README.md); Talk turns run here, not in `hermes-api`), and the llama.cpp router (`llama-cpp:8080`) on `webgateway`. It has no Traefik labels; `webgateway` is used only to reach llama.cpp, which is not attached to `hermes-mcp`. On the internal `self-heal-ingress` network (created by the self-heal stack) it reaches only the self-heal controller, for `/heal` commands.

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

## One room per profile

Each Hermes profile has its own Talk conversation, owned by `pi.hole`, with the Hermes bot added and its own emoji avatar and color:

| Room | Profile | Avatar |
|---|---|---|
| Hermes | `default` | 🤖 blue |
| Hermes · Nextcloud | `nextcloud` | 📅 Nextcloud blue |
| Hermes · Finance | `finance` | 💶 green |
| Hermes · Calories | `calories` | 🥗 orange |
| Hermes · AI news | `ai-news` | 🧠 purple |
| Hermes · HF models | `hf-models` | 🤗 yellow |
| Hermes · llama.cpp Vulkan | `llamacpp-vulkan` | 🦙 red |
| Hermes · llama.cpp ROCm | `llamacpp-rocm` | 🔥 orange-red |
| Hermes · GPU watch | `gpu-watch` | 🎮 teal |
| Hermes · Self-hosted | `selfhosted` | 🏠 slate |
| Hermes · Models | `models` | 🧪 magenta |
| Hermes · Planner | `planner` | 🗓️ cyan |
| Hermes · n8n | `n8n` | ⚙️ n8n pink |
| Hermes · Web search | `web-search` | 🔎 lime |

`coding` and `devops` are CLI-only (the `hermes-sandbox` CLI, see [Hermes](../hermes/README.md#cli-only-profiles-coding-and-devops)) and have no room any more. Remove their `coding=` and `devops=` entries from the map in both `.env` files; their old rooms can be archived or deleted in Talk. A room still mapped to them would only get terminal refusals.

`NEXTCLOUD_TALK_PROFILE_ROOMS="profile=room-token|..."` holds the map and must be identical in this `.env` and `hermes/.env`. It drives three things:

- Incoming messages: `patches/room_profiles.py` is applied while the image is built. It runs `hermes chat` with the profile mapped to the room the message came from and with that profile's `platform_toolsets.cli` (without `clarify`). Unmapped rooms use `HERMES_PROFILE`. The patch replaces exact upstream lines; if a newer `TALK_BRIDGE_REF` changes them, the build fails instead of ignoring the map.
- Scheduled digests: `n8n/scripts/hermes-digests-setup.sh` turns each profile's room token into the n8n credential that its `Hermes digest – *` workflow posts with (rerun it with `--credentials-only` after changing the map). Hermes itself has no cron jobs.
- `talk_send`: posts to the calling profile's room.

Failed runs: `patches/error_reason.py` (applied after `room_profiles.py`) appends one short reason to the bridge's generic "internal Hermes bridge error" reply, for example `Reason: API call failed after 3 retries: HTTP 500: Failed to parse tool call arguments as JSON ...`. It is the last error-looking line of the run's output, cut to about 200 characters, with Bearer tokens, `key=`/`token=`/`password=` values, known token prefixes and long random strings replaced by `[redacted]`. The full output is still written only to `data/bridge.log`.

`Warning: Unknown toolsets: clock` in `data/bridge.log` is harmless: `clock` is a plugin toolset, and `hermes chat` checks toolset names before it loads plugins. The clock tools are registered when the agent starts, and the bridge strips the warning from replies.

To add a room: create the conversation as `pi.hole` (Talk API `POST /ocs/v2.php/apps/spreed/api/v4/room` with `roomType=2`), set the avatar with `POST /ocs/v2.php/apps/spreed/api/v1/room/<token>/avatar/emoji` (`emoji`, `color`), add the bot with `occ talk:bot:setup 1 <token>`, add `profile=<token>` to both `.env` files, then recreate `hermes-api` and this bridge (and rerun the n8n setup script if a digest posts to that room).

## Self-heal room

`patches/heal_forward.py` (applied after the other two patches; the build fails if it no longer applies) connects the dedicated Talk room of the [self-heal](../self-heal/README.md) stack:

- Messages in `TALK_SELF_HEAL_ROOM` never start a Hermes run. The room is checked right after the `/hook` HMAC signature check, before the normal message handling.
- A human message matching `^/heal\s+(approve|deny)\s+([A-Za-z2-7]{6})(?:\s+(\d{6}))?\s*$`, or the shorthand `fix|yes|approve|/heal approve` (optional 6-digit code) / `/heal <6 digits>` / `deny|no|/heal deny` (no run id: `run_id` is sent as `null` and the controller resolves the single open run), is POSTed to `SELF_HEAL_APPROVE_URL` (default `http://self-heal:8790/approve`) with `Authorization: Bearer $SELF_HEAL_APPROVE_SECRET` and `{"run_id", "decision", "code", "actor_id", "room_token"}`. `actor_id` is the actor of the signed Talk webhook; the run id is upper-cased.
- The controller checks the room, that the actor is the owner, and the TOTP code itself, and posts the outcome to the room. The bridge posts only when the controller never got the command (unreachable, `401` or `5xx`).
- Any other human message in the room gets a one-line usage hint. Bot messages (the controller's reports) are ignored.
- The bridge never logs the message text or the code, only the run id, decision and HTTP status.
- `TALK_SELF_HEAL_ROOM` empty turns the feature off. Never put this room in `NEXTCLOUD_TALK_PROFILE_ROOMS`.

Setup: create a private room owned by `pi.hole` (for example `Hermes · Self-heal`), add the bot with `occ talk:bot:setup 1 <token>`, put the token in `TALK_SELF_HEAL_ROOM` here and in `self-heal/.env`, and the same `SELF_HEAL_APPROVE_SECRET` (`openssl rand -hex 32`) in both `.env` files. The bridge joins the external `self-heal-ingress` network, so start the self-heal stack first, then rebuild and recreate the bridge.

The bridge is not trusted for approvals: a compromised bridge can forward or forge commands, but cannot produce a valid TOTP code, and the controller re-checks room and owner.

## Validate

```sh
docker compose --env-file hermes-nextcloud-bridge/.env \
  -f hermes-nextcloud-bridge/docker-compose.yml config --quiet
docker exec nextcloud curl -fsS http://hermes-nextcloud-bridge:8788/heartbeat
# Test delivery without a model request (prints only the bridge's JSON status):
docker exec hermes-api sh -c 'curl -fsS -X POST "$NEXTCLOUD_TALK_DELIVER_URL" \
  -H "Authorization: Bearer $NEXTCLOUD_TALK_DELIVER_SECRET" -H "Content-Type: application/json" \
  -d "{\"room_token\":\"$NEXTCLOUD_TALK_HOME_ROOM\",\"message\":\"Bridge test\"}"' >/dev/null && echo delivered
```

## Security notes

- The bridge has no authentication of its own beyond the two secrets. `/hook` rejects requests without a valid Talk signature and `/deliver` rejects requests without the bearer token. `/heartbeat` and `/health` are open. Keep it off Traefik.
- Anyone who can write in a room where the bot is enabled can instruct Hermes, which can create calendar items, to-dos, notes, and wger diary rows through the MCP servers. Enable the bot only in private rooms.
- The bridge never sees the Nextcloud administrator app password. That stays in `nextcloud/.env` for `nextcloud-mcp`; the bridge only uses the Talk bot API.
- `allow_local_remote_servers=true` lets Nextcloud send webhooks and other server-side requests to private addresses.

## Backups

`data/` holds `bridge.log` and the short per-room context the bridge replays into follow-up turns (`data/context/`). It can be deleted at any time. Hermes state stays in `hermes/data/` (see [Hermes](../hermes/README.md#storage-and-backups)).
