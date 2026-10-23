"""Prometheus exporter for Docker container state.

cAdvisor and node-exporter only see running containers, so an exited, crashed,
restart-looping or unhealthy container never shows up as a problem. This reads
the Docker API (GET only) and exposes, per container:

  docker_container_running             1 when the container is running
  docker_container_state{state}        1 for its current state (running, exited, restarting, ...)
  docker_container_health_status{health}  1 for healthy, unhealthy, starting or none
  docker_container_restart_count       Docker's restart counter
  docker_container_exit_code           last exit code
  docker_container_oom_killed          1 when the last stop was an OOM kill
  docker_container_restart_policy{policy}  1 for no, always, unless-stopped, on-failure
  docker_container_started_at_seconds / docker_container_finished_at_seconds
"""

from datetime import datetime
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
import threading
import time

SOCKET = os.environ.get("DOCKER_SOCKET") or "/var/run/docker.sock"
PORT = int(os.environ.get("PORT") or "9417")
CACHE_SECONDS = float(os.environ.get("CACHE_SECONDS") or "10")


class _UnixConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(SOCKET)


def _get(path: str):
    conn = _UnixConnection("docker")
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"docker API {path}: HTTP {resp.status}")
        return json.loads(body)
    finally:
        conn.close()


def _timestamp(value: str) -> float:
    if not value or value.startswith("0001-"):
        return 0.0
    # Docker returns nanoseconds; fromisoformat accepts at most microseconds.
    head, _, frac = value.rstrip("Z").partition(".")
    return datetime.fromisoformat(f"{head}.{(frac + '000000')[:6]}+00:00").timestamp()


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def collect() -> str:
    lines = [
        "# HELP docker_container_running 1 when the container is running.",
        "# TYPE docker_container_running gauge",
    ]
    series = {name: [] for name in (
        "state", "health_status", "restart_count", "exit_code", "oom_killed",
        "restart_policy", "started_at_seconds", "finished_at_seconds",
    )}
    for summary in _get("/containers/json?all=1"):
        info = _get(f"/containers/{summary['Id']}/json")
        name = _escape(info["Name"].lstrip("/"))
        state = info["State"]
        labels = f'name="{name}"'
        lines.append(f"docker_container_running{{{labels}}} {int(bool(state.get('Running')))}")
        series["state"].append(f'docker_container_state{{{labels},state="{_escape(state.get("Status", ""))}"}} 1')
        health = (state.get("Health") or {}).get("Status") or "none"
        series["health_status"].append(f'docker_container_health_status{{{labels},health="{_escape(health)}"}} 1')
        series["restart_count"].append(f"docker_container_restart_count{{{labels}}} {info.get('RestartCount', 0)}")
        series["exit_code"].append(f"docker_container_exit_code{{{labels}}} {state.get('ExitCode', 0)}")
        series["oom_killed"].append(f"docker_container_oom_killed{{{labels}}} {int(bool(state.get('OOMKilled')))}")
        policy = ((info.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name") or "no"
        series["restart_policy"].append(f'docker_container_restart_policy{{{labels},policy="{_escape(policy)}"}} 1')
        series["started_at_seconds"].append(f"docker_container_started_at_seconds{{{labels}}} {_timestamp(state.get('StartedAt', ''))}")
        series["finished_at_seconds"].append(f"docker_container_finished_at_seconds{{{labels}}} {_timestamp(state.get('FinishedAt', ''))}")
    for metric, rows in series.items():
        lines.append(f"# TYPE docker_container_{metric} gauge")
        lines.extend(rows)
    return "\n".join(lines) + "\n"


_cache = {"at": 0.0, "body": ""}
_lock = threading.Lock()


def metrics() -> tuple[int, str]:
    with _lock:
        if time.monotonic() - _cache["at"] > CACHE_SECONDS:
            try:
                body = collect() + "docker_state_exporter_up 1\n"
            except Exception as exc:  # docker unreachable: report it instead of failing the scrape
                body = f"# docker API error: {_escape(str(exc))}\ndocker_state_exporter_up 0\n"
            _cache.update(at=time.monotonic(), body=body)
        return 200, _cache["body"]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/healthz":
            status, body = 200, "ok\n"
        elif self.path == "/metrics":
            status, body = metrics()
        else:
            status, body = 404, "not found\n"
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
