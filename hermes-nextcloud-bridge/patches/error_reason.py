"""Build-time patch: say why a Talk turn failed.

When `hermes chat -q` exits non-zero, upstream only replies "I hit an internal
Hermes bridge error ... check the bridge logs". This patch appends one short
reason to that reply: the last error-looking line of the run's output (for
example "API call failed after 3 retries: HTTP 500: Failed to parse tool call
arguments as JSON ..."), cut to about 200 characters, with anything that
looks like a bearer token, key, password or other long secret redacted. The
full output still goes only to the bridge log.

Apply after room_profiles.py. Every replacement must match exactly once, so a
bridge upgrade that moves this code fails the image build.
"""

import sys
from pathlib import Path

HELPER = r'''_REASON_NOISE = (
    "Warning: Unknown toolsets:",
    "Resume this session with:",
    "Initializing agent",
    "Query:",
    "Session:",
    "Duration:",
    "Messages:",
    "Tool Calls:",
    "Provider:",
    "Model:",
    "session_id:",
    "and inspect.",
    "⚠ tirith",
)
_REASON_HINT = re.compile(
    r"error|failed|failure|exception|refused|denied|timed out|timeout|"
    r"unauthori[sz]ed|forbidden|not found|HTTP \d{3}",
    re.IGNORECASE,
)
_REASON_SECRETS = (
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer [redacted]"),
    (
        re.compile(
            r"(?i)\b([\w.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|credential|key))"
            r"(\s*[=:]\s*)([\"']?)[^\s\"',;]+"
        ),
        r"\1\2\3[redacted]",
    ),
    (re.compile(r"(?i)\b(?:sk|hf|ghp|gho|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{8,}"), "[redacted]"),
    (re.compile(r"[A-Za-z0-9+/_-]{32,}={0,2}"), "[redacted]"),
)


def _failure_reason(out: str, err: str, returncode) -> str:
    """One short, redacted line explaining a failed hermes run."""

    def candidates(text: str) -> list:
        found = []
        for line in (text or "").splitlines():
            s = line.strip().strip("│").strip()
            if not s or s.startswith(_REASON_NOISE) or "Warning:" in s or "tracemalloc" in s:
                continue
            if any(ch in s for ch in "╭╰─╮╯⠈"):
                continue
            found.append(s)
        return found

    out_lines, err_lines = candidates(out), candidates(err)
    reason = ""
    for lines in (out_lines, err_lines):
        hinted = [s for s in lines if _REASON_HINT.search(s)]
        if hinted:
            reason = hinted[-1]
            break
    if not reason and err_lines:
        reason = err_lines[-1]
    for pattern, replacement in _REASON_SECRETS:
        reason = pattern.sub(replacement, reason)
    reason = " ".join(reason.split())
    if len(reason) > 200:
        reason = reason[:199].rstrip() + "…"
    if not reason:
        reason = f"hermes exited with code {returncode}"
    return "\nReason: " + reason


def clean(out: str) -> str:
'''

REPLACEMENTS = [
    ("def clean(out: str) -> str:\n", HELPER),
    (
        '            return "I hit an internal Hermes bridge error while answering. Please check the bridge logs."\n',
        '            return (\n'
        '                "I hit an internal Hermes bridge error while answering. Please check the bridge logs."\n'
        '                + _failure_reason(out, err, proc.returncode)\n'
        '            )\n',
    ),
]


def main(path: str) -> None:
    source = Path(path).read_text()
    if "\nimport re\n" not in source:
        sys.exit("error_reason patch: bridge.py no longer imports re")
    for old, new in REPLACEMENTS:
        count = source.count(old)
        if count != 1:
            sys.exit(f"error_reason patch: expected 1 match, found {count}: {old[:60]!r}")
        source = source.replace(old, new)
    Path(path).write_text(source)


if __name__ == "__main__":
    main(sys.argv[1])
