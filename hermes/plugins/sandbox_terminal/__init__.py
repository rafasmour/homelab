"""sandbox_terminal: per-profile SSH sandboxes for the terminal and file tools.

Why a plugin instead of ``terminal.backend: ssh``:

- The default gateway multiplexes every profile in one process
  (/p/<profile>/v1). The built-in terminal tool reads its settings from
  process-wide TERMINAL_* variables, bridged once from the default profile's
  config, so a per-profile ``terminal.ssh_host`` is ignored there and every
  profile would share one backend (or run locally inside hermes-api).
  This backend ("sandbox_ssh") resolves the sandbox from the *current*
  profile's config.yaml on every environment creation and refuses to run for
  a profile without one. Nothing ever runs inside hermes-api.
- The built-in SSH backend hard-codes StrictHostKeyChecking=accept-new. This
  one pins the sandbox host key (per-profile known_hosts, strict checking)
  and offers only that profile's key (IdentitiesOnly).

Profile config (written by hermes/start.sh)::

    terminal:
      backend: sandbox_ssh
    homelab_sandbox:
      host: sbx-coding
      user: hermes
      port: 22
      key: /home/hermes/.hermes/sandbox-keys/coding/id_ed25519
      known_hosts: /home/hermes/.hermes/sandbox-keys/coding/known_hosts
      cwd: /work
      talk_approvals: true          # see below
      extra_dangerous:              # extra commands that need approval
        - {pattern: <regex>, description: <text>}

Local mode (CLI-only profiles coding and devops, launched with ``hermes-sandbox``)::

    homelab_sandbox:
      mode: local
      talk_approvals: false
      extra_dangerous: [...]

The whole Hermes process already runs inside a throwaway hermes-sandbox
container, so the terminal runs there with Hermes' own local backend (cwd =
the mounted folder). This is allowed only when HERMES_LOCAL_SANDBOX=1 (set
solely by the hermes-sandbox image and compose file); anywhere else, e.g.
``hermes -p devops`` inside hermes-api, the backend refuses to run. The
extra_dangerous rules still go through the pre_tool_call gate (Hermes'
interactive approval prompt).

Talk approvals: Talk turns run ``hermes chat -q`` inside
hermes-nextcloud-bridge, where Hermes has no interactive approval prompt
(approvals.single_query_mode). With ``talk_approvals`` the profile sets
single_query_mode: approve and this plugin's pre_tool_call hook becomes the
gate: a risky terminal command prints the bridge's approval marker
("DANGEROUS COMMAND: ... Choice [...]") on stdout and blocks until the bridge
(TALK_APPROVAL_PROMPTS=1) writes the owner's answer to stdin: o(nce),
s(ession) or d(eny). No answer, EOF or a timeout denies. The marker lines
start with "│", which the bridge strips from the posted reply. Because the
same plugin provides the terminal backend, the terminal cannot run without
this gate being loaded.
"""

from __future__ import annotations

import logging
import os
import re
import select
import shlex
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

logger = logging.getLogger(__name__)

BACKEND = "sandbox_ssh"
_APPROVAL_TIMEOUT = int(os.environ.get("SANDBOX_APPROVAL_TIMEOUT", "900"))
_approved_patterns: set[str] = set()
_prompt_lock = threading.Lock()


def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()).resolve()


def _sandbox_config(home: Optional[Path] = None) -> Dict[str, Any]:
    home = home or _home()
    try:
        data = yaml.safe_load((home / "config.yaml").read_text()) or {}
    except Exception:
        return {}
    cfg = data.get("homelab_sandbox")
    return cfg if isinstance(cfg, dict) else {}


# ---------------------------------------------------------------------------
# Terminal backend
# ---------------------------------------------------------------------------

def _make_environment_class():
    from tools.environments.ssh import SSHEnvironment, _SSH_MULTIPLEX

    class SandboxSSHEnvironment(SSHEnvironment):
        """SSHEnvironment with a pinned host key and a bound profile home.

        The class name contains "SSH" on purpose: file tools classify the
        backend by class name and then treat paths like the built-in ssh
        backend (remote paths, no host-side resolution).
        """

        def __init__(self, *, profile_home: Path, known_hosts: str, **kwargs):
            self._profile_home = profile_home
            self._known_hosts = known_hosts
            super().__init__(**kwargs)

        def _build_ssh_command(self, extra_args: list | None = None) -> list:
            cmd = ["ssh"]
            if _SSH_MULTIPLEX:
                cmd += ["-o", f"ControlPath={self.control_socket}",
                        "-o", "ControlMaster=auto", "-o", "ControlPersist=300"]
            cmd += [
                "-F", "/dev/null",
                "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=yes",
                "-o", f"UserKnownHostsFile={self._known_hosts}",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "IdentitiesOnly=yes",
                "-o", "ConnectTimeout=10",
                "-o", "ServerAliveInterval=30",
            ]
            if self.port != 22:
                cmd += ["-p", str(self.port)]
            if self.key_path:
                cmd += ["-i", self.key_path]
            if extra_args:
                cmd += extra_args
            cmd.append(f"{self.user}@{self.host}")
            return cmd

        def _scp_upload(self, host_path: str, remote_path: str) -> None:
            # Same pinned SSH options as every other call (the built-in scp
            # path would fall back to the default known_hosts).
            import subprocess

            from tools.environments.base import EnvironmentConnectionError

            parent = os.path.dirname(remote_path) or "."
            cmd = self._build_ssh_command()
            cmd.append(f"mkdir -p {shlex.quote(parent)} && cat > {shlex.quote(remote_path)}")
            with open(host_path, "rb") as source:
                result = subprocess.run(cmd, stdin=source, capture_output=True, timeout=30)
            if result.returncode != 0:
                raise EnvironmentConnectionError(
                    "sandbox upload failed: " + result.stderr.decode(errors="replace").strip()
                )

        def _check_profile(self) -> None:
            current = _home()
            if current != self._profile_home:
                raise RuntimeError(
                    "sandbox_terminal: this terminal belongs to another Hermes profile "
                    f"({self._profile_home.name}); refusing to run for {current.name}."
                )

        def execute(self, command: str, cwd: str = "", **kwargs):
            self._check_profile()
            # The multiplexed gateway passes the default profile's TERMINAL_CWD;
            # host paths mean nothing in the sandbox.
            if cwd and (cwd in ("/root", "/opt/data") or cwd.startswith("/home/hermes/.hermes")):
                cwd = ""
            return super().execute(command, cwd, **kwargs)

    return SandboxSSHEnvironment


try:
    from agent.terminal_env_provider import TerminalEnvironmentProvider
except Exception:  # pragma: no cover - older Hermes
    TerminalEnvironmentProvider = object  # type: ignore[misc,assignment]


class SandboxSSHProvider(TerminalEnvironmentProvider):
    is_remote = True
    is_container = False

    @property
    def name(self) -> str:
        return BACKEND

    @property
    def display_name(self) -> str:
        return "Homelab SSH sandbox"

    @property
    def description(self) -> str:
        return "Run commands in this profile's SSH sandbox (hermes-sandboxes stack)."

    @property
    def skip_container_guards(self) -> bool:
        # Sandboxes mount real host paths (and devops the Docker socket).
        return False

    @property
    def cache_path_base(self) -> Optional[str]:
        return "~/.hermes"

    @property
    def env_description(self) -> str:
        return "this profile's Debian SSH sandbox (Linux)"

    def is_available(self) -> bool:
        return True

    def check_requirements(self, config: Dict[str, Any]) -> bool:
        return True

    def create_environment(self, *, cwd: str, timeout: int, task_id: str = "default", **kwargs):
        home = _home()
        cfg = _sandbox_config(home)
        if cfg.get("mode") == "local":
            if os.environ.get("HERMES_LOCAL_SANDBOX") != "1":
                raise RuntimeError(
                    f"sandbox_terminal: profile {home.name!r} runs its terminal only "
                    "inside a hermes-sandbox container (start it with `hermes-sandbox`); "
                    "refusing to run commands here."
                )
            from tools.environments.local import LocalEnvironment

            return LocalEnvironment(cwd=os.getcwd(), timeout=int(timeout or 3600))
        host = str(cfg.get("host") or "").strip()
        if not host:
            raise RuntimeError(
                f"sandbox_terminal: profile {home.name!r} has no SSH sandbox; "
                "this profile cannot run terminal or file tools."
            )
        cls = _make_environment_class()
        return cls(
            profile_home=home,
            known_hosts=str(cfg.get("known_hosts") or ""),
            host=host,
            user=str(cfg.get("user") or "hermes"),
            port=int(cfg.get("port") or 22),
            key_path=str(cfg.get("key") or ""),
            cwd=str(cfg.get("cwd") or "~"),
            timeout=int(timeout or 3600),
        )


# ---------------------------------------------------------------------------
# Talk approvals for one-shot (-q) runs started by hermes-nextcloud-bridge
# ---------------------------------------------------------------------------

def _extra_danger(command: str, rules) -> Optional[str]:
    """Return the description of the first matching homelab rule.

    A rule is {"pattern": <regex>, "description": <text>} (or a bare regex).
    """
    for rule in rules or []:
        if isinstance(rule, dict):
            pattern = str(rule.get("pattern") or "")
            description = str(rule.get("description") or pattern)
        else:
            pattern = description = str(rule)
        if not pattern:
            continue
        try:
            if re.search(pattern, command, re.IGNORECASE | re.MULTILINE):
                return f"homelab rule: {description}"
        except re.error:
            logger.warning("sandbox_terminal: bad extra_dangerous regex %r", pattern)
    return None


def _read_choice() -> str:
    """Read one answer line from stdin; "" on EOF, error or timeout."""
    deadline = time.monotonic() + _APPROVAL_TIMEOUT
    answer = b""
    while time.monotonic() < deadline:
        try:
            ready, _, _ = select.select([0], [], [], 1.0)
        except (OSError, ValueError):
            return ""
        if not ready:
            continue
        try:
            chunk = os.read(0, 64)
        except OSError:
            return ""
        if not chunk:  # EOF: nobody can answer
            return ""
        answer += chunk
        if b"\n" in answer:
            break
    return answer.decode("utf-8", "replace").strip().lower()[:1]


def _ask_owner(command: str, description: str) -> str:
    """Print the bridge's approval marker and read the answer from stdin."""
    body = "\n".join("│ " + line for line in command.splitlines() or [""])
    prompt = (
        "\n│ DANGEROUS COMMAND: " + description + "\n"
        + body + "\n"
        "│ Choice [o]nce/[s]ession/[d]eny: "
    )
    with _prompt_lock:
        try:
            os.write(1, prompt.encode("utf-8", "replace"))
        except OSError:
            return "deny"
        choice = _read_choice()
        decision = {"o": "once", "s": "session", "a": "session"}.get(choice, "deny")
        try:
            # Ends the marker line, so the bridge strips it from the reply.
            os.write(1, f"\n│ approval: {decision}\n".encode())
        except OSError:
            pass
    return decision


def _pre_tool_call(tool_name: str = "", args: Optional[dict] = None, **_: Any):
    if tool_name != "terminal":
        return None
    cfg = _sandbox_config()
    command = str((args or {}).get("command") or "")
    if not command.strip():
        return None
    if os.environ.get("HERMES_SINGLE_QUERY_SESSION") != "1":
        # Gateway/API turns: Hermes' own gate handles its dangerous patterns;
        # escalate the homelab extra rules to that same human gate.
        try:
            from tools.approval import detect_dangerous_command

            if detect_dangerous_command(command)[0]:
                return None
        except Exception:
            pass
        extra = _extra_danger(command, cfg.get("extra_dangerous"))
        if extra:
            return {"action": "approve", "message": extra, "rule_key": "homelab:" + extra}
        return None
    if not cfg.get("talk_approvals"):
        return None
    try:
        from tools.approval import detect_dangerous_command, detect_hardline_command

        if detect_hardline_command(command)[0]:
            return None  # Hermes blocks these unconditionally
        dangerous, pattern_key, description = detect_dangerous_command(command)
    except Exception as exc:  # fail closed
        return {"action": "block", "message": f"BLOCKED: approval check failed ({exc})."}
    if not dangerous:
        extra = _extra_danger(command, cfg.get("extra_dangerous"))
        if not extra:
            return None
        pattern_key, description = extra, extra
    if pattern_key in _approved_patterns:
        return None
    decision = _ask_owner(command, str(description))
    if decision == "deny":
        return {
            "action": "block",
            "message": (
                f"BLOCKED: the owner did not approve this command ({description}). "
                "Do not retry it or rephrase it to avoid the check; explain what you "
                "wanted to do and ask the owner how to proceed."
            ),
        }
    if decision == "session":
        _approved_patterns.add(pattern_key)
    return None


def register(ctx) -> None:
    ctx.register_terminal_environment_provider(SandboxSSHProvider())
    ctx.register_hook("pre_tool_call", _pre_tool_call)
