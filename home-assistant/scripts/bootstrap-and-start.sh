#!/bin/bash
# Trust Traefik in the HTTP config store, drop legacy Hermes YAML, then start
# Home Assistant.
set -euo pipefail

python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

config_path = Path("/config/configuration.yaml")
storage_path = Path("/config/.storage/http")
text = config_path.read_text(encoding="utf-8") if config_path.exists() else "default_config:\n"

TRUSTED_PROXIES = [
    "172.16.0.0/12",
    "10.0.0.0/8",
    "192.168.0.0/16",
]
META_KEYS = ("created_at", "error", "error_message")
# The block this script used to write. Home Assistant imports http: YAML once,
# holds it as an unconfirmed trial for five minutes, then reverts it. Leaving
# the block in place makes Traefik requests return HTTP 400 after that revert.
MANAGED_HTTP = """http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12
    - 10.0.0.0/8
    - 192.168.0.0/16
"""


def strip_managed_http(text: str) -> str:
    if MANAGED_HTTP not in text:
        return text
    text = text.replace(MANAGED_HTTP, "")
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    if text and not text.endswith("\n"):
        text += "\n"
    return text


def meaningful(conf: dict) -> dict:
    return {key: value for key, value in conf.items() if key not in META_KEYS}


def with_trusted_proxies(conf: dict, created_at: str) -> dict:
    updated = dict(conf)
    proxies = list(updated.get("trusted_proxies") or [])
    for proxy in TRUSTED_PROXIES:
        if proxy not in proxies:
            proxies.append(proxy)
    updated["use_x_forwarded_for"] = True
    updated["trusted_proxies"] = proxies
    updated.setdefault("created_at", created_at)
    updated["error"] = None
    updated["error_message"] = None
    return updated


def strip_hermes_conversation(text: str) -> str:
    marker = "hermes_conversation:"
    if marker not in text:
        return text
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    skip = False
    for line in lines:
        stripped = line.lstrip()
        if not skip and stripped.startswith(marker):
            skip = True
            continue
        if skip:
            if stripped and not stripped.startswith(" ") and not stripped.startswith("\t"):
                skip = False
                out.append(line)
            continue
        out.append(line)
    return "".join(out)


text = strip_managed_http(text)
text = strip_hermes_conversation(text)
config_path.write_text(text, encoding="utf-8")

now = datetime.now(timezone.utc).isoformat()
if storage_path.exists():
    document = json.loads(storage_path.read_text(encoding="utf-8"))
    if document.get("version") != 2:
        raise SystemExit(
            f"Refusing to update {storage_path}: unexpected storage version "
            f"{document.get('version')}"
        )
else:
    document = {
        "version": 2,
        "minor_version": 2,
        "key": "http",
        "data": {
            "stable": {
                "server_port": 8123,
                "cors_allowed_origins": ["https://cast.home-assistant.io"],
                "login_attempts_threshold": -1,
                "ip_ban_enabled": True,
                "ssl_profile": "modern",
                "use_x_frame_options": True,
                "created_at": now,
                "error": None,
                "error_message": None,
            },
            "pending": None,
            "yaml_migration_done": True,
        },
    }

data = document["data"]
stable = with_trusted_proxies(data["stable"], now)
pending = data.get("pending")
if pending is not None and meaningful(pending) == meaningful(stable):
    pending = None
data["stable"] = stable
data["pending"] = pending
# YAML http config is no longer the source of truth. Marking the migration
# done keeps a later edit of configuration.yaml from replacing this store
# with another five-minute trial.
if "\nhttp:" not in f"\n{text}" and not text.startswith("http:"):
    data["yaml_migration_done"] = True

storage_path.parent.mkdir(parents=True, exist_ok=True)
temporary = storage_path.with_suffix(".http.tmp")
temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
temporary.replace(storage_path)
PY

exec /init
