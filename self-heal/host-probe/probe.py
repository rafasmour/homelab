"""Read-only host snapshot service for the self-heal diagnose tools.

Serves a few fixed JSON snapshots of host memory, processes, Docker
cgroups and the AMD GPU from the host /proc and /sys mounted read-only.

Hard limits (the caller is assumed hostile):
- GET only, fixed paths, no parameters (query strings are ignored);
- `Authorization: Bearer $HOST_PROBE_TOKEN`, compared in constant time;
- only the files named in this module are opened. Per-process data comes
  from /proc/<pid>/status (selected numeric fields), comm and cgroup;
  cmdline, environ, maps, fd, mem and friends are never opened.
Missing or unreadable files are reported as null.

Standard library only.
"""

import hmac
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOST_PROC = os.environ.get("HOST_PROC", "/host/proc")
HOST_SYS = os.environ.get("HOST_SYS", "/host/sys")
LISTEN_PORT = int(os.environ.get("HOST_PROBE_PORT", "8792"))
VMSTAT_INTERVAL = 2.0
TOP_PROCESSES = 15
MAX_CGROUPS = 100
MAX_READ = 64 * 1024

# Never opened, whatever path is built. Defense in depth: no code path
# builds these names, and _read() refuses them anyway.
FORBIDDEN_NAMES = frozenset({
    "cmdline", "environ", "maps", "smaps", "smaps_rollup", "numa_maps",
    "mem", "fd", "fdinfo", "pagemap", "auxv", "stack", "syscall",
    "mountinfo", "mounts", "mountstats", "cwd", "root", "exe",
    "personality", "sched", "wchan", "task", "attr", "net",
})

PID_RE = re.compile(r"^[0-9]{1,10}$")
CONTAINER_ID_RE = re.compile(r"(?:docker-|docker/)([0-9a-f]{64})(?:\.scope)?(?:/|$)")
CARD_RE = re.compile(r"^card[0-9]{1,3}$")
HWMON_RE = re.compile(r"^hwmon[0-9]{1,3}$")
TEMP_RE = re.compile(r"^temp([0-9]{1,2})_input$")
ZRAM_RE = re.compile(r"^zram[0-9]{1,3}$")
SCOPE_RE = re.compile(r"^docker-([0-9a-f]{64})\.scope$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

MEMINFO_FIELDS = (
    "MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SwapTotal",
    "SwapFree", "SwapCached", "Dirty", "Shmem", "AnonPages", "Mlocked",
    "CommitLimit", "Committed_AS", "HugePages_Total", "HugePages_Free",
    "HugePages_Rsvd", "HugePages_Surp", "Hugepagesize",
)
STATUS_FIELDS = ("State", "VmRSS", "VmSwap", "RssAnon", "RssFile", "Threads")
ZRAM_MM_STAT = (
    "orig_data_size", "compr_data_size", "mem_used_total", "mem_limit",
    "mem_used_max", "same_pages", "pages_compacted", "huge_pages",
)


def _safe_join(base, *parts):
    """Join fixed path parts under base; refuse forbidden names and escapes."""
    for part in parts:
        if not part or "/" in part or part in (".", "..") or part in FORBIDDEN_NAMES:
            raise ValueError("refused path component")
    return os.path.join(base, *parts)


def _read(base, *parts):
    """Return the text of a fixed file, or None if missing/unreadable."""
    try:
        path = _safe_join(base, *parts)
        real = os.path.realpath(path)
        root = os.path.realpath(base)
        if not real.startswith(root + os.sep):
            return None
        if os.path.basename(real) in FORBIDDEN_NAMES:
            return None
        with open(real, "rb") as handle:
            data = handle.read(MAX_READ)
        return data.decode("utf-8", "replace")
    except (OSError, ValueError):
        return None


def _listdir(base, *parts):
    try:
        path = _safe_join(base, *parts) if parts else base
        real = os.path.realpath(path)
        root = os.path.realpath(base)
        if real != root and not real.startswith(root + os.sep):
            return []
        return sorted(os.listdir(real))
    except (OSError, ValueError):
        return []


def _int(text):
    try:
        return int(text.strip())
    except (AttributeError, ValueError):
        return None


def _limit(text):
    """cgroup limit file: bytes, or the string "max" (unlimited)."""
    if text is None:
        return None
    text = text.strip()
    if text == "max":
        return "max"
    return _int(text)


def parse_meminfo(text):
    out = dict.fromkeys(MEMINFO_FIELDS)
    for line in (text or "").splitlines():
        key, _, rest = line.partition(":")
        if key not in out:
            continue
        fields = rest.split()
        if not fields:
            continue
        value = _int(fields[0])
        if value is not None and len(fields) > 1 and fields[1] == "kB":
            value *= 1024
        out[key] = value
    return out


def parse_pressure(text):
    """PSI file -> {"some": {...}, "full": {...}} or None."""
    if text is None:
        return None
    out = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields or fields[0] not in ("some", "full"):
            continue
        entry = {}
        for item in fields[1:]:
            key, _, value = item.partition("=")
            if key in ("avg10", "avg60", "avg300"):
                try:
                    entry[key] = float(value)
                except ValueError:
                    entry[key] = None
            elif key == "total":
                entry["total_us"] = _int(value)
        out[fields[0]] = entry
    return out or None


def parse_swaps(text):
    if text is None:
        return None
    out = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 5:
            continue
        size, used = _int(fields[2]), _int(fields[3])
        out.append({
            "device": re.sub(r"[^A-Za-z0-9/._-]", "?", fields[0])[:64],
            "type": fields[1][:16],
            "size_bytes": size * 1024 if size is not None else None,
            "used_bytes": used * 1024 if used is not None else None,
            "prio": _int(fields[4]),
        })
        if len(out) >= 16:
            break
    return out


def parse_vmstat(text):
    out = {}
    for line in (text or "").splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] in ("pswpin", "pswpout", "pgmajfault"):
            out[fields[0]] = _int(fields[1])
    return out


def parse_status(text):
    out = dict.fromkeys(STATUS_FIELDS)
    for line in (text or "").splitlines():
        key, _, rest = line.partition(":")
        if key not in out:
            continue
        fields = rest.split()
        if not fields:
            continue
        if key == "State":
            out[key] = fields[0][:1]
        elif key == "Threads":
            out[key] = _int(fields[0])
        else:
            value = _int(fields[0])
            out[key] = value * 1024 if value is not None else None
    return out


def parse_container_id(text):
    for line in (text or "").splitlines():
        match = CONTAINER_ID_RE.search(line)
        if match:
            return match.group(1)
    return None


def clean_comm(text):
    if text is None:
        return None
    return "".join(ch if ch.isprintable() else "?" for ch in text.strip())[:15]


def memory():
    meminfo = parse_meminfo(_read(HOST_PROC, "meminfo"))
    before = parse_vmstat(_read(HOST_PROC, "vmstat"))
    start = time.monotonic()
    time.sleep(VMSTAT_INTERVAL)
    after = parse_vmstat(_read(HOST_PROC, "vmstat"))
    elapsed = max(time.monotonic() - start, 1e-6)
    rates = {"interval_s": round(elapsed, 2)}
    for key in ("pswpin", "pswpout", "pgmajfault"):
        if before.get(key) is None or after.get(key) is None:
            rates[key + "_per_s"] = None
        else:
            rates[key + "_per_s"] = round((after[key] - before[key]) / elapsed, 1)
    zram = []
    for name in _listdir(HOST_SYS, "block"):
        if not ZRAM_RE.match(name):
            continue
        text = _read(HOST_SYS, "block", name, "mm_stat")
        stat = None
        if text is not None:
            values = [_int(v) for v in text.split()]
            stat = dict(zip(ZRAM_MM_STAT, values))
        zram.append({
            "device": name,
            "disksize_bytes": _int(_read(HOST_SYS, "block", name, "disksize")),
            "mm_stat": stat,
        })
    return {
        "meminfo": meminfo,
        "swaps": parse_swaps(_read(HOST_PROC, "swaps")),
        "zram": zram or None,
        "pressure_memory": parse_pressure(_read(HOST_PROC, "pressure", "memory")),
        "vmstat_rates": rates,
    }


def processes():
    rows = []
    scanned = 0
    for name in _listdir(HOST_PROC):
        if not PID_RE.match(name):
            continue
        scanned += 1
        status = parse_status(_read(HOST_PROC, name, "status"))
        rss, swap = status["VmRSS"], status["VmSwap"]
        if rss is None and swap is None:
            continue  # kernel thread or gone
        rows.append(((rss or 0) + (swap or 0), name, status))
    rows.sort(key=lambda row: row[0], reverse=True)
    top = []
    for _, pid, status in rows[:TOP_PROCESSES]:
        top.append({
            "pid": int(pid),
            "comm": clean_comm(_read(HOST_PROC, pid, "comm")),
            "state": status["State"],
            "rss_bytes": status["VmRSS"],
            "swap_bytes": status["VmSwap"],
            "rss_anon_bytes": status["RssAnon"],
            "rss_file_bytes": status["RssFile"],
            "threads": status["Threads"],
            "container_id": parse_container_id(_read(HOST_PROC, pid, "cgroup")),
        })
    return {"processes_scanned": scanned, "top_by_rss_plus_swap": top}


def _cgroup_dirs():
    """(container_id, path parts) for each Docker container cgroup."""
    base = os.path.join(HOST_SYS, "fs", "cgroup")
    found = []
    for name in _listdir(base, "system.slice"):
        match = SCOPE_RE.match(name)
        if match:
            found.append((match.group(1), ("system.slice", name)))
    for name in _listdir(base, "docker"):
        if HEX64_RE.match(name):
            found.append((name, ("docker", name)))
    return base, found


def cgroups():
    base, dirs = _cgroup_dirs()
    out = []
    for cid, parts in dirs:
        events = {}
        for line in (_read(base, *parts, "memory.events") or "").splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[0] in ("oom", "oom_kill", "max", "high"):
                events[fields[0]] = _int(fields[1])
        out.append({
            "container_id": cid,
            "memory_current_bytes": _int(_read(base, *parts, "memory.current")),
            "memory_swap_current_bytes": _int(_read(base, *parts, "memory.swap.current")),
            "memory_max": _limit(_read(base, *parts, "memory.max")),
            "memory_swap_max": _limit(_read(base, *parts, "memory.swap.max")),
            "memory_events": events or None,
            "memory_pressure": parse_pressure(_read(base, *parts, "memory.pressure")),
        })
    out.sort(key=lambda row: row["memory_current_bytes"] or 0, reverse=True)
    return {"containers": out[:MAX_CGROUPS], "total": len(out)}


def _cpu_count():
    text = _read(HOST_SYS, "devices", "system", "cpu", "online")
    if text is None:
        return None
    count = 0
    try:
        for part in text.strip().split(","):
            low, _, high = part.partition("-")
            count += (int(high) - int(low) + 1) if high else 1
    except ValueError:
        return None
    return count


def overview():
    load = (_read(HOST_PROC, "loadavg") or "").split()
    uptime = (_read(HOST_PROC, "uptime") or "").split()
    running = total = None
    if len(load) >= 4 and "/" in load[3]:
        running, total = (_int(v) for v in load[3].split("/", 1))

    def _float(values, index):
        try:
            return float(values[index])
        except (IndexError, ValueError):
            return None

    kernel = _read(HOST_PROC, "sys", "kernel", "osrelease")
    return {
        "loadavg": {
            "1m": _float(load, 0), "5m": _float(load, 1), "15m": _float(load, 2),
            "running": running, "total_tasks": total,
        },
        "uptime_s": _float(uptime, 0),
        "nproc": _cpu_count(),
        "pressure": {
            kind: parse_pressure(_read(HOST_PROC, "pressure", kind))
            for kind in ("cpu", "io", "memory")
        },
        "kernel": kernel.strip()[:64] if kernel else None,
        "vm_swappiness": _int(_read(HOST_PROC, "sys", "vm", "swappiness")),
        "vm_overcommit_memory": _int(_read(HOST_PROC, "sys", "vm", "overcommit_memory")),
    }


def gpu():
    cards = []
    for card in _listdir(HOST_SYS, "class", "drm"):
        if not CARD_RE.match(card):
            continue
        dev = ("class", "drm", card, "device")
        vram_total = _int(_read(HOST_SYS, *dev, "mem_info_vram_total"))
        if vram_total is None:
            continue  # not an amdgpu device
        entry = {
            "card": card,
            "vram_total_bytes": vram_total,
            "vram_used_bytes": _int(_read(HOST_SYS, *dev, "mem_info_vram_used")),
            "gtt_total_bytes": _int(_read(HOST_SYS, *dev, "mem_info_gtt_total")),
            "gtt_used_bytes": _int(_read(HOST_SYS, *dev, "mem_info_gtt_used")),
            "gpu_busy_percent": _int(_read(HOST_SYS, *dev, "gpu_busy_percent")),
            "temps_c": None,
            "power_w": None,
            "power_cap_w": None,
            "fan_rpm": None,
        }
        for hwmon in _listdir(HOST_SYS, *dev, "hwmon"):
            if not HWMON_RE.match(hwmon):
                continue
            hw = dev + ("hwmon", hwmon)
            temps = {}
            for name in _listdir(HOST_SYS, *hw):
                match = TEMP_RE.match(name)
                if not match:
                    continue
                value = _int(_read(HOST_SYS, *hw, name))
                label = _read(HOST_SYS, *hw, "temp%s_label" % match.group(1))
                label = re.sub(r"[^A-Za-z0-9_ -]", "", (label or "").strip())[:16]
                key = label or "temp" + match.group(1)
                temps[key] = value / 1000 if value is not None else None
                if len(temps) >= 8:
                    break
            power = _int(_read(HOST_SYS, *hw, "power1_average"))
            if power is None:
                power = _int(_read(HOST_SYS, *hw, "power1_input"))
            cap = _int(_read(HOST_SYS, *hw, "power1_cap"))
            entry["temps_c"] = temps or None
            entry["power_w"] = round(power / 1e6, 1) if power is not None else None
            entry["power_cap_w"] = round(cap / 1e6, 1) if cap is not None else None
            entry["fan_rpm"] = _int(_read(HOST_SYS, *hw, "fan1_input"))
            break
        cards.append(entry)
        if len(cards) >= 4:
            break
    return {"cards": cards}


ROUTES = {
    "/overview": overview,
    "/memory": memory,
    "/processes": processes,
    "/cgroups": cgroups,
    "/gpu": gpu,
}

# /memory sleeps ~2 s; bound concurrent snapshots.
_SLOTS = threading.BoundedSemaphore(4)


class Handler(BaseHTTPRequestHandler):
    server_version = "host-probe"
    sys_version = ""
    protocol_version = "HTTP/1.0"
    timeout = 15
    token = b""

    def log_request(self, code="-", size="-"):  # path and status only
        path = urlsplit(self.path).path if isinstance(self.path, str) else "-"
        sys.stderr.write("%s %s %s\n" % (self.command, path[:64], code))

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if status == 401:
            self.send_header("WWW-Authenticate", "Bearer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _deny_method(self):
        self._send(405, {"error": "method not allowed"})

    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _deny_method

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            self._send(200, {"ok": True})
            return
        supplied = (self.headers.get("Authorization") or "").encode("utf-8", "replace")
        if not hmac.compare_digest(supplied, b"Bearer " + self.token):
            self._send(401, {"error": "unauthorized"})
            return
        handler = ROUTES.get(path)
        if handler is None:
            self._send(404, {"error": "not found"})
            return
        if not _SLOTS.acquire(blocking=False):
            self._send(503, {"error": "busy"})
            return
        try:
            payload = handler()
        except Exception:  # never leak details
            self._send(500, {"error": "snapshot failed"})
            return
        finally:
            _SLOTS.release()
        self._send(200, payload)


def make_server(token, host="0.0.0.0", port=LISTEN_PORT):
    handler = type("BoundHandler", (Handler,), {"token": token.encode()})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main():
    token = os.environ.get("HOST_PROBE_TOKEN", "")
    if len(token) < 16:
        sys.stderr.write("HOST_PROBE_TOKEN is missing or shorter than 16 characters\n")
        sys.exit(1)
    server = make_server(token)
    sys.stderr.write("host-probe listening on :%d\n" % LISTEN_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
