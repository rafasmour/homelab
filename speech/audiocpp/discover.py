#!/usr/bin/env python3
"""Build the audio.cpp server config from the models folder, then start it.

/config/server.json is the base: server settings plus explicit model entries
(ids, LoRA, default voices and options). Every text-to-speech and
speech-to-text model found under /models that no explicit entry already
points at is added (folders whose name starts with "_" or ".", such as
_archive and _asr-eval, are skipped):

* a *.gguf file: its family comes from `audiocpp_gguf --inspect`
  (model_spec_family); id = the file name without extension, lowercased;
* a folder with an `audiocpp.json` ({"id", "family", optional "path" relative
  to the folder and any other model keys}): for packages that are not a
  single GGUF, e.g. safetensors folders.

Only families whose model spec has category "tts" or "asr" are added, with
that category as the task. Set
"discover": false in the base config to turn discovery off. The resulting
config goes to /tmp/server.json, and the server is exec'ed with the
remaining arguments.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

BIN = Path("/opt/audiocpp")
BASE = Path(os.environ.get("AUDIOCPP_BASE_CONFIG", "/config/server.json"))
MODELS = Path(os.environ.get("AUDIOCPP_MODELS", "/models"))
OUT = Path("/tmp/server.json")


TASKS = {"tts", "asr"}


def family_task(family: str) -> str:
    """The model spec's category when it is a task we serve, else ""."""
    spec = BIN / "model_specs" / f"{family}.json"
    try:
        category = json.loads(spec.read_text()).get("category")
    except (OSError, json.JSONDecodeError):
        return ""
    return category if category in TASKS else ""


def hidden(path: Path) -> bool:
    """Inside a folder named _* or .* (archives, eval sets) below MODELS."""
    return any(part.startswith(("_", ".")) for part in path.relative_to(MODELS).parts[:-1])


def gguf_family(path: Path) -> str:
    out = subprocess.run([str(BIN / "audiocpp_gguf"), "--inspect", str(path)],
                         capture_output=True, text=True, timeout=120).stdout
    match = re.search(r"^model_spec_family=(\S+)", out, re.M)
    return match.group(1) if match else ""


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "-", name.lower()).strip("-")


def discover(known_paths: set, known_ids: set) -> list:
    found = []
    manifests = sorted(m for m in MODELS.rglob("audiocpp.json") if not hidden(m))
    manifest_dirs = [m.parent for m in manifests]
    for manifest in manifests:
        try:
            entry = json.loads(manifest.read_text())
        except json.JSONDecodeError as err:
            print(f"discover: skip {manifest}: {err}", file=sys.stderr)
            continue
        entry["path"] = str(manifest.parent / entry.get("path", "."))
        entry.setdefault("task", "tts")
        entry.setdefault("mode", "offline")
        found.append(entry)
    for gguf in sorted(MODELS.rglob("*.gguf")):
        if hidden(gguf) or any(d in gguf.parents for d in manifest_dirs):
            continue  # archived, eval data or part of a manifest package
        family = gguf_family(gguf)
        task = family_task(family) if family else ""
        if not task:
            continue
        found.append({"id": slug(gguf.stem), "family": family, "path": str(gguf),
                      "task": task, "mode": "offline"})
    added = []
    for entry in found:
        if entry["path"] in known_paths or entry.get("id") in known_ids:
            continue
        if not entry.get("id") or not entry.get("family"):
            continue
        known_ids.add(entry["id"])
        added.append(entry)
    return added


def main() -> None:
    config = json.loads(BASE.read_text())
    models = config.setdefault("models", [])
    if config.pop("discover", True):
        known_paths = {str(Path(m.get("path", ""))) for m in models}
        known_ids = {m.get("id") for m in models}
        for entry in discover(known_paths, known_ids):
            print(f"discover: {entry['id']} ({entry['family']}) {entry['path']}", file=sys.stderr)
            models.append(entry)
    OUT.write_text(json.dumps(config, indent=2))
    args = [a for a in sys.argv[1:]]
    if "--config" in args:  # keep other flags, point at the generated file
        i = args.index("--config")
        del args[i:i + 2]
    os.execv(str(BIN / "audiocpp_server"),
             [str(BIN / "audiocpp_server"), "--config", str(OUT), *args])


if __name__ == "__main__":
    main()
