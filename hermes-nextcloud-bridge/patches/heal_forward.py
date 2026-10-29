"""Build-time patch: forward /heal commands from the self-heal room.

Messages in the Talk room TALK_SELF_HEAL_ROOM never start a Hermes run. After
the /hook HMAC signature check, a human message in that room that matches

    /heal approve <RUN_ID> <6-digit code>
    /heal deny <RUN_ID>

or, for the single open run (the controller resolves it and asks for the ID when
several are open):

    fix | yes | approve | /heal approve      (+ optional 6-digit code)
    /heal <code>                              (6 digits)
    deny | no | /heal deny

is POSTed to the self-heal controller (SELF_HEAL_APPROVE_URL, default
http://self-heal:8790/approve) with Bearer SELF_HEAL_APPROVE_SECRET and
{"run_id", "decision", "code", "actor_id", "room_token"}; actor_id is the
actor of the signed Talk webhook. The controller checks the room, the actor
and the TOTP code, and posts the outcome to the room itself. Any other human
message in the room gets a one-line usage hint. The message text and the
code are never logged. Empty TALK_SELF_HEAL_ROOM turns the feature off.

Apply after room_profiles.py and error_reason.py. Every replacement must match
exactly once, so a bridge upgrade that moves this code fails the image build.
"""

import sys
from pathlib import Path

HELPER = r'''SELF_HEAL_ROOM = os.environ.get("TALK_SELF_HEAL_ROOM", "").strip()
SELF_HEAL_APPROVE_URL = os.environ.get("SELF_HEAL_APPROVE_URL", "").strip() or "http://self-heal:8790/approve"
_HEAL_COMMAND = re.compile(
    r"^/heal\s+(approve|deny)\s+([A-Za-z2-7]{6})(?:\s+(\d{6}))?\s*$",
    re.IGNORECASE | re.ASCII,
)
# Shorthand without a run id: the controller resolves the single open run.
_HEAL_SHORT_APPROVE = re.compile(
    r"^(?:(?:fix|yes|approve|/heal\s+approve)(?:\s+(\d{6}))?|/heal\s+(\d{6}))\s*$",
    re.IGNORECASE | re.ASCII,
)
_HEAL_SHORT_DENY = re.compile(r"^(?:deny|no|/heal\s+deny)\s*$", re.IGNORECASE | re.ASCII)
_HEAL_USAGE = "Self-heal room: reply `fix` (add the 6-digit code when the controller asks for one) or `deny`; with several open runs `/heal approve <RUN_ID>` or `/heal deny <RUN_ID>`. Nothing else is read here."


def _heal_parse(text: str):
    """(decision, run_id or None, code or None), or None when text is not a command."""
    match = _HEAL_SHORT_APPROVE.match(text)
    if match:
        return "approve", None, match.group(1) or match.group(2)
    match = _HEAL_COMMAND.match(text)
    if match:
        return match.group(1).lower(), match.group(2).upper(), match.group(3)
    if _HEAL_SHORT_DENY.match(text):
        return "deny", None, None
    return None


def _heal_message_text(payload: dict) -> str | None:
    """Plain text of a human Create/Note message, or None (bots, files, other events)."""
    actor_id = str((payload.get("actor") or {}).get("id") or "")
    if not actor_id or "/bot-" in actor_id or actor_id.startswith("bots/"):
        return None
    if payload.get("type") != "Create":
        return None
    obj = payload.get("object") or {}
    if not isinstance(obj, dict) or obj.get("type") not in (None, "Note"):
        return None
    raw = obj.get("content") or ""
    try:
        content = json.loads(raw) if raw else {}
    except Exception:
        content = {"message": raw}
    msg = content.get("message", "") if isinstance(content, dict) else ""
    if not isinstance(msg, str):
        return None
    return strip_msg(msg)


def _heal_forward(payload: dict) -> None:
    token = SELF_HEAL_ROOM
    obj = payload.get("object") or {}
    try:
        message_id = int(obj.get("id", 0) or 0)
    except (TypeError, ValueError):
        message_id = 0
    text = _heal_message_text(payload)
    if text is None:
        return
    parsed = _heal_parse(text)
    if parsed is None:
        log(f"self-heal room: ignored non-command message id={message_id}")
        post(token, _HEAL_USAGE, message_id)
        return
    decision, run_id, code = parsed
    body = json.dumps({
        "run_id": run_id,
        "decision": decision,
        "code": code,
        "actor_id": str((payload.get("actor") or {}).get("id") or ""),
        "room_token": token,
    }).encode("utf-8")
    secret = os.environ.get("SELF_HEAL_APPROVE_SECRET", "")
    if not secret:
        log("self-heal room: SELF_HEAL_APPROVE_SECRET is not set; command not forwarded")
        post(token, "Self-heal approvals are not configured on the bridge (SELF_HEAL_APPROVE_SECRET).", message_id)
        return
    req =urllib.request.Request(SELF_HEAL_APPROVE_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {secret}")
    status = 0
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:
        log(f"self-heal forward run_id={run_id or "-"} decision={decision} failed: {type(e).__name__}")
    # Never log the message text or the code.
    log(f"self-heal forward run_id={run_id or "-"} decision={decision} status={status}")
    # The controller posts every outcome it handles. Tell the owner only when
    # it never got the command (unreachable, wrong secret, server error).
    if status == 0 or status == 401 or status >= 500:
        post(token, f"Self-heal controller did not accept the command (HTTP {status or 'unreachable'}); check `docker logs self-heal`.", message_id)


def heal_room_message(payload: dict) -> bool:
    """True when the signed webhook belongs to the self-heal room (never runs Hermes)."""
    if not SELF_HEAL_ROOM:
        return False
    target = payload.get("target") or {}
    if not isinstance(target, dict) or str(target.get("id") or "") != SELF_HEAL_ROOM:
        return False
    threading.Thread(target=_heal_forward, args=(payload,), daemon=True).start()
    return True


class Handler(BaseHTTPRequestHandler):
'''

REPLACEMENTS = [
    ("class Handler(BaseHTTPRequestHandler):\n", HELPER),
    (
        "        ev = extract(payload)\n",
        "        if isinstance(payload, dict) and heal_room_message(payload):\n"
        "            self.send_response(202)\n"
        "            self.end_headers()\n"
        "            self.wfile.write(b\"accepted\")\n"
        "            return\n"
        "        ev = extract(payload)\n",
    ),
]


def main(path: str) -> None:
    source = Path(path).read_text()
    for needed in ("\nimport re\n", "\nimport json\n", "\nimport urllib.request\n", "\nimport urllib.error\n"):
        if needed not in source:
            sys.exit(f"heal_forward patch: bridge.py no longer has {needed.strip()!r}")
    # The command must be intercepted after the HMAC check and JSON parse.
    anchor = source.find("        ev = extract(payload)\n")
    if anchor == -1 or source.rfind("if not verify(self.headers, raw):", 0, anchor) == -1:
        sys.exit("heal_forward patch: signature check no longer precedes extract()")
    for old, new in REPLACEMENTS:
        count = source.count(old)
        if count != 1:
            sys.exit(f"heal_forward patch: expected 1 match, found {count}: {old[:60]!r}")
        source = source.replace(old, new)
    Path(path).write_text(source)


if __name__ == "__main__":
    main(sys.argv[1])
