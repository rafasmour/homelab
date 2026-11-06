"""Runner for one ask_agent consult (started detached by plugins/agents/__init__.py).

Usage: runner.py <jobdir>. Reads job.json and query.txt, runs
`hermes chat --query-file query.txt --quiet --source tool` as the target
profile with stdin closed (a risky terminal command that needs approval is
denied on EOF), and writes answer.txt, stderr.txt and, last and atomically,
result.json. When the waiting tool call gave up (the "detached" marker, set
under the same file lock), the runner posts the answer to the Talk home room
itself and removes the job folder. Secrets come only from the environment.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MAX_CHARS = 30000
# Identity of a Kanban worker run; a consult started from inside a worker must
# not look like that card. HERMES_KANBAN_DB and HERMES_KANBAN_BOARD stay.
WORKER_VARS = (
    "HERMES_KANBAN_TASK", "HERMES_KANBAN_WORKSPACE", "HERMES_KANBAN_BRANCH",
    "HERMES_KANBAN_RUN_ID", "HERMES_KANBAN_CLAIM_LOCK", "HERMES_KANBAN_GOAL_MODE",
    "HERMES_KANBAN_GOAL_MAX_TURNS", "HERMES_SESSION_SOURCE", "HERMES_SOURCE",
    "HERMES_DELEGATED_CHILD_CONTEXT", "TERMINAL_CWD", "HERMES_TENANT",
    # The consult is a plain CLI run, not part of the gateway process.
    "_HERMES_GATEWAY", "HERMES_TUI", "HERMES_UI_SESSION_ID",
)
# Routing the gateway mirrors per turn (gateway/session_context.py _VAR_MAP);
# the Kanban dispatcher drops the same keys before it spawns a worker, so a
# consult never inherits the caller's chat, cron delivery or browser binding.
SESSION_PREFIXES = ("HERMES_SESSION_", "HERMES_CRON_", "HERMES_BROWSER_CONTROL_")


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _log(root: Path, **fields) -> None:
    try:
        path = root / "logs" / "ask_agent.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        line.update(fields)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _room(benchmark: bool) -> str:
    return _env("HERMES_BENCHMARK_TALK_ROOM") if benchmark else _env("NEXTCLOUD_TALK_HOME_ROOM")


def _deliver(message: str, benchmark: bool) -> str:
    """Post to the Talk home room through the bridge. Returns "" or an error text."""
    url, secret, room = _env("NEXTCLOUD_TALK_DELIVER_URL"), _env("NEXTCLOUD_TALK_DELIVER_SECRET"), _room(benchmark)
    if not (url and secret and room):
        return "Talk delivery is not configured (NEXTCLOUD_TALK_* env)"
    request = urllib.request.Request(
        url,
        data=json.dumps({"room_token": room, "message": message[:MAX_CHARS], "actor": "hermes-tool"}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return f"bridge HTTP {exc.code}: {exc.read(300).decode('utf-8', 'replace')}"
    except Exception as exc:
        return f"bridge unreachable: {exc!r}"
    try:
        data = json.loads(body) if body else {}
    except ValueError:
        data = {}
    if data.get("ok") is False:
        return str(data.get("error") or body[:300])
    return ""


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    job = Path(sys.argv[1])
    cfg = json.loads((job / "job.json").read_text(encoding="utf-8"))
    root = Path(cfg["root"])
    profile, caller = cfg["profile"], cfg["caller"]
    benchmark = bool(cfg.get("benchmark"))
    hard_cap = int(cfg.get("hard_cap") or 1800)

    env = dict(os.environ)
    for name in WORKER_VARS:
        env.pop(name, None)
    for name in [k for k in env if k.startswith(SESSION_PREFIXES)]:
        env.pop(name, None)
    env["HERMES_HOME"] = str(root / "profiles" / profile)
    env["HERMES_PROFILE"] = profile
    env["HERMES_ASK_AGENT_CHAIN"] = ",".join(list(cfg.get("chain") or []) + [caller])
    cmd = ["hermes", "chat", "--query-file", str(job / "query.txt"), "--quiet", "--source", "tool"]
    if cfg.get("model"):
        cmd += ["-m", str(cfg["model"])]

    started = time.time()
    child = None
    state = {"term": False}

    def stop(signum, frame):
        # The waiter (benchmark timeout) asks the runner to stop; take the
        # hermes process group down with it.
        state["term"] = True
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, stop)
    timed_out = False
    code = -1
    with (job / "answer.txt").open("wb") as out, (job / "stderr.txt").open("wb") as err:
        try:
            child = subprocess.Popen(
                cmd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                start_new_session=True, close_fds=True,
            )
            if state["term"]:
                os.killpg(child.pid, signal.SIGKILL)
            try:
                code = child.wait(timeout=hard_cap)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    pass
                code = child.wait()
        except Exception as exc:
            err.write(f"runner could not start hermes: {exc!r}\n".encode())
    seconds = round(time.time() - started, 1)
    if state["term"]:
        return 0
    _write_atomic(job / "result.json", json.dumps({"exit": code, "seconds": seconds, "timed_out": timed_out}))

    try:
        lock = open(job / "lock", "a")
    except OSError:
        return 0  # the waiter already collected and removed the job
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (job / "detached").exists():
            return 0  # the waiter reads the files
        answer = (job / "answer.txt").read_text(encoding="utf-8", errors="replace").strip()
        stderr = (job / "stderr.txt").read_text(encoding="utf-8", errors="replace").strip()
        ok = code == 0 and not timed_out
        body = (answer or "(no answer)") if ok else (
            f"did not finish ({'hard time limit' if timed_out else 'exit ' + str(code)}). {stderr[-400:]}"
        )
        message = f"{profile} (asked by {caller}): {body}"
        problem = _deliver(message, benchmark)
        if problem:
            undelivered = root / "cache" / "ask_agent" / "undelivered"
            undelivered.mkdir(parents=True, exist_ok=True)
            (undelivered / (cfg.get("id", job.name) + ".txt")).write_text(message, encoding="utf-8")
        _log(root, caller=caller, profile=profile, status="detached_done" if ok else "detached_failed",
             seconds=seconds, exit=code, delivered=not problem, error=problem or None,
             request=str(cfg.get("request", ""))[:200])
        shutil.rmtree(job, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
