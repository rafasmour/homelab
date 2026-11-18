#!/usr/bin/env bash
# Rotate the homelab's self-generated API keys and shared bearer tokens.
#
# Each key gets a new random value (Python `secrets`, hex). The old value is
# read from the key's owning .env and replaced wherever that exact value occurs
# in any stack .env (ROOT/*/.env), so copies under other names (for example
# OPENAI_API_KEYS lists or HERMES_API_KEY) follow automatically. Values are
# never printed; only key names and file paths are.
#
# Not rotated (stateful, or issued by another service and needing your input):
#   HF_TOKEN, N8N_API_KEY, WGER_API_KEY,
#   NEXTCLOUD_MCP_APP_PASSWORD, UPTIME_KUMA_API_KEY, API_TOKEN_FOR_HOMEPAGE,
#   vaultwarden ADMIN_TOKEN,
#   Cloudflare tokens, and every database password, APP_KEY, encryption key,
#   session secret and JWT key (rotating those breaks stored data).
#
# Running containers keep their old values until their stacks are recreated:
# use --restart, or run the printed commands yourself.
#
# Usage: scripts/rotate-api-keys.sh [--dry-run] [--restart] [--list] [KEY ...]

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dry_run=0
restart=0
list=0
keys=()

for arg in "$@"; do
  case $arg in
    --dry-run) dry_run=1 ;;
    --restart) restart=1 ;;
    --list) list=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) keys+=("$arg") ;;
  esac
done

# KEY  owning-stack  random-bytes (hex length = 2 x bytes)
catalog='
LLAMA_API_KEY        llama-cpp                32
API_SERVER_KEY       hermes                   32
WEB_SEARCH_MCP_TOKEN web-search               32
MCP_STATIC_TOKEN     wger                     32
N8N_MCP_AUTH_TOKEN   n8n                      32
'

if (( list )); then
  printf '%s\n' "$catalog" | sed '/^$/d'
  exit 0
fi

changed=$(
  ROOT=$root DRY_RUN=$dry_run CATALOG=$catalog python3 -I - "${keys[@]}" <<'PY'
import os, re, secrets, sys, tempfile
from pathlib import Path

root = Path(os.environ["ROOT"])
dry = os.environ["DRY_RUN"] == "1"
catalog = {}
for line in os.environ["CATALOG"].splitlines():
    if line.strip():
        key, stack, size = line.split()
        catalog[key] = (stack, int(size))
wanted = sys.argv[1:] or list(catalog)
unknown = [k for k in wanted if k not in catalog]
if unknown:
    sys.exit(f"Not rotatable here: {', '.join(unknown)} (see --list)")

env_files = sorted(root.glob("*/.env"))
texts = {p: p.read_text() for p in env_files}

def read_value(text, key):
    m = re.search(rf"^[ \t]*(?:export[ \t]+)?{key}[ \t]*=[ \t]*(.*)$", text, re.M)
    if not m:
        return None
    value = m.group(1).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value

touched = set()
for key in wanted:
    stack, size = catalog[key]
    owner = root / stack / ".env"
    old = read_value(texts.get(owner, ""), key)
    if not old or old.startswith("CHANGE_ME"):
        print(f"skip {key}: not set in {stack}/.env", file=sys.stderr)
        continue
    if len(old) < 16:
        print(f"skip {key}: current value too short to replace safely", file=sys.stderr)
        continue
    new = secrets.token_hex(size)
    pattern = re.compile(rf"(?<![A-Za-z0-9_\-]){re.escape(old)}(?![A-Za-z0-9_\-])")
    hits = []
    for path, text in texts.items():
        updated, count = pattern.subn(new, text)
        if count:
            texts[path] = updated
            hits.append(path)
            touched.add(path.parent.name)
    print(f"{key}: {len(hits)} file(s): " + ", ".join(str(p.relative_to(root)) for p in hits), file=sys.stderr)

if not dry:
    for path in env_files:
        if texts[path] != path.read_text():
            fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".rotate.")
            with os.fdopen(fd, "w") as f:
                f.write(texts[path])
            os.chmod(tmp, path.stat().st_mode & 0o777)
            os.chown(tmp, path.stat().st_uid, path.stat().st_gid)
            os.replace(tmp, path)
print(" ".join(sorted(touched)))
PY
)

if (( dry_run )); then
  printf 'Dry run: nothing written.\n'
  exit 0
fi
[[ -z $changed ]] && { printf 'Nothing rotated.\n'; exit 0; }

commands=()
for stack in $changed; do
  [[ -f $root/$stack/docker-compose.yml ]] || continue
  commands+=("docker compose --env-file $stack/.env -f $stack/docker-compose.yml up -d")
done
# n8n keeps LLAMA_API_KEY in its own credential store.
case " $changed " in
  *" llama-cpp "*)
    commands+=("n8n/scripts/hermes-digests-setup.sh --credentials-only") ;;
esac

printf 'Rotated keys in: %s\n' "$changed"

# Pi (coding agent) keeps the llama.cpp router key in its auth.json; sync it so
# Pi keeps working after LLAMA_API_KEY rotates. No-op if Pi has no llama.cpp login.
case " $changed " in
  *" llama-cpp "*)
    pi_home=$HOME
    [[ -n ${SUDO_USER:-} ]] && pi_home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    pi_auth=${PI_AUTH_FILE:-$pi_home/.pi/agent/auth.json}
    if [[ -f $pi_auth ]]; then
      ENV_FILE=$root/llama-cpp/.env AUTH=$pi_auth python3 -I - <<'PY'
import json, os, re, tempfile
env = open(os.environ["ENV_FILE"]).read()
m = re.search(r"^[ \t]*(?:export[ \t]+)?LLAMA_API_KEY[ \t]*=[ \t]*(.*)$", env, re.M)
key = m.group(1).strip().strip("'\"") if m else ""
path = os.environ["AUTH"]
data = json.load(open(path))
cred = data.get("llama.cpp")
if key and isinstance(cred, dict):
    cred["key"] = key
    st = os.stat(path)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".auth.")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)
    print(f"Pi: updated llama.cpp key in {path}")
else:
    print(f"Pi: no llama.cpp login in {path}; skipped")
PY
    fi
    ;;
esac
if (( restart )); then
  cd "$root"
  for c in "${commands[@]}"; do
    printf '+ %s\n' "$c"
    eval "$c" >/dev/null
  done
else
  printf 'Apply with (from %s):\n' "$root"
  printf '  %s\n' "${commands[@]}"
fi
printf 'Also update clients outside this repo that use a rotated key (scripts, Home Assistant UI). Pi is synced above.\n'
