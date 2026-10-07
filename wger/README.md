# wger

Self-hosted [wger](https://wger.de) workout manager and nutrition diary, plus a private calorie MCP for Hermes.

- Application: `https://wger.<DOMAIN>`
- Hermes MCP endpoint: `http://wger-mcp:8765/mcp` on the private `hermes-mcp` network

The Compose file follows the upstream [wger-project/docker](https://github.com/wger-project/docker) production layout: gunicorn, nginx (static files and the PowerSync path), Postgres, Redis, Celery, and PowerSync. Traefik routes only to nginx. No host ports are published.

## Networks

| Container | Networks |
| --- | --- |
| `wger` (nginx) | `backend`, external `webgateway` |
| `wger-web` | `backend`, private `egress`, external `hermes-mcp` |
| `wger-celery-worker` | `backend`, private `egress` |
| `wger-database`, `wger-redis`, `wger-celery-beat`, `wger-powersync` | `backend` (`internal: true`) |
| `wger-mcp` | external `hermes-mcp` only |

`backend` has no route to the internet, so Postgres and Redis cannot leave the host. The application and Celery worker also join `egress` so ingredient and exercise sync can download from `https://wger.de` without joining `webgateway`. `wger-web` also joins `hermes-mcp` so the private MCP can call `http://web:8000`.

## Configure and start

Start Hermes first so its Compose project creates `hermes-mcp`.

```bash
cp wger/.env.example wger/.env
```

Replace every `CHANGE_ME`. Passwords must be hexadecimal because they are embedded in `PS_DATABASE_URI` and `PS_STORAGE_PG_URI`. `SECRET_KEY` is a 50-character URL-safe token. `MCP_STATIC_TOKEN` is at least 32 characters (`openssl rand -hex 32`). `JWT_PUBLIC_KEY` and `JWT_PRIVATE_KEY` are a base64url RS256 JWK pair (`kid` `wger`). After `wger-web` is up, rotate them with `./manage.py generate-jwt-keys`, paste the output into `.env`, and recreate `web`, `celery_worker`, `celery_beat`, and `powersync`.

```bash
python -c "import secrets; print(secrets.token_urlsafe(50))"
openssl rand -hex 24
openssl rand -hex 32
```

The `static` and `media` bind mounts must be writable by uid 1000 before the first start.

```bash
docker compose --env-file wger/.env -f wger/docker-compose.yml config --quiet
docker compose --env-file wger/.env -f wger/docker-compose.yml up -d
```

After `wger-web` is healthy, create the PowerSync storage role once. The command is idempotent:

```bash
docker compose --env-file wger/.env -f wger/docker-compose.yml exec web ./manage.py setup-powersync-storage
docker compose --env-file wger/.env -f wger/docker-compose.yml restart powersync
```

## Owner account

wger has its own login. `ALLOW_REGISTRATION` defaults to `True` so the owner account can be created in the browser at `https://wger.<DOMAIN>`. Set `ALLOW_REGISTRATION=False` and recreate `wger-web` after that account exists. Guest users are disabled.

Then open the account's API key page (Settings, API key) and put that value in `WGER_API_KEY`. Recreate only `wger-mcp` afterward. Until the key is real, the MCP process can be healthy while nutrition calls return unauthorized.

## Ingredient sync

Celery schedules a weekly ingredient sync. To start a download immediately without waiting for it to finish (the dump is about 1GB):

```bash
docker exec -d wger-web python3 manage.py sync-ingredients-bulk
```

Until that import finishes, a food name may be missing from the local database. Barcode lookup can still fetch a single ingredient from the upstream wger instance when `DOWNLOAD_INGREDIENTS_FROM=WGER`.

## Private calorie MCP

`wger-mcp` is the official [wger MCP server](https://github.com/wger-project/mcp-server) image. It is not on `webgateway` and has no published port. Hermes reaches it at:

`http://wger-mcp:8765/mcp`

Authentication is a static bearer token. The caller sends:

`Authorization: Bearer <MCP_STATIC_TOKEN>`

`MCP_AUTH` is `static_token`. The server then calls wger with `WGER_API_KEY`. `WGER_BASE_URL` is `http://web:8000`. `wger-web` joins `hermes-mcp` so that name resolves; the MCP container itself stays on `hermes-mcp` only. The LAN name `wger.<DOMAIN>` is served with Traefik's default certificate, which this client rejects, so the MCP uses the internal HTTP port instead of the public URL. `MCP_TOOLS` is `nutrition`, which is the group that covers meal logging and daily totals.

Register it from a container on `hermes-mcp`. Do not put the token value in git. The two operations the calorie profile needs:

| Tool | What it does |
| --- | --- |
| `log_ingredient` | Writes one nutrition-diary row. Arguments: `plan_id`, `ingredient_id`, `amount_g`, optional `when` (ISO timestamp or date; omit for now), optional `meal_id`, optional `weight_unit_id` (portions instead of grams). |
| `nutrition_summary` | Reads that day's totals from the diary: energy (kcal), protein, carbohydrates, fat, and fiber. Arguments: optional `when` (date; omit for today), optional `plan_id`. |

The same group can `search_ingredients`, `list_nutrition_plans`, and `create_nutrition_plan` (`only_logging` is the diary-only plan). A meal log needs a plan id and an ingredient id from those calls. `GET /health` on port 8765 is unauthenticated and is only the process health check.

## Backup

Back up `.env`, `postgres/`, `media/`, and `redis/`. `static/` and `celery-beat/` are regenerated. Prefer a database dump:

```bash
docker compose --env-file wger/.env -f wger/docker-compose.yml exec db pg_dump -U wger wger
```
