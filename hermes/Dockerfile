# syntax=docker/dockerfile:1
#
# Hermes Agent with the homelab additions baked in, so nothing is installed or patched at container start:
#   - the Hermes-Relay server plugin (Android app), pinned by commit, with two small patches
#   - the Hindsight memory provider and its Python packages, pinned by commit/version
#   - the shared profile settings (profiles/_base/config.yaml) as Hermes' managed scope, /etc/hermes
#   - two s6 services (relay, dashboard) next to the image's own gateway/dashboard supervision
# The container still starts through the upstream entrypoint; docker-compose.yml only sets its command.
ARG HERMES_AGENT_VERSION=v0.23.2
FROM nousresearch/hermes-agent:${HERMES_AGENT_VERSION}

USER root

# Hermes-Relay server release server-v1.13.1. `hermes plugins install` refuses it (the install scanner rates the
# repository "dangerous"), so the plugin directory is downloaded from that exact commit.
ARG RELAY_REPO=Codename-11/hermes-relay
ARG RELAY_REF=da782a8d74eb6631ea2f097b3cc69c6452ec33de
# Hindsight Hermes integration: the commit Hermes' plugin catalog pins for `hermes plugins install hindsight`
# (plugin 1.2.4). Its packages are pinned to the versions that install resolved.
ARG HINDSIGHT_REPO=vectorize-io/hindsight
ARG HINDSIGHT_REF=f14cc1eb5624b0374cb4d82768eb2e0b9c21ae24
ARG HINDSIGHT_CLIENT_VERSION=1.2.1
ARG HINDSIGHT_EMBED_VERSION=1.2.1

# Python packages go into the image venv (the runtime venv is read-only for the hermes user). The constraint file
# freezes everything the image already has, so none of Hermes' own pins can move. PyYAML: the relay server imports
# it and Hermes >= 0.23 no longer ships it.
RUN set -eu; \
    uv="$(ls /opt/hermes/tools/uv-*/uv | head -n 1)"; \
    "$uv" pip freeze --python /opt/hermes/.venv/bin/python > /tmp/constraints.txt; \
    "$uv" pip install --quiet --python /opt/hermes/.venv/bin/python -c /tmp/constraints.txt \
        "hindsight-client==${HINDSIGHT_CLIENT_VERSION}" "hindsight-embed==${HINDSIGHT_EMBED_VERSION}" \
        "segno>=1.6.0,<2" "websocket-client>=1.8.0,<2" "pyyaml>=6.0,<7"; \
    rm -f /tmp/constraints.txt

# Hindsight memory provider as a bundled memory plugin (activated by memory.provider: hindsight).
RUN set -eu; \
    mkdir -p /tmp/hs /opt/hermes/plugins/memory/hindsight; \
    curl -fsSL --retry 3 "https://codeload.github.com/${HINDSIGHT_REPO}/tar.gz/${HINDSIGHT_REF}" \
        | tar -xz -C /tmp/hs --strip-components=3 --wildcards '*/hindsight-integrations/hermes'; \
    test -f /tmp/hs/plugin.yaml && test -f /tmp/hs/__init__.py; \
    cp -a /tmp/hs/. /opt/hermes/plugins/memory/hindsight/; \
    rm -rf /tmp/hs /opt/hermes/plugins/memory/hindsight/tests

# Hermes-Relay plugin: /opt/hermes-relay/plugin is the importable package `plugin` (the relay server and its
# launcher import plugin.relay.*), and the same directory is a bundled Hermes plugin named hermes-relay.
RUN set -eu; \
    mkdir -p /opt/hermes-relay/plugin; \
    curl -fsSL --retry 3 "https://codeload.github.com/${RELAY_REPO}/tar.gz/${RELAY_REF}" \
        | tar -xz -C /opt/hermes-relay/plugin --strip-components=2 --wildcards '*/plugin'; \
    test -f /opt/hermes-relay/plugin/plugin.yaml && test -f /opt/hermes-relay/plugin/relay/server.py; \
    ln -s /opt/hermes-relay/plugin /opt/hermes/plugins/hermes-relay

# Homelab patches to the relay (both fail the build when the pinned source no longer matches).
#  1. pair.py: read_server_config() derives the API address in pairing QRs from the bind address (0.0.0.0 ->
#     the container's Docker IP, plain http), which a phone cannot reach. HERMES_RELAY_PAIR_API_URL (the Traefik
#     URL) replaces host, port and TLS for dashboard and CLI pairing.
#  2. voice_lab/providers/openai_tts.py: the streaming openai_tts renderer only reads its endpoint from the app's
#     options or api.openai.com. HERMES_RELAY_OPENAI_TTS_URL (and _KEY) point it at the speech gateway, which
#     streams the assistant voice sentence by sentence.
RUN python - <<'PY'
from pathlib import Path

plugin = Path("/opt/hermes-relay/plugin")

pair = plugin / "pair.py"
src = pair.read_text()
anchor = "    if enabled is None:\n        enabled = bool(key)\n\n    return {\n        \"host\": host,"
if src.count(anchor) != 1:
    raise SystemExit("pair.py changed upstream: the HERMES_RELAY_PAIR_API_URL patch does not apply")
hook = (
    "    # homelab: HERMES_RELAY_PAIR_API_URL\n"
    "    _pub = os.getenv(\"HERMES_RELAY_PAIR_API_URL\", \"\").strip()\n"
    "    if _pub:\n"
    "        from urllib.parse import urlparse as _urlparse\n"
    "        _u = _urlparse(_pub)\n"
    "        if _u.hostname:\n"
    "            host = _u.hostname\n"
    "            tls = _u.scheme == \"https\"\n"
    "            port = _u.port or (443 if tls else 80)\n\n"
)
pair.write_text(src.replace(anchor, hook + anchor, 1))

tts = plugin / "voice_lab" / "providers" / "openai_tts.py"
src = tts.read_text()
url_old = '        base_url = (_option(options, "url") or DEFAULT_BASE_URL).rstrip("/")\n'
key_old = '    explicit = _option(options, "api_key") or _option(options, "openai_api_key")\n'
if src.count(url_old) != 1 or src.count(key_old) != 1:
    raise SystemExit("openai_tts.py changed upstream: the HERMES_RELAY_OPENAI_TTS_URL patch does not apply")
src = src.replace(
    url_old,
    "        # homelab: HERMES_RELAY_OPENAI_TTS_URL\n"
    "        base_url = (_option(options, \"url\") or os.getenv(\"HERMES_RELAY_OPENAI_TTS_URL\", \"\").strip() or DEFAULT_BASE_URL).rstrip(\"/\")\n",
    1,
)
src = src.replace(
    key_old,
    key_old
    + "    explicit = explicit or os.getenv(\"HERMES_RELAY_OPENAI_TTS_KEY\", \"\").strip()\n"
    + "    if explicit:\n"
    + "        return explicit\n",
    1,
)
tts.write_text(src)
PY

# Relay launcher: the relay itself has no switch for its terminal channel, which is a shell inside this
# secret-holding container, so it is refused unless HERMES_RELAY_TERMINAL_ENABLED is true.
COPY <<'PY' /opt/hermes-relay/launch.py
import os

from plugin.relay._env_bootstrap import load_hermes_env

load_hermes_env()
if os.environ.get("HERMES_RELAY_TERMINAL_ENABLED", "").strip().lower() not in ("1", "true", "yes", "on"):
    from plugin.relay.channels import terminal as _terminal

    async def _refuse(self, ws, envelope):
        await _terminal._send(
            ws,
            _terminal._make_envelope(
                "terminal.error",
                {"message": "Terminal is disabled on this server (HERMES_RELAY_TERMINAL_ENABLED=false)"},
                envelope.get("id"),
            ),
        )

    _terminal.TerminalHandler.handle = _refuse

from plugin.relay.server import main

main()
PY

# Shared profile settings as Hermes' managed scope (see profiles/_base/config.yaml).
COPY profiles/_base/config.yaml /etc/hermes/config.yaml

# s6 services next to the image's own. Same pattern as the image's dashboard service: the run script exits 0
# when the service is off and the finish script then returns 125 (permanent, no restart); when it is on and the
# process dies, s6 restarts it after a 30 s pause.
#  - hermes-relay: Hermes-Relay WebSocket server on 8767 (HERMES_RELAY_ENABLED)
#  - hermes-dashboard: web dashboard on 9119 (HERMES_DASHBOARD_ENABLED). The image's own `dashboard` service
#    (HERMES_DASHBOARD) cannot be used: it starts without --isolated, and `hermes dashboard` attaches to the
#    gateway's host backend (and refuses an explicit port) instead of binding 9119 whenever the gateway runs.
#    Its login comes from HERMES_DASHBOARD_BASIC_AUTH_* in the container environment.
COPY --chmod=755 <<'SH' /etc/s6-overlay/s6-rc.d/hermes-relay/run
#!/command/with-contenv sh
case "${HERMES_RELAY_ENABLED:-}" in
    1|true|TRUE|True|yes|YES|Yes|on) ;;
    *) exit 0 ;;
esac
export HOME=/opt/data
export PYTHONPATH=/opt/hermes-relay
export RELAY_HOST=0.0.0.0
export RELAY_PORT=8767
cd /opt/data
[ "$(id -u)" = 0 ] || exec python -P /opt/hermes-relay/launch.py --no-ssl
exec s6-setuidgid hermes python -P /opt/hermes-relay/launch.py --no-ssl
SH
COPY --chmod=755 <<'SH' /etc/s6-overlay/s6-rc.d/hermes-relay/finish
#!/command/with-contenv sh
case "${HERMES_RELAY_ENABLED:-}" in
    1|true|TRUE|True|yes|YES|Yes|on) sleep 30; exit 0 ;;
    *) exit 125 ;;
esac
SH
COPY --chmod=755 <<'SH' /etc/s6-overlay/s6-rc.d/hermes-dashboard/run
#!/command/with-contenv sh
case "${HERMES_DASHBOARD_ENABLED:-}" in
    1|true|TRUE|True|yes|YES|Yes|on) ;;
    *) exit 0 ;;
esac
export HOME=/opt/data
cd /opt/data
[ "$(id -u)" = 0 ] || exec hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build --isolated
exec s6-setuidgid hermes hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build --isolated
SH
COPY --chmod=755 <<'SH' /etc/s6-overlay/s6-rc.d/hermes-dashboard/finish
#!/command/with-contenv sh
case "${HERMES_DASHBOARD_ENABLED:-}" in
    1|true|TRUE|True|yes|YES|Yes|on) sleep 30; exit 0 ;;
    *) exit 125 ;;
esac
SH
RUN set -eu; \
    for svc in hermes-relay hermes-dashboard; do \
        d="/etc/s6-overlay/s6-rc.d/${svc}"; \
        printf 'longrun\n' > "${d}/type"; \
        printf '35000\n' > "${d}/timeout-finish"; \
        mkdir -p "${d}/dependencies.d"; \
        : > "${d}/dependencies.d/base"; \
        : > "/etc/s6-overlay/s6-rc.d/user/contents.d/${svc}"; \
    done

# The image's entrypoint and command (`hermes gateway run` is set in docker-compose.yml) are unchanged.
