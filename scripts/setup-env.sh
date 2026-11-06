#!/usr/bin/env bash
# Create and complete the .env file of every stack from its .env.example.
#
#   scripts/setup-env.sh [--dry-run] [--root DIR] [service-folder ...]
#
# * Generates API tokens, secret keys, webhook secrets and internal service
#   passwords in the format documented beside each variable (default:
#   openssl rand -hex 32).
# * Keeps secrets that must be identical across stacks in sync (SHARED_GROUPS).
# * Asks for usernames, e-mail addresses and the passwords a human logs in with.
# * Asks for tokens that only an application UI can create (hint shown, Enter
#   skips).
# * Never changes a value that is already set (anything other than empty or
#   CHANGE_ME*), never prints a value, backs up an existing .env before the
#   first change, and is safe to re-run.
#
# Set SETUP_ENV_ASSUME_TTY=1 to read answers from a pipe (used by the tests).

set -euo pipefail
umask 077

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "setup-env.sh needs bash 4 or newer." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY=0
FILTER=()
DEFAULT_DOMAIN="lab.rafasmour.com"
STAMP="$(date +%Y%m%d%H%M%S)"

usage() {
  cat <<'EOF'
Usage: scripts/setup-env.sh [--dry-run] [--root DIR] [service-folder ...]

Creates or completes <service>/.env from <service>/.env.example.
  --dry-run   List what would be generated, copied, prompted or skipped.
              Writes nothing, prompts for nothing, prints no values.
  --root DIR  Repository root to work in (default: the repository of this script).
  folders     Limit the run to these service folders (default: all).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --root) [ $# -ge 2 ] || { echo "--root needs a directory" >&2; exit 2; }; ROOT="$(cd "$2" && pwd)"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) FILTER+=("${1%/}") ;;
  esac
  shift
done

if [ -t 0 ] || [ "${SETUP_ENV_ASSUME_TTY:-0}" = 1 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi

# --------------------------------------------------------------------------
# Classification, built from the variable names in the .env.example files.
#   C <key | service/key> <kind> <arg> <hint>
# kinds:
#   gen        generated secret; arg = hex:N | b64:N | alnum:N | urlsafe:N | b32:N
#   user       username / e-mail asked with read -r (default from .env.example)
#   pass       password a human types; read -rs twice, empty = generate (arg)
#   passhash   password stored as a double SHA-256 hash (Pi-hole); cannot be generated
#   token      secret that must come from an app UI; read -rs, Enter skips
#   tokenopt   same, and empty is a valid value (optional feature)
#   value      non-secret value from an app UI (room token, ID); read -r
#   valueopt   same, and empty is valid
#   manual     needs a command run on the host; reported, never prompted
#   skip       leave alone
# A service-specific entry (service/key) wins over a plain key entry.
# Unlisted keys: a CHANGE_ME value whose name contains SECRET, TOKEN, KEY or
# PASSWORD is generated with hex:32; any other CHANGE_ME value is unresolved.
# --------------------------------------------------------------------------
declare -A CLS_KIND CLS_ARG CLS_HINT
C() { CLS_KIND[$1]=$2; CLS_ARG[$1]=$3; CLS_HINT[$1]=$4; }

# Generated: shared secrets get their format from SHARED_GROUPS below.
C APP_KEY               gen alnum:32 ""   # Laravel needs a 32-byte key; 32 alphanumeric characters are valid.
C STATIC_CRON_TOKEN     gen hex:16 ""     # exactly 32 alphanumeric characters
C DB_PASSWORD           gen hex:32 ""     # immich: A-Za-z0-9 only
C MYSQL_ROOT_PASSWORD   gen hex:32 ""
C MYSQL_PASSWORD        gen hex:32 ""
C POSTGRES_PASSWORD     gen hex:24 ""     # embedded in database URLs: hex only
C POWERSYNC_STORAGE_PASSWORD gen hex:24 ""
C PAPERLESS_DB_PASSWORD gen hex:24 ""
C HINDSIGHT_DB_PASSWORD gen hex:24 ""      # embedded in a database URL: hex only
C PAPERLESS_SECRET_KEY  gen hex:32 ""
C N8N_ENCRYPTION_KEY    gen hex:32 ""
C WEBUI_SECRET_KEY      gen hex:32 ""
C AUTH_SECRET           gen hex:32 ""
C SEARXNG_SECRET        gen hex:32 ""
C TALK_BOT_SECRET       gen hex:32 ""     # Talk requires 40-128 characters
C HOST_PROBE_TOKEN      gen hex:32 ""
C BENCH_API_TOKEN       gen hex:32 ""
C SELF_HEAL_TOTP_SECRET gen b32:20 ""     # base32, >= 16 characters; only used when SELF_HEAL_REQUIRE_TOTP=1 (add it to an authenticator then)
C tandoor-recipes/SECRET_KEY gen b64:50 ""
C wger/SECRET_KEY       gen urlsafe:64 "" # 50+ URL-safe characters

# Human logins.
C GF_SECURITY_ADMIN_USER user "" ""
C GF_SECURITY_ADMIN_PASSWORD pass b64:24 ""
C GITLAB_ROOT_PASSWORD  pass b64:24 ""    # no single quotes (base64 has none)
C MODELS_UI_USERNAME    user "" ""
C MODELS_UI_PASSWORD    pass b64:24 ""
C BENCHMARK_UI_USERNAME user "" ""
C BENCHMARK_UI_PASSWORD pass b64:24 ""
C UPTIME_KUMA_USERNAME  user "" ""
C UPTIME_KUMA_PASSWORD  pass b64:32 ""    # >= 6 characters, letters and numbers
C PAPERLESS_ADMIN_USER  user "" ""
C PAPERLESS_ADMIN_PASSWORD pass b64:24 ""
C PAPERLESS_ADMIN_MAIL  user "" ""
C ADMIN_EMAIL           user "" ""        # mealie
C SITE_OWNER            user "" ""        # firefly
C JUPYTER_PASSWORD      pass b64:24 ""
C UNSLOTH_STUDIO_PASSWORD pass b64:24 "" # unsloth-studio: Studio admin (user "unsloth"), first boot only
C HERMES_DASHBOARD_USERNAME user "" ""    # hermes: Hermes web dashboard login (Hermes-Relay app)
C HERMES_DASHBOARD_PASSWORD pass b64:24 "" # hermes: dashboard password
C NEXTCLOUD_USER        user "" ""        # paperless: Nextcloud user that owns the consume folder
C NEXTCLOUD_MCP_USERNAME user "" ""       # dedicated Nextcloud account for the MCP
C SELF_HEAL_OWNER_ACTOR user "" ""        # users/<Nextcloud user id>
C WEBPASSWORD           passhash "" ""    # pi-hole stores sha256(sha256(password))

# Values only an application UI or an external party can provide.
C PIRAEUS_ZIP_PASSWORD  token "" "password of the bank statement zip (set by the bank)"
C N8N_API_KEY           token "" "n8n: Settings > n8n API > Create an API key (full access, for the n8n-mcp container)"
C N8N_DRIFT_API_KEY     token "" "n8n: Settings > n8n API > new API key with ONLY workflow:list and workflow:read scopes"
C PAPERLESS_GPT_API_TOKEN token "" "Paperless: profile menu > My Profile > API Auth Token (after first start)"
C NEXTCLOUD_MCP_APP_PASSWORD token "" "Nextcloud, signed in as the MCP user: Settings > Security > Devices & sessions > Create new app password"
C UPTIME_KUMA_API_KEY   token "" "Uptime Kuma: Settings > Security > API Keys"
C SELF_HEAL_GRAFANA_TOKEN token "" "Grafana: Administration > Users and access > Service accounts (Viewer role) > Add token"
C WGER_API_KEY          token "" "wger: Settings > API key of the owner account"
C ADMIN_TOKEN           token "" "Vaultwarden Argon2 hash: docker run --rm -it vaultwarden/server:latest /vaultwarden hash"
C FIREFLY_III_ACCESS_TOKEN tokenopt "" "Firefly III: /profile/oauth > Personal access tokens (alternative to the client ID)"
C FIREFLY_III_CLIENT_ID valueopt "" "Firefly III: /profile/oauth > public OAuth client, numeric client ID (alternative to the access token)"
C HF_TOKEN              tokenopt "" "Hugging Face: Settings > Access Tokens (read scope), only for gated repositories"
C chartdb/OPENAI_API_KEY tokenopt "" "OpenAI API key, only for ChartDB's AI features"
C TALK_ALERTS_ROOM      value "" "Nextcloud Talk: token of the 'Grafana alerts' room (last part of the room URL)"
C TRUSTED_PROXIES       value "" "webgateway subnet: docker network inspect webgateway --format '{{(index .IPAM.Config 0).Subnet}}'"
C JWT_PUBLIC_KEY        manual "" "wger: docker compose exec web ./manage.py generate-jwt-keys (paste both lines)"
C JWT_PRIVATE_KEY       manual "" "wger: docker compose exec web ./manage.py generate-jwt-keys (paste both lines)"

# Optional or deliberately empty: leave alone.
C BENCHMARK_TALK_ROOM   skip "" ""
C PAPERLESS_GPT_OPENAI_BASE_URL skip "" ""

# --------------------------------------------------------------------------
# Secrets that must be identical in several stacks.
#   group | format | members  ("service:KEY", trailing ? = empty is valid there)
# Found by grepping variable names across every .env.example and compose file.
# format: hex:N, b64:N, ... = generate once; token:HINT / value:HINT = ask once.
# --------------------------------------------------------------------------
GROUP_NAMES=()
declare -A GFMT GMEM
G() { GROUP_NAMES+=("$1"); GFMT[$1]=$2; GMEM[$1]=$3; }

G llama-api-key        hex:32 "llama-cpp:LLAMA_API_KEY hermes:LLAMA_API_KEY hermes-sandboxes:LLAMA_API_KEY paperless:LLAMA_API_KEY hindsight:LLAMA_API_KEY benchmark:LLAMA_API_KEY speech:LLAMA_API_KEY openwebui:OPENAI_API_KEY"
G hermes-api-key       hex:32 "hermes:API_SERVER_KEY openwebui:HERMES_API_KEY"
G web-search-mcp       hex:32 "web-search:WEB_SEARCH_MCP_TOKEN hermes:WEB_SEARCH_MCP_TOKEN openwebui:WEB_SEARCH_MCP_TOKEN"
G wger-mcp             hex:32 "wger:MCP_STATIC_TOKEN hermes:MCP_STATIC_TOKEN benchmark:MCP_STATIC_TOKEN openwebui:WGER_MCP_TOKEN"
G n8n-mcp              hex:32 "n8n:N8N_MCP_AUTH_TOKEN hermes:N8N_MCP_AUTH_TOKEN openwebui:N8N_MCP_TOKEN"
G firefly-auto-import  hex:16 "firefly-iii:AUTO_IMPORT_SECRET n8n:AUTO_IMPORT_SECRET"
G benchmark-mcp        hex:32 "benchmark:BENCHMARK_MCP_TOKEN hermes:BENCHMARK_MCP_TOKEN"
G self-heal-webhook    hex:32 "self-heal:SELF_HEAL_WEBHOOK_SECRET grafana:SELF_HEAL_WEBHOOK_SECRET"
G self-heal-approve    hex:32 "self-heal:SELF_HEAL_APPROVE_SECRET hermes-nextcloud-bridge:SELF_HEAL_APPROVE_SECRET"
G self-heal-hermes-key hex:32 "self-heal:SELF_HEAL_HERMES_KEY hermes:SELF_HEAL_HERMES_KEY"
G diagnose-mcp         hex:32 "self-heal:DIAGNOSE_MCP_TOKEN hermes:DIAGNOSE_MCP_TOKEN"
G talk-deliver         hex:32 "hermes-nextcloud-bridge:TALK_DELIVER_SECRET hermes:NEXTCLOUD_TALK_DELIVER_SECRET self-heal:TALK_DELIVER_SECRET grafana:TALK_DELIVER_SECRET"
G n8n-drift-webhook    hex:32 "grafana:N8N_DRIFT_WEBHOOK_SECRET n8n-drift-runner:N8N_DRIFT_WEBHOOK_SECRET"
G talk-home-room       "value:Nextcloud Talk: token of the Hermes home room (last part of the room URL; see hermes-nextcloud-bridge/README.md)" "hermes:NEXTCLOUD_TALK_HOME_ROOM hermes-nextcloud-bridge:NEXTCLOUD_TALK_HOME_ROOM"
G talk-profile-rooms   "value:Nextcloud Talk: profile=token|profile=token|... one room per Hermes profile (see hermes-nextcloud-bridge/README.md)" "hermes:NEXTCLOUD_TALK_PROFILE_ROOMS hermes-nextcloud-bridge:NEXTCLOUD_TALK_PROFILE_ROOMS"
G talk-self-heal-room  "value:Nextcloud Talk: token of the dedicated self-heal approval room (owner and Hermes bot only)" "self-heal:TALK_SELF_HEAL_ROOM hermes-nextcloud-bridge:TALK_SELF_HEAL_ROOM?"

declare -A KEY_GROUP   # "service/KEY" -> group
for g in "${GROUP_NAMES[@]}"; do
  for m in ${GMEM[$g]}; do KEY_GROUP["${m%%:*}/${m#*:}"]=$g; done
done

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
say() { printf '%s\n' "$*" >&2; }

trim() {
  local v=$1
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# RHS of a KEY=VALUE line -> the value a Compose .env parser would see
# (quotes removed; no variable expansion is attempted).
decode() {
  local v
  v="$(trim "$1")"
  case $v in
    "#"*) v="" ;;
    "'"*"'") v=${v:1:${#v}-2} ;;
    '"'*'"')
      v=${v:1:${#v}-2}
      v=${v//\\\\/$'\x01'}; v=${v//\\\"/\"}; v=${v//\\\$/\$}; v=${v//$'\x01'/\\}
      ;;
    *) v="${v%% \#*}"; v="$(trim "$v")" ;;
  esac
  printf '%s' "$v"
}

is_placeholder() { [ -z "$1" ] || [[ $1 == *CHANGE_ME* ]]; }

# Value -> text for the right-hand side of KEY=. Plain when safe, otherwise
# single-quoted (literal in Compose), or double-quoted when it holds a '.
encode() {
  local v=$1
  if [[ $v =~ ^[A-Za-z0-9_./:@%+=,~|-]*$ ]]; then
    printf '%s' "$v"
  elif [[ $v != *"'"* ]]; then
    printf "'%s'" "$v"
  else
    v=${v//\\/\\\\}; v=${v//\"/\\\"}; v=${v//\$/\\\$}
    printf '"%s"' "$v"
  fi
}

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -vtx1 | tr -d ' \n'; fi
}
rand_b64_raw() {  # N random bytes, base64, one line
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1" | tr -d '\n'
  else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}
rand_alnum() { local s; s="$(rand_b64_raw $(( $1 * 3 )) | tr -dc 'A-Za-z0-9')"; printf '%s' "${s:0:$1}"; }
rand_urlsafe() { local s; s="$(rand_b64_raw $(( $1 * 2 )) | tr '+/' '-_' | tr -d '=')"; printf '%s' "${s:0:$1}"; }

generate() {  # spec
  local kind=${1%%:*} n=${1#*:}
  case $kind in
    hex) rand_hex "$n" ;;
    b64) rand_b64_raw "$n" ;;
    alnum) rand_alnum "$n" ;;
    urlsafe) rand_urlsafe "$n" ;;
    b32) head -c "$n" /dev/urandom | base32 | tr -d '=\n' ;;
    *) say "internal error: unknown generator $1"; exit 1 ;;
  esac
}

ENV_LINE_RE='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$'

# --------------------------------------------------------------------------
# Discover services
# --------------------------------------------------------------------------
shopt -s nullglob
ALL=()
for f in "$ROOT"/*/.env.example "$ROOT"/*/*/.env.example; do
  d=${f%/.env.example}; ALL+=("${d#"$ROOT"/}")
done
shopt -u nullglob
[ ${#ALL[@]} -gt 0 ] || { say "No .env.example files found under $ROOT."; exit 1; }

SVCS=()
if [ ${#FILTER[@]} -gt 0 ]; then
  for want in "${FILTER[@]}"; do
    found=0
    for s in "${ALL[@]}"; do [ "$s" = "$want" ] && found=1; done
    [ $found = 1 ] || { say "No .env.example in '$want'."; exit 2; }
    SVCS+=("$want")
  done
else
  SVCS=("${ALL[@]}")
fi
IFS=$'\n' SVCS=($(printf '%s\n' "${SVCS[@]}" | sort -u)); unset IFS

declare -A INSCOPE FRESH BASEFILE
declare -A KEYS      # svc -> space-separated keys in example order
declare -A CUR       # svc/KEY -> raw RHS (from .env, or from the example when missing)
declare -A MISSING   # svc/KEY -> 1 when the key is not in an existing .env
declare -A NEW       # svc/KEY -> RHS to write
declare -A N_GEN N_SHARED N_PROMPT N_APPEND N_KEPT N_UNRES
declare -A UNRES_KEYS UNRES_HINT PROMPTED_NOTE

for s in "${SVCS[@]}"; do
  INSCOPE[$s]=1
  N_GEN[$s]=0; N_SHARED[$s]=0; N_PROMPT[$s]=0; N_APPEND[$s]=0; N_KEPT[$s]=0; N_UNRES[$s]=0
  UNRES_KEYS[$s]=""
done

# load_env svc -> fills CUR/MISSING/KEYS for the service
load_service() {
  local s=$1 ex="$ROOT/$1/.env.example" env="$ROOT/$1/.env" line key rhs
  local -A inenv=()
  local keys=""
  if [ -f "$env" ]; then
    FRESH[$s]=0; BASEFILE[$s]=$env
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ $line =~ $ENV_LINE_RE ]]; then inenv[${BASH_REMATCH[2]}]=${BASH_REMATCH[3]}; fi
    done <"$env"
  else
    FRESH[$s]=1; BASEFILE[$s]=$ex
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ $ENV_LINE_RE ]]; then
      key=${BASH_REMATCH[2]}; rhs=${BASH_REMATCH[3]}
      case " $keys " in *" $key "*) continue ;; esac
      keys+="$key "
      if [ "${FRESH[$s]}" = 1 ]; then
        CUR[$s/$key]=$rhs
      elif [ -n "${inenv[$key]+x}" ]; then
        CUR[$s/$key]=${inenv[$key]}
      else
        CUR[$s/$key]=$rhs; MISSING[$s/$key]=1
      fi
    fi
  done <"$ex"
  KEYS[$s]=$keys
}

for s in "${SVCS[@]}"; do load_service "$s"; done

# Current decoded value of a group member, including stacks outside this run.
member_value() {
  local s=$1 key=$2 line
  if [ -n "${CUR[$s/$key]+x}" ] && [ -z "${MISSING[$s/$key]:-}" ] && [ "${FRESH[$s]:-0}" = 0 ]; then
    decode "${CUR[$s/$key]}"; return
  fi
  if [ -z "${INSCOPE[$s]:-}" ] && [ -f "$ROOT/$s/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ $line =~ $ENV_LINE_RE ]] && [ "${BASH_REMATCH[2]}" = "$key" ]; then
        decode "${BASH_REMATCH[3]}"; return
      fi
    done <"$ROOT/$s/.env"
  fi
  printf ''
}

# --------------------------------------------------------------------------
# Prompts (never echo a secret, never print a value)
# --------------------------------------------------------------------------
ANSWER=""
ask_plain() {   # label default -> ANSWER ; returns 1 when not interactive
  ANSWER=""
  [ "$INTERACTIVE" = 1 ] || return 1
  if [ -n "$2" ]; then printf '  %s [%s]: ' "$1" "$2" >&2; else printf '  %s: ' "$1" >&2; fi
  IFS= read -r ANSWER || ANSWER=""
  [ -n "$ANSWER" ] || ANSWER=$2
  return 0
}
ask_secret() {  # label confirm(0/1) -> ANSWER
  local a b tries=0
  ANSWER=""
  [ "$INTERACTIVE" = 1 ] || return 1
  while [ $tries -lt 3 ]; do
    printf '  %s: ' "$1" >&2
    IFS= read -rs a || a=""; printf '\n' >&2
    if [ "$2" = 0 ] || [ -z "$a" ]; then ANSWER=$a; return 0; fi
    printf '  Repeat to confirm: ' >&2
    IFS= read -rs b || b=""; printf '\n' >&2
    if [ "$a" = "$b" ]; then ANSWER=$a; return 0; fi
    say "  The entries differ; try again."
    tries=$((tries + 1))
  done
  ANSWER=""
  return 0
}

# Same pipeline as the command documented in pi-hole/.env.example.
hash_pihole() { printf '%s' "$1" | openssl dgst -sha256 -hex | awk '{print $2}' | openssl dgst -sha256 -hex | awk '{print $2}'; }

# --------------------------------------------------------------------------
# Bookkeeping
# --------------------------------------------------------------------------
plan() { [ "$DRY" = 1 ] && printf '  %-9s %-28s %s\n' "$1" "$2/$3" "${4:-}" || true; }

set_value() {  # svc key plain-value
  NEW[$1/$2]="$(encode "$3")"
}
unresolved() {  # svc key hint
  N_UNRES[$1]=$(( N_UNRES[$1] + 1 ))
  UNRES_KEYS[$1]+="$2 "
  [ -z "${3:-}" ] || UNRES_HINT[$1/$2]=$3
}
bump() { eval "$1[\$2]=\$(( $1[\$2] + 1 ))"; }

# Does key need action? sets NEED=1/0. $3 = "empty is valid" flag (0/1)
needs() {  # svc key optional
  local s=$1 key=$2 opt=$3 raw dec
  raw=${CUR[$s/$key]}; dec="$(decode "$raw")"; NEED=0
  if [ "$opt" = 1 ] && [ -z "$dec" ]; then
    # empty is valid: only fill in on a new .env or an appended key
    if [ "${FRESH[$s]}" = 1 ] || [ -n "${MISSING[$s/$key]:-}" ]; then NEED=1; fi
    return
  fi
  is_placeholder "$dec" && NEED=1
  return 0
}

# --------------------------------------------------------------------------
# Shared groups
# --------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then say "setup-env: root $ROOT (dry run: nothing is written, nothing is asked)"; else say "setup-env: root $ROOT"; fi

for g in "${GROUP_NAMES[@]}"; do
  real=""; src=""
  for m in ${GMEM[$g]}; do
    s=${m%%:*}; key=${m#*:}; key=${key%\?}
    v="$(member_value "$s" "$key")"
    if ! is_placeholder "$v"; then real=$v; src=$s; break; fi
  done
  targets=()
  for m in ${GMEM[$g]}; do
    s=${m%%:*}; key=${m#*:}; opt=0
    case $key in *\?) opt=1; key=${key%\?} ;; esac
    [ -n "${INSCOPE[$s]:-}" ] || continue
    [ -n "${CUR[$s/$key]+x}" ] || continue
    needs "$s" "$key" "$opt"
    if [ "$NEED" = 1 ]; then targets+=("$s:$key:$opt"); fi
  done
  [ ${#targets[@]} -gt 0 ] || continue

  origin=""   # gen | prompt when this run produced the value
  hint=""
  if [ -z "$real" ]; then
    fmt=${GFMT[$g]}
    case $fmt in
      value:*|token:*)
        hint=${fmt#*:}
        if [ "$DRY" = 1 ]; then
          origin=prompt-dry
        elif ask_plain "$g -- $hint (Enter to skip)" ""; then
          real=$ANSWER; origin=prompt
        fi
        ;;
      *)
        if [ "$DRY" = 1 ]; then real="dry-run"; else real="$(generate "$fmt")"; fi
        origin=gen
        ;;
    esac
  fi

  first=1
  for t in "${targets[@]}"; do
    s=${t%%:*}; key=${t#*:}; opt=${key#*:}; key=${key%%:*}
    if [ "$origin" = prompt-dry ]; then
      plan prompt "$s" "$key" "$g (asked once, copied to the others)"
      bump N_PROMPT "$s"; continue
    fi
    if [ -z "$real" ]; then
      if [ "$opt" = 1 ] && [ -z "$(decode "${CUR[$s/$key]}")" ]; then bump N_KEPT "$s"; continue; fi
      unresolved "$s" "$key" "$hint"; plan unresolved "$s" "$key" "$g"; continue
    fi
    [ "$DRY" = 1 ] || set_value "$s" "$key" "$real"
    if [ "$origin" = gen ] && [ $first = 1 ]; then
      bump N_GEN "$s"; plan generate "$s" "$key" "shared $g"
    elif [ "$origin" = prompt ] && [ $first = 1 ]; then
      bump N_PROMPT "$s"; plan prompt "$s" "$key" "$g"
    else
      bump N_SHARED "$s"; plan copy "$s" "$key" "shared $g${src:+ from $src}"
    fi
    first=0
  done
done

# --------------------------------------------------------------------------
# Per-service keys
# --------------------------------------------------------------------------
for s in "${SVCS[@]}"; do
  if [ "$DRY" = 1 ]; then say "$s:"; fi
  for key in ${KEYS[$s]}; do
    id=$s/$key
    # Shared groups were handled above.
    [ -z "${KEY_GROUP[$id]:-}" ] || continue
    kind=${CLS_KIND[$id]:-${CLS_KIND[$key]:-}}
    arg=${CLS_ARG[$id]:-${CLS_ARG[$key]:-}}
    hint=${CLS_HINT[$id]:-${CLS_HINT[$key]:-}}
    raw=${CUR[$id]}; dec="$(decode "$raw")"
    appended=0; [ -z "${MISSING[$id]:-}" ] || appended=1

    if [ "$key" = DOMAIN ]; then
      if is_placeholder "$dec"; then
        NEW[$id]="$DEFAULT_DOMAIN"; plan default "$s" "$key" "$DEFAULT_DOMAIN"
      fi
      continue
    fi

    if [ -z "$kind" ]; then
      if [ -n "$dec" ] && is_placeholder "$dec" && [[ $key == *SECRET* || $key == *TOKEN* || $key == *KEY* || $key == *PASSWORD* ]]; then
        kind=gen; arg=hex:32
        PROMPTED_NOTE[$s]+="$key "
      elif [ -n "$dec" ] && is_placeholder "$dec"; then
        unresolved "$s" "$key" "unlisted placeholder: set it by hand (see .env.example)"
        plan unresolved "$s" "$key"
          continue
      else
        bump N_KEPT "$s"
        continue
      fi
    fi

    opt=0
    case $kind in tokenopt|valueopt) opt=1 ;; esac
    case $kind in
      skip) bump N_KEPT "$s"; continue ;;
      user)
        # Prompt on a new .env or an appended key (with the example default), or when still a placeholder.
        need=0
        is_placeholder "$dec" && need=1
        [ "${FRESH[$s]}" = 1 ] && need=1
        [ $appended = 1 ] && need=1
        ;;
      *) needs "$s" "$key" "$opt"; need=$NEED ;;
    esac
    if [ "$need" = 0 ]; then bump N_KEPT "$s"; continue; fi

    default=""; is_placeholder "$dec" || default=$dec
    ok=0
    case $kind in
      gen)
        if [ "$DRY" = 0 ]; then set_value "$s" "$key" "$(generate "$arg")"; else plan generate "$s" "$key" "$arg"; fi
        bump N_GEN "$s"; ok=1 ;;
      user)
        if [ "$DRY" = 1 ]; then
          plan prompt "$s" "$key" "name/e-mail${default:+, default $default}"; bump N_PROMPT "$s"; ok=1
        elif ask_plain "$s: $key" "$default"; then
          if [ -n "$ANSWER" ]; then
            [ "$ANSWER" = "$dec" ] || set_value "$s" "$key" "$ANSWER"
            bump N_PROMPT "$s"; ok=1
          fi
        elif [ -n "$default" ]; then
          # no TTY: the example default is a usable value; keep it
          bump N_KEPT "$s"; ok=1
        fi
        ;;
      pass)
        if [ "$DRY" = 1 ]; then
          plan prompt "$s" "$key" "password, empty = generate ($arg)"; bump N_PROMPT "$s"; ok=1
        elif ask_secret "$s: $key (leave empty to generate)" 1; then
          if [ -n "$ANSWER" ]; then set_value "$s" "$key" "$ANSWER"; bump N_PROMPT "$s"
          else set_value "$s" "$key" "$(generate "$arg")"; bump N_GEN "$s"
               PROMPTED_NOTE[$s]+="$key(generated: read it from .env) "; fi
          ok=1
        fi
        ;;
      passhash)
        if [ "$DRY" = 1 ]; then
          plan prompt "$s" "$key" "password, stored as double SHA-256"; bump N_PROMPT "$s"; ok=1
        elif ask_secret "$s: $key -- Pi-hole web password (stored hashed; Enter to skip)" 1; then
          if [ -n "$ANSWER" ]; then set_value "$s" "$key" "$(hash_pihole "$ANSWER")"; bump N_PROMPT "$s"; ok=1; fi
        fi
        ;;
      token|tokenopt)
        if [ "$DRY" = 1 ]; then
          plan prompt "$s" "$key" "$hint"; bump N_PROMPT "$s"; ok=1
        elif ask_secret "$s: $key -- $hint (Enter to skip)" 0; then
          if [ -n "$ANSWER" ]; then set_value "$s" "$key" "$ANSWER"; bump N_PROMPT "$s"; ok=1; fi
        fi
        ;;
      value|valueopt)
        if [ "$DRY" = 1 ]; then
          plan prompt "$s" "$key" "$hint"; bump N_PROMPT "$s"; ok=1
        elif ask_plain "$s: $key -- $hint (Enter to skip)" ""; then
          if [ -n "$ANSWER" ]; then set_value "$s" "$key" "$ANSWER"; bump N_PROMPT "$s"; ok=1; fi
        fi
        ;;
      manual) ;;
    esac
    if [ $ok = 0 ] && [ $opt = 1 ] && [ -z "$dec" ]; then bump N_KEPT "$s"; ok=1; fi
    if [ $ok = 0 ]; then
      unresolved "$s" "$key" "$hint"
      [ "$DRY" = 0 ] || plan unresolved "$s" "$key" "$kind${hint:+: $hint}"
    fi
  done
done

# --------------------------------------------------------------------------
# Apply
# --------------------------------------------------------------------------
write_env() {  # svc
  local s=$1 env="$ROOT/$1/.env" base tmp line key changed=0 bak line_out appended_keys=""
  base=${BASEFILE[$s]}
  # anything to do?
  local k
  for k in ${KEYS[$s]}; do
    [ -z "${NEW[$s/$k]+x}" ] || changed=1
    [ -z "${MISSING[$s/$k]:-}" ] || changed=1
  done
  [ "${FRESH[$s]}" = 1 ] && changed=1
  [ $changed = 1 ] || return 0

  tmp="$(mktemp "$env.XXXXXX")"
  chmod 600 "$tmp"
  {
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ $line =~ $ENV_LINE_RE ]] && [ -n "${NEW[$s/${BASH_REMATCH[2]}]+x}" ]; then
        printf '%s=%s\n' "${BASH_REMATCH[2]}" "${NEW[$s/${BASH_REMATCH[2]}]}"
      else
        printf '%s\n' "$line"
      fi
    done <"$base"
    for k in ${KEYS[$s]}; do
      [ -n "${MISSING[$s/$k]:-}" ] || continue
      if [ -z "$appended_keys" ]; then
        printf '\n# Added by scripts/setup-env.sh on %s (keys new in .env.example)\n' "$STAMP"
        appended_keys=1
      fi
      if [ -n "${NEW[$s/$k]+x}" ]; then printf '%s=%s\n' "$k" "${NEW[$s/$k]}"
      else printf '%s=%s\n' "$k" "${CUR[$s/$k]}"; fi
    done
  } >"$tmp"

  if [ "${FRESH[$s]}" = 0 ]; then
    bak="$env.bak.$STAMP"
    cp "$env" "$bak"; chmod 600 "$bak"; BACKUPS=$((BACKUPS + 1))
  fi
  mv "$tmp" "$env"; chmod 600 "$env"
}

BACKUPS=0
if [ "$DRY" = 0 ]; then
  for s in "${SVCS[@]}"; do write_env "$s"; done
fi

# --------------------------------------------------------------------------
# Summary (names only, never values)
# --------------------------------------------------------------------------
for s in "${SVCS[@]}"; do
  for k in ${KEYS[$s]}; do
    [ -z "${MISSING[$s/$k]:-}" ] || N_APPEND[$s]=$(( N_APPEND[$s] + 1 ))
  done
done
echo >&2
printf '%-24s %4s %6s %6s %6s %6s %6s\n' "Summary$([ "$DRY" = 1 ] && echo ' (plan)')" gen shared prompt append kept unres >&2
for s in "${SVCS[@]}"; do
  printf '%-24s %4d %6d %6d %6d %6d %6d\n' "$s" "${N_GEN[$s]}" "${N_SHARED[$s]}" "${N_PROMPT[$s]}" "${N_APPEND[$s]}" "${N_KEPT[$s]}" "${N_UNRES[$s]}" >&2
done
total=0
for s in "${SVCS[@]}"; do
  [ "${N_UNRES[$s]}" -gt 0 ] || continue
  total=$((total + ${N_UNRES[$s]}))
done
if [ $total -gt 0 ]; then
  echo >&2
  echo "Unresolved (still placeholders; names only):" >&2
  for s in "${SVCS[@]}"; do
    [ "${N_UNRES[$s]}" -gt 0 ] || continue
    for k in ${UNRES_KEYS[$s]}; do
      printf '  %s: %s%s\n' "$s" "$k" "${UNRES_HINT[$s/$k]:+  -- ${UNRES_HINT[$s/$k]}}" >&2
    done
  done
  [ "$INTERACTIVE" = 1 ] || echo "(stdin is not a terminal: prompts were skipped. Re-run interactively to fill them.)" >&2
fi
for s in "${SVCS[@]}"; do
  [ -z "${PROMPTED_NOTE[$s]:-}" ] || echo "Note: $s generated by name heuristic or by 'leave empty': ${PROMPTED_NOTE[$s]}" >&2
done
if [ "$DRY" = 0 ]; then
  echo >&2
  if [ "$BACKUPS" -gt 0 ]; then
    echo "Done. $BACKUPS backup(s) named .env.bak.$STAMP (mode 600); delete them once you have checked the result." >&2
  else
    echo "Done." >&2
  fi
fi
exit 0
