"""agents: ask_agent (a consult of another Hermes profile) plus delegate and task_status (Kanban cards).

The consult runs as a separate `hermes chat` process of the target profile
(plugins/agents/runner.py starts it), so the target uses its own toolsets, MCP
filters, SOUL and memory. The tool waits up to HERMES_ASK_AGENT_WAIT seconds
(default 120). When the answer is not ready by then, the job is marked
detached and the runner posts the answer to the Talk home room when it
finishes (bridge POST /deliver, same env as talk_send). Benchmark runs
(HERMES_BENCHMARK=1) kill the job instead and report a timeout.

delegate and task_status give ai-assistant a slim way to queue work and read its result without Hermes' 14-tool
`kanban` toolset: delegate creates one ready card (the dispatcher runs it as the assignee), task_status reads cards.

Profile list, keep in sync with start.sh (the 12 specialists that enable this
plugin or kanban_notify). Secrets come only from the process environment.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

PROFILES = (
    "calories", "finance", "nextcloud", "planner", "web-search", "n8n", "models",
    "hf-models", "ai-news", "selfhosted", "llamacpp-vulkan", "llamacpp-rocm",
)
JOBS = (
    ("calories", "food log and nutrition totals"),
    ("finance", "Firefly III spending, bills, subscriptions, transactions"),
    ("nextcloud", "files, contacts, notes, larger calendar work"),
    ("planner", "weekly review, wedding, meal and week plans, priorities"),
    ("web-search", "researched answers with sources"),
    ("n8n", "n8n workflows"),
    ("models", "llama.cpp models, presets, benchmarks"),
    ("hf-models", "new Hugging Face models"),
    ("ai-news", "r/LocalLLaMA"),
    ("selfhosted", "r/selfhosted and r/homelab"),
    ("llamacpp-vulkan", "llama.cpp changes and code questions"),
    ("llamacpp-rocm", "llama.cpp changes and code questions"),
)
MAX_CHAIN = 3
MAX_DETACHED = 3
MAX_REQUEST = 20000

ASK_AGENT_SCHEMA = {
    "name": "ask_agent",
    "description": (
        "Ask another Hermes profile to do something with its own tools and wait for its answer "
        "(up to 2 minutes; if it takes longer, the answer is posted to Talk later). Profiles:\n"
        + "\n".join(f"- {name}: {job}" for name, job in JOBS)
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "profile": {"type": "string", "enum": list(PROFILES), "description": "The profile to ask."},
            "request": {
                "type": "string",
                "description": "The full request: dates, amounts, names and what you want back. The profile sees only this text.",
            },
        },
        "required": ["profile", "request"],
    },
}

DELEGATE_SCHEMA = {
    "name": "delegate",
    "description": (
        "Queue work for another Hermes profile as a task card, for work the owner wants done later, by a deadline, "
        "or that clearly takes long. The card body is all the assignee sees, so write the request in full. The "
        "result is posted to Talk when it finishes."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "assignee": {"type": "string", "enum": list(PROFILES), "description": "The profile that does the work."},
            "title": {"type": "string", "description": "Short title, at most 200 characters."},
            "details": {
                "type": "string",
                "description": "The full request: dates, amounts, names and what you want back.",
            },
        },
        "required": ["assignee", "title", "details"],
    },
}

TASK_STATUS_SCHEMA = {
    "name": "task_status",
    "description": (
        "How a queued task is going: with card_id its status and result, without it your 5 most recent tasks."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "card_id": {"type": "string", "description": "Id returned by delegate; leave out to list recent tasks."},
        },
    },
}


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _int_env(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


def _benchmark() -> bool:
    return _env("HERMES_BENCHMARK") not in ("", "0")


def _caller_and_root() -> tuple[str, Path]:
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:
        home = Path(_env("HERMES_HOME") or ".")
    if home.parent.name == "profiles":
        return home.name, home.parent.parent
    return _env("HERMES_PROFILE") or "default", home


def _available() -> bool:
    try:
        _, root = _caller_and_root()
        return bool(shutil.which("hermes")) and (root / "profiles").is_dir()
    except Exception:
        return False


def _available_slim_kanban() -> bool:
    """delegate/task_status only where the full kanban toolset is absent (ai-assistant).

    The 12 specialists keep Hermes' own kanban toolset (owner's decision, 2026-11-06),
    so these two tools would only duplicate kanban_create/kanban_show there.
    """
    try:
        return _available() and _caller_and_root()[0] not in PROFILES
    except Exception:
        return False


def _chain() -> list[str]:
    return [p.strip() for p in _env("HERMES_ASK_AGENT_CHAIN").split(",") if p.strip()]


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


def _live_detached(base: Path) -> int:
    """Detached consults whose runner is still working (no result.json yet)."""
    count = 0
    now = time.time()
    for job in base.glob("*/"):
        try:
            if (job / "detached").exists() and not (job / "result.json").exists():
                if now - (job / "job.json").stat().st_mtime < _int_env("HERMES_ASK_AGENT_HARD_CAP", 1800) + 300:
                    count += 1
        except OSError:
            continue
    return count


def _cleanup_old(base: Path) -> None:
    """Drop job folders nobody collected (runner crash, lost waiter)."""
    cutoff = time.time() - (_int_env("HERMES_ASK_AGENT_HARD_CAP", 1800) + 3600)
    for job in base.glob("*/"):
        try:
            if job.name != "undelivered" and job.stat().st_mtime < cutoff:
                shutil.rmtree(job, ignore_errors=True)
        except OSError:
            continue


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _fail(message: str, **extra) -> str:
    return json.dumps({"ok": False, "error": message, **extra}, ensure_ascii=False)


def _finish(job: Path, root: Path, caller: str, profile: str, request: str, started: float) -> str:
    """Build the tool result from a finished job and remove the job folder."""
    try:
        result = json.loads(_read(job / "result.json") or "{}")
    except ValueError:
        result = {}
    answer = _read(job / "answer.txt").strip()
    stderr = _read(job / "stderr.txt").strip()
    seconds = round(time.time() - started, 1)
    shutil.rmtree(job, ignore_errors=True)
    code = result.get("exit")
    if result.get("timed_out") or code != 0:
        status = "timeout" if result.get("timed_out") else "error"
        _log(root, caller=caller, profile=profile, status=status, seconds=seconds, exit=code, request=request[:200])
        return _fail(
            f"{profile} did not finish ({'hard time limit' if result.get('timed_out') else 'exit ' + str(code)})",
            profile=profile, status=status, detail=stderr[-400:],
        )
    limit = _int_env("HERMES_ASK_AGENT_MAX_CHARS", 8000)
    _log(root, caller=caller, profile=profile, status="ok", seconds=seconds, exit=0, request=request[:200])
    return json.dumps({
        "ok": True, "profile": profile, "answer": answer[:limit] or "(no answer)", "seconds": seconds,
    }, ensure_ascii=False)


def _handle_ask_agent(args: dict, **kw) -> str:
    try:
        return _ask(args or {})
    except Exception as exc:
        return _fail(f"ask_agent failed: {exc!r}")


def _ask(args: dict) -> str:
    profile = str(args.get("profile") or "").strip()
    request = str(args.get("request") or "").strip()
    caller, root = _caller_and_root()
    if not request:
        return _fail("request is required")
    if profile not in PROFILES:
        return _fail(f"unknown profile {profile!r}; choose one of: {', '.join(PROFILES)}")
    chain = _chain()
    if profile == caller:
        return _fail("You cannot ask your own profile; do the work yourself.")
    if profile in chain:
        return _fail(f"{profile} is already part of this consult chain ({' > '.join(chain + [caller])}); do not ask it again.")
    if len(chain) >= MAX_CHAIN:
        return _fail("Too many nested consults; answer with what you have.")
    if not (root / "profiles" / profile).is_dir():
        return _fail(f"profile {profile} is not available here")
    if not shutil.which("hermes"):
        return _fail("the hermes command is not available here")
    base = root / "cache" / "ask_agent"
    base.mkdir(parents=True, exist_ok=True)
    _cleanup_old(base)
    if _live_detached(base) >= MAX_DETACHED:
        return _fail(f"{MAX_DETACHED} consults are still running in the background; wait for their answers first.")

    suffix = (
        f"You were consulted by the {caller} profile on the owner's behalf. State exactly what you created, "
        "changed or found, from your tool results. If something essential is missing, ask one short question "
        "instead of guessing."
    )
    if caller == "ai-assistant":
        suffix += " Your answer will be read aloud: plain sentences, no Markdown, links or ids."
    job = base / uuid.uuid4().hex
    job.mkdir(parents=True)
    (job / "query.txt").write_text(request[:MAX_REQUEST] + "\n\n" + suffix + "\n", encoding="utf-8")
    (job / "job.json").write_text(json.dumps({
        "id": job.name,
        "profile": profile,
        "caller": caller,
        "chain": chain,
        "model": _env("HERMES_ASK_AGENT_MODEL"),
        "hard_cap": _int_env("HERMES_ASK_AGENT_HARD_CAP", 1800),
        "benchmark": _benchmark(),
        "root": str(root),
        "request": request[:200],
    }), encoding="utf-8")
    started = time.time()
    with (job / "runner.out").open("wb") as out:
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("runner.py")), str(job)],
            stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
            start_new_session=True, close_fds=True,
        )
    # Reap the runner so a long-lived gateway never collects zombies.
    threading.Thread(target=proc.wait, daemon=True).start()

    deadline = started + _int_env("HERMES_ASK_AGENT_WAIT", 120)
    result = job / "result.json"
    while time.time() < deadline:
        if result.exists():
            return _finish(job, root, caller, profile, request, started)
        time.sleep(0.5)

    lock = open(job / "lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if result.exists():
            return _finish(job, root, caller, profile, request, started)
        seconds = round(time.time() - started, 1)
        if _benchmark():
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except OSError:
                pass
            _log(root, caller=caller, profile=profile, status="timeout", seconds=seconds, exit=None, request=request[:200])
            threading.Timer(5.0, shutil.rmtree, args=(job,), kwargs={"ignore_errors": True}).start()
            return _fail(f"{profile} did not answer within {seconds:.0f} s", profile=profile, status="timeout")
        (job / "detached").write_text("1")
        _log(root, caller=caller, profile=profile, status="running", seconds=seconds, exit=None, request=request[:200])
    finally:
        lock.close()
    return json.dumps({
        "ok": True,
        "status": "running",
        "profile": profile,
        "message": "Still working after 2 minutes; the answer will be posted to Talk.",
    }, ensure_ascii=False)


def _handle_delegate(args: dict, **kw) -> str:
    try:
        return _delegate(args or {})
    except Exception as exc:
        return _fail(f"delegate failed: {exc!r}")


def _delegate(args: dict) -> str:
    assignee = str(args.get("assignee") or "").strip()
    title = " ".join(str(args.get("title") or "").split())
    details = str(args.get("details") or "").strip()
    caller, _ = _caller_and_root()
    if assignee not in PROFILES:
        return _fail(f"unknown assignee {assignee!r}; choose one of: {', '.join(PROFILES)}")
    if assignee == caller:
        return _fail("You cannot delegate to your own profile; do the work yourself.")
    if not title:
        return _fail("title is required")
    if not details:
        return _fail("details is required: the assignee sees only the card body")
    title = title[:200]
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        # Same defaults as a top-level kanban_create from a chat: scratch workspace, priority 0, no parents, so
        # the card starts as "ready" and the gateway dispatcher spawns the assignee within one tick.
        card_id = kb.create_task(
            conn, title=title, body=details[:MAX_REQUEST], assignee=assignee, created_by=caller,
        )
    finally:
        conn.close()
    return json.dumps({
        "ok": True, "card_id": card_id, "assignee": assignee, "title": title,
        "message": f"Queued for {assignee}; the result will be posted to Talk when it finishes.",
    }, ensure_ascii=False)


def _handle_task_status(args: dict, **kw) -> str:
    try:
        return _task_status(args or {})
    except Exception as exc:
        return _fail(f"task_status failed: {exc!r}")


def _task_status(args: dict) -> str:
    card_id = str(args.get("card_id") or "").strip()
    caller, _ = _caller_and_root()
    from hermes_cli import kanban_db as kb

    conn = kb.connect()
    try:
        if card_id:
            task = kb.get_task(conn, card_id)
            if task is None:
                return _fail(f"no task {card_id}")
            text = kb.latest_summary(conn, card_id) or task.result or ""
            if not text:
                comments = kb.list_comments(conn, card_id)
                text = comments[-1].body if comments else (task.last_failure_error or "")
            return json.dumps({
                "ok": True, "card_id": task.id, "title": task.title, "assignee": task.assignee,
                "status": task.status, "result": str(text or "")[:1500],
            }, ensure_ascii=False)
        rows = conn.execute(
            "SELECT id, title, assignee, status FROM tasks WHERE created_by = ? AND status != 'archived' "
            "ORDER BY created_at DESC, id DESC LIMIT 5",
            (caller,),
        ).fetchall()
        return json.dumps({
            "ok": True,
            "tasks": [{"card_id": r["id"], "title": r["title"], "assignee": r["assignee"], "status": r["status"]} for r in rows],
        }, ensure_ascii=False)
    finally:
        conn.close()


def register(ctx) -> None:
    ctx.register_tool(
        name="ask_agent",
        toolset="agents",
        schema=ASK_AGENT_SCHEMA,
        handler=_handle_ask_agent,
        check_fn=_available,
        description="Ask another Hermes profile and wait up to two minutes for its answer",
        emoji="🤝",
    )
    ctx.register_tool(
        name="delegate",
        toolset="agents",
        schema=DELEGATE_SCHEMA,
        handler=_handle_delegate,
        check_fn=_available_slim_kanban,
        description="Queue work for another Hermes profile as a task card",
        emoji="📌",
    )
    ctx.register_tool(
        name="task_status",
        toolset="agents",
        schema=TASK_STATUS_SCHEMA,
        handler=_handle_task_status,
        check_fn=_available_slim_kanban,
        description="Status and result of queued tasks",
        emoji="📋",
    )
