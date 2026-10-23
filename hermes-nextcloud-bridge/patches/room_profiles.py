"""Build-time patch: route each Talk room to its own Hermes profile.

NEXTCLOUD_TALK_PROFILE_ROOMS="<profile>=<room-token>|..." (the same map hermes-api
uses for cron delivery and talk_send) routes each room to its profile; unmapped
rooms use HERMES_PROFILE. The toolsets for a mapped profile come from that
profile's config.yaml (platform_toolsets.cli, without clarify, which a one-shot
`hermes chat -q` cannot answer), so hermes/start.sh stays their only source.

Every replacement must match exactly once, so a bridge upgrade that moves this
code fails the image build instead of shipping a bridge that ignores the map.
"""

import sys
from pathlib import Path

ROUTING = '''HERMES_PROFILE = os.environ.get("HERMES_PROFILE", "default")
TALK_ROOM_PROFILES = {
    token.strip(): profile.strip()
    for profile, sep, token in (
        entry.partition("=") for entry in os.environ.get("NEXTCLOUD_TALK_PROFILE_ROOMS", "").split("|")
    )
    if sep and token.strip() and profile.strip()
}
_ROOM = threading.local()


def room_profile(token: str) -> str:
    return TALK_ROOM_PROFILES.get(token or "", HERMES_PROFILE)


def _profile() -> str:
    return getattr(_ROOM, "profile", HERMES_PROFILE)


def _toolsets() -> str:
    profile = _profile()
    if profile == HERMES_PROFILE:
        return TOOLSETS
    try:
        import yaml

        home = Path(os.environ.get("HERMES_HOME") or Path(HERMES_HOME_DIR) / ".hermes")
        config = yaml.safe_load((home / "profiles" / profile / "config.yaml").read_text()) or {}
        names = (config.get("platform_toolsets") or {}).get("cli") or []
        names = [name for name in names if name != "clarify"]
        return ",".join(names) or TOOLSETS
    except Exception as exc:
        log(f"toolsets for profile {profile!r} unavailable, using HERMES_TOOLSETS: {exc!r}")
        return TOOLSETS
'''

REPLACEMENTS = [
    ('HERMES_PROFILE = os.environ.get("HERMES_PROFILE", "default")\n', ROUTING),
    ('f"• Hermes profile: {HERMES_PROFILE}\\n"', 'f"• Hermes profile: {_profile()}\\n"'),
    ('f"• Toolsets: {TOOLSETS}"', 'f"• Toolsets: {_toolsets()}"'),
    ("- Use the configured Hermes profile: {HERMES_PROFILE}.", "- Use the configured Hermes profile: {_profile()}."),
    ('        "--profile",\n        HERMES_PROFILE,\n', '        "--profile",\n        _profile(),\n'),
    ('        "--toolsets",\n        TOOLSETS,\n', '        "--toolsets",\n        _toolsets(),\n'),
    (
        '    namespace = os.environ.get("TALK_MEMORY_NAMESPACE", HERMES_PROFILE or "default")\n'
        '    append_turn(token, "assistant", ASSISTANT_NAME, message, 0, app_name=APP_NAME)\n',
        '    namespace = os.environ.get("TALK_MEMORY_NAMESPACE", room_profile(token) or "default")\n'
        '    append_turn(token, "assistant", ASSISTANT_NAME, message, 0, app_name=APP_NAME)\n',
    ),
    (
        "def handle(ev: dict) -> None:\n",
        'def handle(ev: dict) -> None:\n    _ROOM.profile = room_profile(ev.get("token", ""))\n',
    ),
    (
        '    namespace = os.environ.get("TALK_MEMORY_NAMESPACE", HERMES_PROFILE or "default")\n'
        "    command_reply = handle_slash_command(ev, namespace)\n",
        '    namespace = os.environ.get("TALK_MEMORY_NAMESPACE", _profile() or "default")\n'
        "    command_reply = handle_slash_command(ev, namespace)\n",
    ),
]


def main(path: str) -> None:
    source = Path(path).read_text()
    for old, new in REPLACEMENTS:
        count = source.count(old)
        if count != 1:
            sys.exit(f"room_profiles patch: expected 1 match, found {count}: {old[:60]!r}")
        source = source.replace(old, new)
    Path(path).write_text(source)


if __name__ == "__main__":
    main(sys.argv[1])
