"""Prompt-cache priming for one Hermes profile (HERMES_PRIME_PROFILE, default "default").

llama.cpp keeps a prompt cache per slot and reuses the longest common prefix
of a new request. The default profile's first call is ~35-38k tokens (system
prompt + ~28k of tool schemas) and takes ~30 s to evaluate after the model was
(re)loaded or its slot was reused. This plugin

1. captures, through an LLM request middleware (a pure observer: it returns
   nothing), the exact provider payload (model, system prompt, tool schemas,
   sampling options) of the first call of every API-server session of every
   profile and saves the latest as ``cache/prime/<profile>.json``
   with the user message replaced by "ping" (no user text is stored; the API
   key is never stored), and
2. in the gateway process only, first rebuilds the template of the primed profile from
   the live configuration (``_build_template``: an AIAgent built like the API
   server builds it, but with no session DB, then ``_build_system_prompt`` and
   ``_build_api_kwargs``; nothing is sent to a model, no session is created and the
   memory provider is only configured), at start and whenever the profile's
   config.yaml or SOUL.md changes, so slot priming never lags behind the real first
   call until the owner happens to start a chat. A captured real request (step 1)
   overwrites it and is the source of truth; verified byte-identical (system
   prompt, tools, keys) to a real API request. Then it
   replays the configured profile's payload with ``max_tokens`` 1,
   without streaming, straight to llama.cpp whenever the primed slot is idle and
   the cache looks cold (model just loaded, or the last priming is older than
   HERMES_PRIME_STALE seconds). No Hermes session, Talk message or memory write
   is involved.

Settings (environment): HERMES_PRIME_PROFILE (profile to prime), HERMES_PRIME_INTERVAL seconds between checks (default
120, 0 disables the replay), HERMES_PRIME_STALE seconds after which a priming
is repeated (default 600), HERMES_SLOT_PRIMED slot that holds the primed prompt (default 1; the ai-assistant
profile's requests are pinned to it by start.sh, all other profiles to HERMES_SLOT_OTHERS).
The slot and prompt length of the last priming are kept in
cache/prime/state.json, so a restart of the container re-primes the same slot.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

_DROP = {"timeout", "http_client", "extra_headers", "extra_body", "stream", "stream_options", "max_tokens", "max_completion_tokens"}


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME", "/home/hermes/.hermes"))


def _base_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/home/hermes/.hermes"))


def _profile() -> str:
    """Name of the profile making the current call ("default" or its folder)."""
    home, base = _home().resolve(), _base_home().resolve()
    return "default" if home == base else home.name


def _dir() -> Path:
    d = _base_home() / "cache" / "prime"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _capture(request=None, platform="", api_call_count=0, base_url="", **_ctx):
    """LLM request middleware: remember the default profile's first call."""
    try:
        if platform != "api_server" or api_call_count != 1 or not isinstance(request, dict):
            return None
        profile = _profile()
        msgs = request.get("messages")
        if not (isinstance(msgs, list) and len(msgs) == 2 and msgs[0].get("role") == "system"
                and msgs[1].get("role") == "user"):
            return None
        _store(profile, request, str(base_url or ""))
    except Exception as err:  # never disturb a request
        logger.debug("prompt_prime capture failed: %s", err)
    return None


def _build_template(profile: str) -> bool:
    """Write ``cache/prime/<profile>.json`` as the API server would send it now.

    Builds an AIAgent exactly as ``APIServerAdapter._create_agent`` does (same
    runtime resolution, toolsets and profile scope) but with no session DB, then
    takes the first-turn system prompt (``_build_system_prompt``, what
    ``run_conversation`` builds for a new session) and the request kwargs
    (``_build_api_kwargs``). Nothing is sent to the model, no session is created
    and the memory provider is only configured, never called.
    """
    from gateway.platforms.api_server import APIServerAdapter
    from gateway.run import _profile_runtime_scope
    from hermes_cli.profiles import get_profile_dir

    class _Builder(APIServerAdapter):
        def __init__(self):  # no network listener, no stores
            self._last_resolved_model = {}
            self._model_name = "hermes-agent"

        def _session_model_override_for(self, session_key):
            return None

        def _ensure_session_db(self):
            return None

    home = _base_home() if profile == "default" else Path(get_profile_dir(profile))
    with _profile_runtime_scope(home):
        agent = _Builder()._create_agent(session_id="prompt-prime-build")
        try:
            system = agent._build_system_prompt(None)
            kwargs = agent._build_api_kwargs(
                [{"role": "system", "content": system}, {"role": "user", "content": "ping"}])
            base_url = str(getattr(agent, "base_url", "") or "")
        finally:
            agent._memory_manager = None  # never run shutdown/retain hooks
    return _store(profile, kwargs, base_url)


def _store(profile: str, request: dict, base_url: str) -> bool:
    """Save a template like ``_capture`` does; True when the file changed."""
    body = {k: v for k, v in request.items() if k not in _DROP}
    body.update(request.get("extra_body") or {})
    msgs = request["messages"]
    body["messages"] = [msgs[0], {"role": "user", "content": "ping"}]
    raw = json.dumps({"base_url": base_url, "body": body}, ensure_ascii=False)
    target = _dir() / f"{profile}.json"
    if target.exists() and target.read_text() == raw:
        return False
    tmp = target.with_suffix(".tmp")
    tmp.write_text(raw)
    os.chmod(tmp, 0o600)
    tmp.replace(target)
    logger.info("prompt_prime: stored %s template (%d tools, %d chars)",
                profile, len(body.get("tools") or []), len(raw))
    return True


def _profile_stamp(profile: str) -> tuple:
    home = _base_home() if profile == "default" else _base_home() / "profiles" / profile
    out = []
    for name in ("config.yaml", "SOUL.md"):
        try:
            out.append(os.stat(home / name).st_mtime)
        except OSError:
            out.append(0)
    return tuple(out)


def _call(url: str, key: str, body=None, timeout=20):
    req = urllib.request.Request(
        url, json.dumps(body).encode() if body is not None else None,
        {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _state_file() -> Path:
    return _dir() / "state.json"


def _save_state(state: dict) -> None:
    try:
        tmp = _state_file().with_suffix(".tmp")
        tmp.write_text(json.dumps(state))
        tmp.replace(_state_file())
    except Exception as err:
        logger.debug("prompt_prime: state not saved: %s", err)


def _prime_once(state: dict) -> None:
    profile = os.environ.get("HERMES_PRIME_PROFILE") or "default"
    template = _dir() / f"{profile}.json"
    if not template.is_file():
        return
    doc = json.loads(template.read_text())
    body = doc["body"]
    # The live production model, not the one stored with the template: after a
    # HERMES_MODEL switch the old name is never "loaded" and priming stopped.
    model = os.environ.get("HERMES_SELECTED_MODEL") or os.environ.get("HERMES_MODEL") or body.get("model")
    body = {**body, "model": model}
    key = os.environ.get("LLAMA_API_KEY", "")
    root = (os.environ.get("HERMES_INFERENCE_BASE_URL") or doc.get("base_url") or "").rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    if not (root and model):
        return
    listing = _call(f"{root}/models", key)
    status = {m["id"]: (m.get("status") or {}).get("value") for m in listing.get("data", [])}
    if status.get(model) != "loaded":
        return
    slots = _call(f"{root}/slots?model={model}", key)
    # Only the primed slot has to be idle: other slots are pinned to other
    # clients (Hindsight can keep slot 2 busy for minutes).
    if any(s.get("is_processing") for s in slots if s.get("id") == int(os.environ.get("HERMES_SLOT_PRIMED", "1"))):
        return
    stale = float(os.environ.get("HERMES_PRIME_STALE", "600"))
    # The primed prompt lives in one reserved slot (HERMES_SLOT_PRIMED, default
    # 1); the ai-assistant profile's own requests carry the same id_slot (start.sh)
    # and everything else is pinned to other slots, so nothing evicts it.
    slot = int(os.environ.get("HERMES_SLOT_PRIMED", "1"))
    mine = {s["id"]: s for s in slots}.get(slot)
    if mine is None:
        return
    still_mine = bool(mine.get("n_prompt_tokens") == state.get("n_prompt_tokens") and state.get("slot") == slot)
    # A different profile, or a template rewritten since the last priming (new
    # system prompt or tools), makes the primed prefix obsolete.
    current = state.get("profile") == profile and state.get("mtime") == template.stat().st_mtime
    if still_mine and current and time.time() - state.get("at", 0) < stale:
        return
    t0 = time.time()
    _call(f"{root}/v1/chat/completions", key,
          {**body, "stream": False, "max_tokens": 1, "id_slot": slot, "cache_prompt": True},
          timeout=300)
    after = {s["id"]: s for s in _call(f"{root}/slots?model={model}", key)}.get(slot, {})
    state.update(slot=slot, n_prompt_tokens=after.get("n_prompt_tokens"), at=time.time(),
                 profile=profile, mtime=template.stat().st_mtime)
    _save_state(state)
    logger.info("prompt_prime: primed %s in slot %s (%s tokens) in %.1fs", profile, slot, state["n_prompt_tokens"], time.time() - t0)


def _loop() -> None:
    lock = open(_dir() / ".lock", "w")
    while True:  # one priming loop per container, whoever holds the lock
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            time.sleep(60)
    interval = float(os.environ.get("HERMES_PRIME_INTERVAL", "120"))
    try:  # keep slot ownership across a hermes-api restart
        state: dict = json.loads(_state_file().read_text())
    except Exception:
        state = {}
    time.sleep(30)
    profile = os.environ.get("HERMES_PRIME_PROFILE") or "default"
    stamp = None
    while True:
        try:
            now = _profile_stamp(profile)
            if now != stamp:  # first pass, or config.yaml / SOUL.md changed
                stamp = now
                try:
                    _build_template(profile)
                except Exception as err:
                    logger.warning("prompt_prime: template build failed (keeping the old one): %s", err)
            _prime_once(state)
        except Exception as err:
            logger.warning("prompt_prime: %s", err)
        time.sleep(interval)


def register(ctx) -> None:
    ctx.register_middleware("llm_request", _capture)
    argv = " ".join(sys.argv)
    if "gateway" in argv and " run" in argv and float(os.environ.get("HERMES_PRIME_INTERVAL", "120")) > 0:
        threading.Thread(target=_loop, name="prompt-prime", daemon=True).start()
